// Firefox background script - same logic as background.js, Manifest V2 compatible

const DEFAULT_SERVER_URL = "wss://watch-together-server-acwi.onrender.com";

let ws = null;
let serverUrl = DEFAULT_SERVER_URL;
let currentRoom = null;
let userId = null;
let isHeartbeatLeader = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let connectedPorts = new Map();
let pendingJoin = false;
let cachedMembers = []; // Latest known room members for serving popup re-opens
let cachedMode = "everyone";
let cachedIsHost = false;

// The one tab the watch party is bound to. Playback traffic (sync, heartbeat,
// navigate, cc-state) is routed only to and from this tab. Without this, every
// tab running the content script joins the party and a single play/pause drives
// every video the user has open.
let partyTabId = null;

// Last playback position we know of, from either direction. If the server restarts and
// loses the room, we replay this so the rebuilt room resumes where the party actually
// was instead of snapping everyone back to zero.
let cachedPlayback = { playing: false, currentTime: 0, playbackRate: 1 };
let cachedVideoUrl = "";

let lastPlaybackPersist = 0;
function notePlayback(msg) {
  const t = parseFloat(msg.currentTime);
  if (isNaN(t) || t < 0) return;
  cachedPlayback = {
    playing: !!msg.playing,
    currentTime: t,
    playbackRate: parseFloat(msg.playbackRate) || 1,
  };
  // The background page is persistent here (not an MV3 worker), so this matters less
  // than on Chrome, but keep it for parity and to survive a full browser restart. Cap
  // the write rate: heartbeats land every 5s and we do not need to beat that.
  const now = Date.now();
  if (now - lastPlaybackPersist < 5000) return;
  lastPlaybackPersist = now;
  chrome.storage.local.set({ cachedPlayback, cachedVideoUrl });
}

// Restore state from storage (survives background page restarts).
chrome.storage.local.get(
  ["serverUrl", "currentRoom", "userId", "partyTabId", "cachedPlayback", "cachedVideoUrl"],
  (data) => {
    if (data.serverUrl) serverUrl = data.serverUrl;
    if (data.cachedPlayback) cachedPlayback = data.cachedPlayback;
    if (data.cachedVideoUrl) cachedVideoUrl = data.cachedVideoUrl;
    if (data.currentRoom) {
      currentRoom = data.currentRoom;
      userId = data.userId;
      partyTabId = typeof data.partyTabId === "number" ? data.partyTabId : null;
      connect();
    }
  }
);

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    ws = new WebSocket(serverUrl);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
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

      case "heartbeat-role":
        isHeartbeatLeader = msg.isLeader;
        sendToParty({ type: "heartbeat-role", isLeader: msg.isLeader });
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

      case "chat":
      case "cc-state":
      case "navigate":
      case "error":
        sendToParty(msg);
        break;
    }
  };

  ws.onclose = (event) => {
    ws = null;
    sendToParty({ type: "connection-status", connected: false });
    if (event.code !== 4001) scheduleReconnect();
  };

  ws.onerror = () => {};
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function sendToServer(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function postTo(key, msg) {
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
// members). Both live in the party tab, so both are party surfaces.
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

// The party binds to the tab that asked to create/join. A content script knows
// its own tab; the popup does not, so fall back to the active tab it was opened over.
function resolvePartyTab(port, cb) {
  const tabId = port.sender?.tab?.id;
  if (typeof tabId === "number") {
    cb(tabId);
    return;
  }
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    cb(typeof tabs[0]?.id === "number" ? tabs[0].id : null);
  });
}

function saveState() {
  chrome.storage.local.set({ currentRoom, userId, partyTabId });
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
        resolvePartyTab(port, (resolved) => {
          partyTabId = resolved;
          saveState();
          connect();
          waitForConnection(() => {
            sendToServer({ type: "create-room", userName: msg.userName, videoUrl: msg.videoUrl || "" });
          });
        });
        break;

      case "join-room": {
        const roomCode = msg.roomCode?.toUpperCase();
        if (!roomCode) break;
        pendingJoin = true;
        resolvePartyTab(port, (resolved) => {
          partyTabId = resolved;
          saveState();
          connect();
          waitForConnection(() => {
            sendToServer({ type: "join-room", roomCode, userName: msg.userName || "User" });
            pendingJoin = false;
          });
        });
        break;
      }

      case "leave-room":
        sendToServer({ type: "leave-room" });
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

      case "navigate":
        // The party moved to a new video. That URL, not the one we started on, is what a
        // rebuilt room should point at.
        if (msg.url) cachedVideoUrl = msg.url;
        sendToServer(msg);
        break;

      case "chat":
      case "chat-typing":
      case "cc-state":
      case "voice-state":
      case "voice-signal":
        sendToServer(msg);
        break;

      case "set-mode":
        sendToServer(msg);
        break;

      case "set-server-url":
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
        resolvePartyTab(port, (resolved) => {
          if (resolved === null) return;
          partyTabId = resolved;
          saveState();
          postTo(`${partyTabId}:content`, {
            type: "room-joined",
            roomCode: currentRoom,
            userId,
            mode: cachedMode,
            isHost: cachedIsHost,
            members: cachedMembers,
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
    connectedPorts.delete(portKey);
  });
});

function waitForConnection(callback, retries = 60) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    callback();
  } else if (retries > 0) {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connect();
    }
    setTimeout(() => waitForConnection(callback, retries - 1), 1000);
  } else {
    pendingJoin = false;
    sendToParty({ type: "error", message: "Could not connect to server. Try again." });
  }
}
