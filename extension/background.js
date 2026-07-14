// Background service worker - manages WebSocket connection and relays messages

// PRODUCTION: Change this to your deployed server URL (wss:// for secure)
// e.g. "wss://watch-together-server.onrender.com"
const DEFAULT_SERVER_URL = "wss://watch-together-server-acwi.onrender.com";

let ws = null;
let serverUrl = DEFAULT_SERVER_URL;
let currentRoom = null;
let userId = null;
let isHeartbeatLeader = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let connectedPorts = new Map(); // "tabId:portName" -> port
let pendingJoin = false;
let cachedMembers = []; // Latest known room members for serving popup re-opens
let cachedMode = "everyone";
let cachedIsHost = false;

// The one tab the watch party is bound to. Playback traffic (sync, heartbeat,
// navigate, cc-state) is routed ONLY to and from this tab. Without this, every
// tab running the content script joins the party and a single play/pause drives
// every video the user has open.
let partyTabId = null;

// Last playback position we know of, from either direction. If the server restarts and
// loses the room, we replay this so the rebuilt room resumes where the party actually
// was instead of snapping everyone back to zero.
let cachedPlayback = { playing: false, currentTime: 0, playbackRate: 1 };
let cachedVideoUrl = "";

// While this is in the future, the party tab is mid-redirect to someone else's video and
// must not announce a move of its own. It outlives the page load, and the MV3 worker, on
// purpose: the whole point is to still be true once the new content script wakes up.
let navSuppressUntil = 0;

let lastPlaybackPersist = 0;
function notePlayback(msg) {
  const t = parseFloat(msg.currentTime);
  if (isNaN(t) || t < 0) return;
  cachedPlayback = {
    playing: !!msg.playing,
    currentTime: t,
    playbackRate: parseFloat(msg.playbackRate) || 1,
  };
  // The MV3 worker can be killed at any moment, so this has to survive in storage. Cap
  // the write rate: heartbeats land every 5s and we do not need to beat that.
  const now = Date.now();
  if (now - lastPlaybackPersist < 5000) return;
  lastPlaybackPersist = now;
  chrome.storage.local.set({ cachedPlayback, cachedVideoUrl });
}

// Restore state from storage (survives MV3 service worker restarts)
chrome.storage.local.get(
  ["serverUrl", "currentRoom", "userId", "partyTabId", "cachedPlayback", "cachedVideoUrl", "navSuppressUntil"],
  (data) => {
    if (data.serverUrl) serverUrl = data.serverUrl;
    if (data.cachedPlayback) cachedPlayback = data.cachedPlayback;
    if (data.cachedVideoUrl) cachedVideoUrl = data.cachedVideoUrl;
    if (typeof data.navSuppressUntil === "number") navSuppressUntil = data.navSuppressUntil;
    if (data.currentRoom) {
      currentRoom = data.currentRoom;
      userId = data.userId;
      partyTabId = typeof data.partyTabId === "number" ? data.partyTabId : null;
      connect(); // Reconnect and rejoin
    }
  }
);

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    ws = new WebSocket(serverUrl);
  } catch (err) {
    console.error("[WatchTogether] Failed to create WebSocket:", err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[WatchTogether] Connected to server");
    reconnectAttempts = 0;
    sendToParty({ type: "connection-status", connected: true });

    // Auto-rejoin room after reconnect. recreateIfMissing covers the case where the
    // server restarted and dropped the room: we rebuild it from where we last were,
    // rather than stranding a live watch party on "Room not found".
    if (currentRoom) {
      chrome.storage.local.get(["userName"], (data) => {
        sendToServer({
          type: "join-room",
          roomCode: currentRoom,
          userName: data.userName || "User",
          recreateIfMissing: true,
          resumeState: cachedPlayback,
          videoUrl: cachedVideoUrl,
          // Carry the control mode across a rebuild. Without it a "host only" room comes
          // back as a free-for-all and everyone can suddenly scrub the video.
          mode: cachedMode,
        });
      });
    }
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "room-created":
        currentRoom = msg.roomCode;
        userId = msg.userId;
        cachedMembers = [{ id: msg.userId, userName: "" }];
        cachedMode = msg.mode || "everyone";
        cachedIsHost = true;
        saveState();
        sendToParty(msg);
        break;

      case "room-joined":
        currentRoom = msg.roomCode;
        userId = msg.userId;
        cachedMembers = Array.isArray(msg.members) ? msg.members.slice() : [];
        cachedMode = msg.mode || "everyone";
        cachedIsHost = !!msg.isHost;
        if (msg.videoUrl) cachedVideoUrl = msg.videoUrl;
        if (msg.playbackState) notePlayback(msg.playbackState);
        saveState();
        sendToParty(msg);
        break;

      case "member-joined":
        if (!cachedMembers.some((m) => m.id === msg.userId)) {
          cachedMembers.push({ id: msg.userId, userName: msg.userName });
        }
        sendToParty(msg);
        break;

      case "member-left":
        cachedMembers = cachedMembers.filter((m) => m.id !== msg.userId);
        sendToParty(msg);
        break;

      case "mode-changed":
        cachedMode = msg.mode;
        sendToParty(msg);
        break;

      case "host-transferred":
        cachedIsHost = !!msg.isHost;
        sendToParty(msg);
        break;

      case "heartbeat-role":
        isHeartbeatLeader = msg.isLeader;
        sendToParty({
          type: "heartbeat-role",
          isLeader: msg.isLeader,
        });
        break;

      case "sync":
      case "heartbeat":
        // Drive the party tab only. A resync reply is addressed to us and carries
        // no fromUserId, so it must not be filtered out by the self-echo guard.
        if (msg.fromUserId !== userId) {
          notePlayback(msg);
          sendToParty(msg);
        }
        break;

      case "navigate":
        // We are about to redirect the party tab to someone else's video. That tears down
        // the content script, and the one that loads in its place will notice it is not
        // where the room was and try to announce a move of its own. Muzzle it: this is us
        // following, not us leading. Without this the room ping-pongs between two videos.
        if (msg.url) cachedVideoUrl = msg.url;
        navSuppressUntil = Date.now() + 30000;
        saveState();
        sendToParty(msg);
        break;

      case "chat":
      case "chat-typing":
      case "cc-state":
      case "voice-state":
      case "voice-signal":
      case "error":
        sendToParty(msg);
        break;
    }
  };

  ws.onclose = (event) => {
    console.log(`[WatchTogether] Disconnected (code: ${event.code})`);
    ws = null;
    sendToParty({ type: "connection-status", connected: false });
    // Don't reconnect if server explicitly closed us (room expired, etc.)
    if (event.code !== 4001) {
      scheduleReconnect();
    }
  };

  ws.onerror = () => {
    // onclose will fire after this
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  console.log(`[WatchTogether] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function sendToServer(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function postTo(key, msg) {
  // "popup" is a role, not one fixed port. A toolbar popup registers under the bare name,
  // but the same page opened as a tab (or a second surface later) registers under
  // "<tabId>:popup". Reach every popup surface rather than only the bare one, or the
  // reattach bar and error toasts land nowhere.
  if (key === "popup") {
    for (const [k, p] of connectedPorts) {
      if (k !== "popup" && !k.endsWith(":popup")) continue;
      try {
        p.postMessage(msg);
      } catch {
        connectedPorts.delete(k);
      }
    }
    return;
  }
  const p = connectedPorts.get(key);
  if (!p) return;
  try {
    p.postMessage(msg);
  } catch {
    connectedPorts.delete(key);
  }
}

// Room traffic goes to the party tab and the popup, never to bystander tabs.
// The party tab runs two ports: the content script (playback) and the overlay (chat,
// members, voice). Both live in the party tab, so both are party surfaces.
function sendToParty(msg) {
  if (partyTabId !== null) {
    postTo(`${partyTabId}:content`, msg);
    postTo(`${partyTabId}:overlay`, msg);
  }
  postTo("popup", msg);
}

// True only for the content script running in the tab the party is bound to.
function isPartyTabPort(port) {
  const tabId = port.sender?.tab?.id;
  return typeof tabId === "number" && tabId === partyTabId;
}

// The party binds to a tab that can actually run the sync.
//   - A content script speaks for its own tab, full stop.
//   - The popup has no tab of its own, but it knows which tab it is anchored over and
//     says so in msg.tabId. Trust that over re-querying: by the time this runs the user
//     may already be looking at something else, and an extension page opened as a tab
//     (which is what a test harness or a detached surface is) would otherwise nominate
//     ITSELF as the party tab and strand the room in a page with no video.
//   - Only if nobody said anything do we fall back to the active tab.
// A chrome:// page, the Web Store or a PDF viewer has no content script, and binding the
// party there would leave it mute forever with the popup still cheerfully claiming
// everything is fine. Bind nothing instead: the popup then offers to reattach.
function resolvePartyTab(port, msg, cb) {
  if (port.name === "content") {
    const own = port.sender?.tab?.id;
    if (typeof own === "number") {
      cb(own);
      return;
    }
  }

  const claimed = msg && msg.tabId;
  if (typeof claimed === "number" && connectedPorts.has(`${claimed}:content`)) {
    cb(claimed);
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs[0]?.id;
    if (typeof id !== "number" || !connectedPorts.has(`${id}:content`)) {
      cb(null);
      return;
    }
    cb(id);
  });
}

function saveState() {
  chrome.storage.local.set({ currentRoom, userId, partyTabId, navSuppressUntil });
}

function clearRoomState() {
  currentRoom = null;
  userId = null;
  partyTabId = null;
  isHeartbeatLeader = false;
  cachedMembers = [];
  cachedMode = "everyone";
  cachedIsHost = false;
  saveState();
}

// A tab id from a previous browser session is meaningless. Drop it rather than
// letting it silently match a brand new, unrelated tab.
chrome.runtime.onStartup.addListener(() => {
  if (partyTabId === null) return;
  chrome.tabs.get(partyTabId, () => {
    if (chrome.runtime.lastError) {
      partyTabId = null;
      saveState();
    }
  });
});

// Closing the party tab must not end the session: keep the room and unbind, so
// the next tab that joins (or the popup) can re-adopt it.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== partyTabId) return;
  partyTabId = null;
  saveState();
  postTo("popup", { type: "party-tab-closed", roomCode: currentRoom });
});

// Handle connections from content scripts and popup
chrome.runtime.onConnect.addListener((port) => {
  const tabId = port.sender?.tab?.id;
  const portKey = typeof tabId === "number" ? `${tabId}:${port.name}` : port.name;
  connectedPorts.set(portKey, port);

  // A reloaded or re-navigated party tab comes back with a fresh content script that
  // has no idea it is in a room. Hand it its membership back immediately, and pull the
  // live playback state so it lands in sync instead of drifting until the next heartbeat.
  if (port.name === "content" && currentRoom && tabId === partyTabId) {
    port.postMessage({
      type: "room-joined",
      roomCode: currentRoom,
      userId,
      mode: cachedMode,
      isHost: cachedIsHost,
      members: cachedMembers,
      videoUrl: cachedVideoUrl,
      resumed: true,
    });
    connect();
    waitForConnection(() => sendToServer({ type: "request-state" }));
  }

  port.onMessage.addListener((msg) => {
    // Playback traffic is only trusted from the tab the party is bound to. Otherwise
    // any other video the user has open can drive everyone else's playback.
    const PLAYBACK_TYPES = ["sync", "heartbeat", "navigate", "cc-state"];
    if (PLAYBACK_TYPES.includes(msg.type) && !isPartyTabPort(port)) return;

    switch (msg.type) {
      case "connect":
        connect();
        break;

      case "create-room":
        cachedVideoUrl = msg.videoUrl || "";
        resolvePartyTab(port, msg, (resolved) => {
          partyTabId = resolved;
          saveState();
          connect();
          waitForConnection(() => {
            sendToServer({
              type: "create-room",
              userName: msg.userName,
              videoUrl: msg.videoUrl || "",
              mode: msg.mode || "everyone",
              customName: msg.customName || "",
            });
          });
        });
        break;

      case "join-room": {
        const roomCode = msg.roomCode?.toUpperCase();
        if (!roomCode) break;

        // A content script asking to join while the party is already bound to another tab
        // is never what the user meant: it is a leftover auto-join hint firing in some
        // unrelated tab. Deliberate joins come from the popup, and the party tab may
        // always rejoin itself. Everything else would silently drag the party off the
        // video and onto whatever tab spoke last.
        if (port.name === "content" && currentRoom && partyTabId !== null && !isPartyTabPort(port)) {
          break;
        }

        pendingJoin = true;
        resolvePartyTab(port, msg, (resolved) => {
          partyTabId = resolved;
          saveState();
          connect();
          waitForConnection(() => {
            sendToServer({
              type: "join-room",
              roomCode,
              userName: msg.userName || "User",
            });
            pendingJoin = false;
          });
        });
        break;
      }

      case "leave-room":
        sendToServer({ type: "leave-room" });
        // Tell the party tab before we forget which tab that was, or its overlay sits
        // there claiming to be in a room nobody is in.
        sendToParty({ type: "room-ended", reason: "left" });
        clearRoomState();
        break;

      case "sync":
        notePlayback(msg);
        sendToServer(msg);
        break;

      case "heartbeat":
        notePlayback(msg);
        // Only send heartbeats if we are the designated leader
        if (isHeartbeatLeader) {
          sendToServer(msg);
        }
        break;

      // Pull the room's authoritative playback state. Backs both session resume
      // and the manual resync control.
      case "request-state":
        connect();
        waitForConnection(() => sendToServer({ type: "request-state" }));
        break;

      case "chat":
        sendToServer(msg);
        break;

      case "navigate":
        // onResume means the party tab woke up somewhere other than where the room is and
        // wants to move the room to match. That is right when the user switched app, and
        // wrong when we are the ones being redirected into someone else's video, which
        // looks identical from inside the page. Only the background knows which it is.
        if (msg.onResume && Date.now() < navSuppressUntil) break;

        // The party moved to a new video. That URL, not the one we started on, is what a
        // rebuilt room should point at.
        if (msg.url) cachedVideoUrl = msg.url;
        sendToServer(msg);
        break;

      case "voice-state":
      case "voice-signal":
      case "chat-typing":
      case "cc-state":
        sendToServer(msg);
        break;

      case "set-mode":
        sendToServer(msg);
        break;

      case "set-server-url":
        // Only allow from popup (not content scripts)
        if (port.name !== "popup") break;
        serverUrl = msg.url;
        chrome.storage.local.set({ serverUrl: msg.url });
        if (ws) ws.close();
        connect();
        break;

      // The party tab was closed but the room is still alive. Bind the party to the
      // tab the user is on now and pull the current playback state into it.
      case "adopt-tab":
        if (!currentRoom) break;
        resolvePartyTab(port, msg, (resolved) => {
          if (resolved === null) {
            // The tab in front of the user cannot run the sync (chrome://, the Web Store,
            // a PDF). Say so rather than pretending we attached.
            postTo("popup", { type: "error", message: "Open the video tab first, then attach." });
            return;
          }
          // The old party tab may still be open (the user switched app in a new tab
          // rather than closing the old one). Retire it explicitly: two tabs both
          // believing they are the party is how a room ends up fighting itself.
          if (partyTabId !== null && partyTabId !== resolved) {
            postTo(`${partyTabId}:content`, { type: "room-ended", reason: "moved" });
          }
          partyTabId = resolved;
          // Attaching is an explicit "the party is here now". Drop any follow-the-leader
          // muzzle left over from a redirect, so this tab is allowed to move the room.
          navSuppressUntil = 0;
          saveState();
          postTo("popup", { type: "party-tab-adopted", roomCode: currentRoom });
          postTo(`${partyTabId}:content`, {
            type: "room-joined",
            roomCode: currentRoom,
            userId,
            mode: cachedMode,
            isHost: cachedIsHost,
            members: cachedMembers,
            videoUrl: cachedVideoUrl,
            resumed: true,
          });
          connect();
          waitForConnection(() => sendToServer({ type: "request-state" }));
        });
        break;

      case "get-state":
        port.postMessage({
          type: "state",
          currentRoom,
          userId,
          connected: ws && ws.readyState === WebSocket.OPEN,
          isHeartbeatLeader,
          serverUrl,
          members: cachedMembers,
          mode: cachedMode,
          isHost: cachedIsHost,
          partyTabId,
          hasPartyTab: partyTabId !== null,
        });
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    // Delete by identity, not by key. A fast reload can register the new port under the
    // same key before the old one's disconnect fires, and a blind delete would evict the
    // live port, silently cutting the party tab off.
    if (connectedPorts.get(portKey) === port) connectedPorts.delete(portKey);
  });
});

function waitForConnection(callback, retries = 60) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    callback();
  } else if (retries > 0) {
    // Keep trying to connect if WebSocket is dead
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connect();
    }
    setTimeout(() => waitForConnection(callback, retries - 1), 1000);
  } else {
    pendingJoin = false;
    sendToParty({ type: "error", message: "Could not connect to server. Try again." });
  }
}
