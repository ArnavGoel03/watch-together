// Popup - Room management, chat, and server config

/**
 * Element lookup. Typed loosely on purpose: this returns inputs, buttons, spans and
 * containers alike, and pinning it to Element would mean casting at every single call
 * site for `.value` and `.checked`, which is noise rather than safety.
 * @param {string} sel
 * @returns {any}
 */
const $ = (sel) => document.querySelector(sel);
let port = null;
const inFlight = new Set();

function connectPort() {
  port = chrome.runtime.connect({ name: "popup" });
  port.onMessage.addListener(handlePortMessage);
  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) { /* noop: SW recycled */ }
    port = null;
  });
}

function safePost(msg) {
  try {
    if (!port) connectPort();
    port.postMessage(msg);
    return true;
  } catch {
    try {
      connectPort();
      port.postMessage(msg);
      return true;
    } catch {
      showToast("Connection lost - try again");
      return false;
    }
  }
}

// Robust clipboard write - async clipboard with execCommand fallback.
// Must be called synchronously from a user-gesture handler.
async function safeCopy(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function withInFlight(key, btn, fn) {
  if (inFlight.has(key)) return;
  inFlight.add(key);
  if (btn) btn.disabled = true;
  Promise.resolve(fn()).finally(() => {
    inFlight.delete(key);
    if (btn) btn.disabled = false;
  });
}

connectPort();

let currentRoom = null;
let members = [];
let activeTabUrl = "";
let activeTabId = null;
let partyTabId = null;
let selectedMode = "everyone";
let isHost = false;
let currentMode = "everyone";

// Internal/useless URL patterns
const BLOCKED_PREFIXES = ["chrome", "about:", "edge:", "moz-extension:", "chrome-extension:", "file:", "brave:"];

function isVideoTab(url) {
  if (!url) return false;
  return !BLOCKED_PREFIXES.some((p) => url.startsWith(p));
}

// Elements
const viewLanding = $("#view-landing");
const viewRoom = $("#view-room");
const statusEl = $("#status");
const statusText = $("#statusText");
const userNameInput = $("#userName");
const roomCodeInput = $("#roomCode");
const serverUrlInput = $("#serverUrl");
const displayRoomCode = $("#displayRoomCode");
const memberCountEl = $("#memberCount");
const membersListEl = $("#membersList");
const leaderBadge = $("#leaderBadge");
const reattachBar = $("#reattachBar");
const reattachBarText = $("#reattachBarText");
const btnReattach = $("#btnReattach");
const chatMessages = $("#chatMessages");
const chatInput = $("#chatInput");
const toastEl = $("#toast");
const btnCreate = $("#btnCreate");

// Backend presets - Render is the original Node server, Cloudflare is the new Worker.
// Per-backend URL is remembered so flipping the radio swaps the URL field instantly.
const BACKEND_DEFAULTS = {
  // Both are real, deployed and interchangeable; the list in config.js decides which one a
  // fresh install reaches for first.
  cloudflare: window.__wtConfig.SERVER_URLS[0],
  render: window.__wtConfig.SERVER_URLS[1] || window.__wtConfig.SERVER_URL,
};
const backendUrls = { ...BACKEND_DEFAULTS };
let activeBackend = "render";

// Load saved state & trigger connection
chrome.storage.local.get(
  ["userName", "serverUrl", "overlayMode", "overlayHotkey", "backend", "renderUrl", "cloudflareUrl", "voiceQuality"],
  /** @param {any} data */
  (data) => {
    if (data.userName) userNameInput.value = data.userName;
    backendUrls.render = data.renderUrl || BACKEND_DEFAULTS.render;
    backendUrls.cloudflare = data.cloudflareUrl || "";
    activeBackend = data.backend === "render" ? "render" : "cloudflare";
    if (data.serverUrl) {
      serverUrlInput.value = data.serverUrl;
      backendUrls[activeBackend] = data.serverUrl;
    } else {
      serverUrlInput.value = backendUrls[activeBackend];
    }
    applyBackendRadios(activeBackend);
    applyOverlaySettings(data.overlayMode || "click", data.overlayHotkey || "\\");
    applyVoiceQuality(data.voiceQuality === "voice" ? "voice" : "media");
    safePost({ type: "connect" });
    safePost({ type: "get-state" });
  }
);

// Radio grids became settings rows: a label on the left and one control on the right. The
// storage keys are unchanged throughout, so nothing anybody already chose is lost.

function applyVoiceQuality(q) {
  const sel = $("#voiceQualitySelect");
  if (sel) sel.value = q;
}

// A control for a feature that cannot run is worse than no control: it invites somebody to
// change something and then does nothing. Hide it outright while voice ships disabled.
{
  const voiceSection = $("#voiceQualitySection");
  if (voiceSection) voiceSection.hidden = !window.__wtConfig.VOICE_ENABLED;

  const sel = $("#voiceQualitySelect");
  if (sel) {
    sel.addEventListener("change", () => {
      const q = sel.value === "voice" ? "voice" : "media";
      chrome.storage.local.set({ voiceQuality: q });
      showToast(q === "voice" ? "High voice quality, may duck the film" : "Media friendly voice");
    });
  }
}

function applyBackendRadios(backend) {
  const sel = $("#backendSelect");
  if (sel) sel.value = backend;
}

// Switching the server repopulates the address with that backend's saved value; Save is
// what actually applies it, so nobody disconnects a live room by brushing a control.
{
  const sel = $("#backendSelect");
  if (sel) {
    sel.addEventListener("change", () => {
      activeBackend = sel.value === "render" ? "render" : "cloudflare";
      serverUrlInput.value = backendUrls[activeBackend] || "";
      if (!backendUrls[activeBackend]) {
        showToast("Paste that server's address, then Save");
        serverUrlInput.focus();
      }
    });
  }
}

/* Appearance.
 *
 * The attribute goes on the document root rather than on a wrapper, because the popup's
 * own background is painted on body and a wrapper would leave the surround in the other
 * look. Applied before anything is measured, so there is no flash of the wrong one. */
function applyUiStyle(value) {
  const config = self.__wtConfig;
  const style = config.normalizeUiStyle(value);
  document.documentElement.setAttribute("data-ui", style);
  const sel = $("#uiStyleSelect");
  if (sel) sel.value = style;
  return style;
}

{
  const config = self.__wtConfig;
  const sel = $("#uiStyleSelect");
  if (sel && !sel.options.length) {
    for (const style of config.UI_STYLES) {
      const opt = document.createElement("option");
      opt.value = style.value;
      opt.textContent = style.label;
      opt.title = style.hint;
      sel.appendChild(opt);
    }
  }

  chrome.storage.local.get(config.UI_STYLE_STORAGE_KEY, (stored) => {
    applyUiStyle(stored?.[config.UI_STYLE_STORAGE_KEY]);
  });

  sel?.addEventListener("change", () => {
    const style = applyUiStyle(sel.value);
    // The overlay reads the same key and repaints itself, so the panel on the page and
    // this popup never disagree about which look is in force.
    chrome.storage.local.set({ [config.UI_STYLE_STORAGE_KEY]: style });
  });
}

function applyOverlaySettings(mode, hotkey) {
  const sel = $("#overlayModeSelect");
  if (sel) sel.value = mode;
  const hotkeyInput = $("#overlayHotkey");
  const hotkeyRow = $("#hotkeyRow");
  if (hotkeyInput) hotkeyInput.value = hotkey;
  // The hotkey row only means anything in hold mode, so it appears with it rather than
  // sitting there greyed out.
  if (hotkeyRow) hotkeyRow.hidden = mode !== "hold";
}

{
  const sel = $("#overlayModeSelect");
  if (sel) {
    sel.addEventListener("change", () => {
      const mode = sel.value === "hold" ? "hold" : "click";
      chrome.storage.local.set({ overlayMode: mode });
      const row = $("#hotkeyRow");
      if (row) row.hidden = mode !== "hold";
    });
  }
}

// Hotkey input - captures one keypress, persists immediately
{
  const hk = $("#overlayHotkey");
  if (hk) {
    hk.addEventListener("keydown", (e) => {
      // Modifier-only and special keys don't make sense as a single-key hotkey
      if (["Shift", "Control", "Alt", "Meta", "Tab", "Escape", "Enter"].includes(e.key)) return;
      if (!e.key || e.key.length !== 1) return;
      e.preventDefault();
      hk.value = e.key;
      chrome.storage.local.set({ overlayHotkey: e.key });
    });
    hk.addEventListener("blur", () => {
      if (!hk.value) {
        hk.value = "\\";
        chrome.storage.local.set({ overlayHotkey: "\\" });
      }
    });
  }
}

// Keep polling state until we're in a room or give up after 30s
let statePollCount = 0;
const statePoll = setInterval(() => {
  statePollCount++;
  safePost({ type: "get-state" });
  if (currentRoom || statePollCount > 15) clearInterval(statePoll);
}, 2000);

// Check if current tab is suitable for creating a room
function refreshActiveTabUrl() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    activeTabUrl = tabs[0]?.url || "";
    activeTabId = typeof tabs[0]?.id === "number" ? tabs[0].id : null;
    refreshSitePermission();
    updateReattachBar();
    // The user can switch tabs under an open popup, so keep asking where the party is.
    if (currentRoom) safePost({ type: "get-state" });
  });
}
refreshActiveTabUrl();
// Keep activeTabUrl fresh while popup is open (user may navigate the underlying tab)
const tabRefreshInterval = setInterval(refreshActiveTabUrl, 1500);
window.addEventListener("unload", () => clearInterval(tabRefreshInterval));

// The extension only asks for a handful of video sites up front. Anywhere else, the viewer
// grants access themselves, at the moment they actually want it, which is the difference
// between an extension that reads every page you visit and one that reads the page you
// asked it to.
let siteNeedsPermission = false;

function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

function refreshSitePermission() {
  const origin = originOf(activeTabUrl);
  const row = $("#site-permission");
  if (!row) return;
  if (!origin) {
    siteNeedsPermission = false;
    row.style.display = "none";
    updateCreateButton();
    return;
  }
  chrome.permissions.contains({ origins: [origin] }, (granted) => {
    siteNeedsPermission = !granted;
    row.style.display = granted ? "none" : "block";
    const label = $("#site-permission-host");
    if (label) {
      try { label.textContent = new URL(activeTabUrl).hostname; } catch { label.textContent = "this site"; }
    }
    updateCreateButton();
  });
}

function requestSitePermission() {
  const origin = originOf(activeTabUrl);
  if (!origin) return;
  // Must be called straight from the click: Chrome only shows this dialog for a real
  // user gesture, and an await before it silently turns the request into a no-op.
  chrome.permissions.request({ origins: [origin] }, (granted) => {
    if (!granted) {
      showToast("Not enabled here");
      return;
    }
    // Make it work in the tab they are already looking at, rather than asking them to
    // reload a page they never expected to have to reload.
    safePost({ type: "site-granted", tabId: activeTabId });
    showToast("Enabled on this site");
    refreshSitePermission();
  });
}

function updateCreateButton() {
  const hint = $("#tab-hint");
  // A site we cannot touch yet is not a site we can start a party on.
  if (isVideoTab(activeTabUrl) && !siteNeedsPermission) {
    btnCreate.disabled = false;
    btnCreate.style.opacity = "1";
    if (hint) hint.style.display = "none";
  } else {
    btnCreate.disabled = true;
    btnCreate.style.opacity = "0.35";
    if (hint) hint.style.display = siteNeedsPermission ? "none" : "block";
  }
}

// --- Event Listeners ---

btnCreate.addEventListener("click", () => {
  if (!isVideoTab(activeTabUrl)) {
    showToast("Open a video first");
    return;
  }
  const name = getUserName();
  if (!name) {
    showToast("Enter your name first");
    userNameInput.focus();
    shakeElement(userNameInput.parentElement);
    return;
  }
  const customNameEl = $("#customName");
  const customName = customNameEl ? customNameEl.value.trim() : "";
  if (customName && !/^[a-zA-Z0-9-]{4,32}$/.test(customName)) {
    showToast("Room name must be 4-32 letters, numbers, or hyphens");
    customNameEl.focus();
    shakeElement(customNameEl.parentElement);
    return;
  }
  withInFlight("create", btnCreate, () => {
    chrome.storage.local.set({ userName: name });
    // tabId, not just the URL: the background must bind the party to the exact tab this
    // popup is anchored over, not to whatever happens to be active by the time it looks.
    safePost({ type: "create-room", userName: name, videoUrl: activeTabUrl, mode: selectedMode, customName, tabId: activeTabId });
    return new Promise((resolve) => setTimeout(resolve, 4000));
  });
});

// Mode selection buttons
document.querySelectorAll(".mode-btn").forEach(/** @param {any} btn */ (btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("mode-active"));
    btn.classList.add("mode-active");
    selectedMode = btn.dataset.mode;
  });
});

// Toggle mode in active room (host only)
$("#btnToggleMode").addEventListener("click", () => {
  const btn = $("#btnToggleMode");
  withInFlight("toggle-mode", btn, () => {
    const newMode = currentMode === "everyone" ? "host" : "everyone";
    safePost({ type: "set-mode", mode: newMode });
    return new Promise((resolve) => setTimeout(resolve, 800));
  });
});

$("#btnJoin").addEventListener("click", joinRoom);

function joinRoom() {
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!code || code.length < 4) {
    showToast("Enter a valid room code");
    roomCodeInput.focus();
    shakeElement(roomCodeInput.parentElement);
    return;
  }
  const name = getUserName();
  if (!name) {
    showToast("Enter your name first");
    userNameInput.focus();
    shakeElement(userNameInput.parentElement);
    return;
  }
  withInFlight("join", $("#btnJoin"), () => {
    chrome.storage.local.set({ userName: name });
    safePost({ type: "join-room", roomCode: code, userName: name, tabId: activeTabId });
    return new Promise((resolve) => setTimeout(resolve, 4000));
  });
}

$("#btnLeave").addEventListener("click", () => {
  withInFlight("leave", $("#btnLeave"), () => {
    safePost({ type: "leave-room" });
    currentRoom = null;
    members = [];
    showView("landing");
    chatMessages.innerHTML = "";
    membersListEl.innerHTML = "";
    return new Promise((resolve) => setTimeout(resolve, 500));
  });
});

btnReattach.addEventListener("click", () => {
  safePost({ type: "adopt-tab", tabId: activeTabId });
});

$("#btnCopyCode").addEventListener("click", async () => {
  const btn = $("#btnCopyCode");
  if (!currentRoom) { showToast("No room code yet"); return; }
  const ok = await safeCopy(currentRoom);
  if (ok) {
    showToast("Room code copied");
    flashButton(btn);
  } else {
    showToast("Couldn't copy - long-press the code to select");
  }
});

// Build the share link synchronously from cached state - no async hops
// before the clipboard write, otherwise Chrome rejects the user-gesture.
function buildShareLink() {
  if (!currentRoom) return "";
  const tabUrl = activeTabUrl || "";
  if (isVideoTab(tabUrl)) {
    try {
      const url = new URL(tabUrl);
      url.searchParams.set("wt_room", currentRoom);
      return url.toString();
    } catch {
      return `${tabUrl}${tabUrl.includes("?") ? "&" : "?"}wt_room=${currentRoom}`;
    }
  }
  return `${window.__wtConfig.HTTP_ORIGIN}/join/${currentRoom}`;
}

$("#btnCopyLink").addEventListener("click", async () => {
  const btn = $("#btnCopyLink");
  if (!currentRoom) { showToast("No room yet"); return; }
  const link = buildShareLink();
  if (!link) { showToast("Couldn't build share link"); return; }
  const ok = await safeCopy(link);
  if (ok) {
    showToast("Share link copied");
    flashButton(btn);
  } else {
    showToast("Couldn't copy - try Copy Code instead");
  }
});

$("#btnEnableSite").addEventListener("click", requestSitePermission);

$("#btnSaveServer").addEventListener("click", () => {
  const url = serverUrlInput.value.trim();
  if (!url) {
    showToast("Enter a server URL");
    return;
  }
  // One shared rule, in config.js: wss everywhere, with a loopback exception so local
  // development and the test harness can point at a server on this machine.
  if (!window.__wtConfig.isValidServerUrl(url)) {
    showToast("Server URL must start with wss://");
    return;
  }
  // Persist per-backend slot + the active backend choice
  backendUrls[activeBackend] = url;
  const storageKey = activeBackend === "cloudflare" ? "cloudflareUrl" : "renderUrl";
  chrome.storage.local.set({
    backend: activeBackend,
    [storageKey]: url,
  });
  safePost({ type: "set-server-url", url });
  showToast(`Saved - using ${activeBackend === "cloudflare" ? "Cloudflare" : "Render"}`);
});

$("#btnSend").addEventListener("click", sendChatMessage);

let pendingChatEnter = false;
chatInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  // Don't send mid-IME - emoji picker / IME composition won't have committed input.value yet
  if (e.isComposing || e.keyCode === 229) {
    pendingChatEnter = true;
    return;
  }
  sendChatMessage();
});
chatInput.addEventListener("compositionend", () => {
  if (pendingChatEnter) {
    pendingChatEnter = false;
    setTimeout(sendChatMessage, 0);
  }
});
chatInput.addEventListener("input", () => {
  noteLocalTyping(chatInput.value.length > 0);
});

roomCodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinRoom();
});

// Auto-format room code input
roomCodeInput.addEventListener("input", () => {
  // Allow alphanumeric + hyphen so users can type custom room names like "yash-and-anshul"
  roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9-]/g, "");
});

// --- Functions ---

function getUserName() {
  return userNameInput.value.trim() || "";
}

// The room can be live while the tab in front of you is not the one it is playing in: you
// closed the party tab, or you opened the next thing you want to watch in a new tab. None
// of that ends the session, so say what is going on and offer the one-click way back.
function updateReattachBar() {
  if (!reattachBar) return;
  if (!currentRoom) {
    reattachBar.style.display = "none";
    return;
  }

  let text = "";
  let label = "";
  if (partyTabId === null) {
    text = "The room is still live, but no video tab is attached.";
    label = "Attach this tab";
  } else if (activeTabId !== null && activeTabId !== partyTabId) {
    text = "The party is playing in another tab.";
    label = "Move it here";
  }

  if (!text) {
    reattachBar.style.display = "none";
    return;
  }
  reattachBarText.textContent = text;
  if (btnReattach) btnReattach.textContent = label;
  reattachBar.style.display = "flex";
}

function showView(name) {
  viewLanding.classList.toggle("active", name === "landing");
  viewRoom.classList.toggle("active", name === "room");
}

function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  if (!safePost({ type: "chat", message: text })) return;
  addChatMessage(getUserName(), text, true);
  chatInput.value = "";
  noteLocalTyping(false);
  chatInput.focus();
}

// ---------- Typing indicator ----------
const TYPING_THROTTLE_MS = 1500;
const TYPING_IDLE_MS = 3000;
const popupTyping = {
  lastSentAt: 0,
  lastSentValue: false,
  idleTimer: null,
  activePeers: new Map(),
};

function noteLocalTyping(hasContent) {
  const now = Date.now();
  if (hasContent && (now - popupTyping.lastSentAt > TYPING_THROTTLE_MS || !popupTyping.lastSentValue)) {
    safePost({ type: "chat-typing", isTyping: true });
    popupTyping.lastSentAt = now;
    popupTyping.lastSentValue = true;
  }
  if (popupTyping.idleTimer) clearTimeout(popupTyping.idleTimer);
  if (hasContent) {
    popupTyping.idleTimer = setTimeout(() => {
      if (popupTyping.lastSentValue) {
        safePost({ type: "chat-typing", isTyping: false });
        popupTyping.lastSentValue = false;
      }
    }, TYPING_IDLE_MS);
  } else if (popupTyping.lastSentValue) {
    safePost({ type: "chat-typing", isTyping: false });
    popupTyping.lastSentValue = false;
  }
}

function handleRemoteTyping(msg) {
  if (!msg.userId || msg.userName === getUserName()) return;
  const existing = popupTyping.activePeers.get(msg.userId);
  if (existing && existing.timer) clearTimeout(existing.timer);
  if (msg.isTyping) {
    const timer = setTimeout(() => {
      popupTyping.activePeers.delete(msg.userId);
      renderTypingIndicator();
    }, TYPING_IDLE_MS + 500);
    popupTyping.activePeers.set(msg.userId, { userName: msg.userName, timer });
  } else {
    popupTyping.activePeers.delete(msg.userId);
  }
  renderTypingIndicator();
}

function renderTypingIndicator() {
  const el = $("#typingIndicator");
  if (!el) return;
  const names = Array.from(popupTyping.activePeers.values()).map((p) => p.userName).filter(Boolean);
  if (names.length === 0) { el.textContent = ""; return; }
  if (names.length === 1) el.textContent = `${names[0]} is typing…`;
  else if (names.length === 2) el.textContent = `${names[0]} and ${names[1]} are typing…`;
  else el.textContent = `${names.length} people are typing…`;
}

function addChatMessage(name, text, isOwn = false) {
  const div = document.createElement("div");
  div.className = "chat-msg";
  const nameSpan = document.createElement("span");
  nameSpan.className = `name ${isOwn ? "own" : "other"}`;
  nameSpan.textContent = name;
  const textSpan = document.createElement("span");
  textSpan.className = "text";
  textSpan.textContent = " " + text;
  div.appendChild(nameSpan);
  div.appendChild(textSpan);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  while (chatMessages.children.length > 200) {
    chatMessages.removeChild(chatMessages.firstChild);
  }
}

function addSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "chat-msg system";
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateMembersList() {
  membersListEl.innerHTML = "";
  members.forEach((m) => {
    const span = document.createElement("span");
    span.className = "member-tag";
    span.textContent = m.userName;
    membersListEl.appendChild(span);
  });
  memberCountEl.textContent = members.length;
}

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => toastEl.classList.remove("show"), 2500);
}

function shakeElement(el) {
  el.style.animation = "none";
  el.offsetHeight;
  el.style.animation = "shake 0.4s ease";
  setTimeout(() => { el.style.animation = ""; }, 400);
}

function flashButton(btn) {
  const orig = btn.querySelector("span")?.textContent;
  if (orig) btn.querySelector("span").textContent = "Done";
  btn.style.opacity = "0.6";
  setTimeout(() => {
    if (orig) btn.querySelector("span").textContent = orig;
    btn.style.opacity = "";
  }, 1000);
}

// Shake animation
const style = document.createElement("style");
style.textContent = `@keyframes shake { 0%,100%{transform:translateX(0)} 20%,60%{transform:translateX(-4px)} 40%,80%{transform:translateX(4px)} }`;
document.head.appendChild(style);

// --- Messages from background ---

function handlePortMessage(msg) {
  switch (msg.type) {
    case "state":
      updateConnectionStatus(msg.connected);
      if (msg.serverUrl) serverUrlInput.value = msg.serverUrl;
      if (msg.currentRoom) {
        currentRoom = msg.currentRoom;
        displayRoomCode.textContent = currentRoom;
        if (Array.isArray(msg.members) && msg.members.length) {
          members = msg.members;
          updateMembersList();
        }
        if (typeof msg.mode === "string") {
          currentMode = msg.mode;
        }
        if (typeof msg.isHost === "boolean") {
          isHost = msg.isHost;
        }
        updateModeUI();
        partyTabId = typeof msg.partyTabId === "number" ? msg.partyTabId : null;
        updateReattachBar();
        showView("room");
      }
      if (msg.isHeartbeatLeader) {
        leaderBadge.style.display = "inline-flex";
      }
      break;

    case "connection-status":
      updateConnectionStatus(msg.connected);
      break;

    // The party tab was closed. The room deliberately outlives it, so all the user has to
    // do is point us at a new video tab.
    case "party-tab-closed":
      partyTabId = null;
      updateReattachBar();
      break;

    case "party-tab-adopted":
      partyTabId = activeTabId;
      updateReattachBar();
      showToast("The party is on this tab now");
      break;

    case "room-created":
      currentRoom = msg.roomCode;
      isHost = true;
      currentMode = msg.mode || "everyone";
      displayRoomCode.textContent = msg.roomCode;
      members = [{ id: msg.userId, userName: getUserName() }];
      updateMembersList();
      updateModeUI();
      showView("room");
      addSystemMessage("Room created");
      showToast("Room created - share the code!");
      // Find out whether the room actually landed on a video tab. It will not have if the
      // tab in front of the user cannot run a content script.
      setTimeout(() => safePost({ type: "get-state" }), 400);
      break;

    case "room-joined":
      currentRoom = msg.roomCode;
      isHost = msg.isHost || false;
      currentMode = msg.mode || "everyone";
      displayRoomCode.textContent = msg.roomCode;
      members = msg.members || [];
      updateMembersList();
      updateModeUI();
      showView("room");
      addSystemMessage(`Joined with ${members.length} watching`);
      break;

    case "mode-changed":
      currentMode = msg.mode;
      updateModeUI();
      addSystemMessage(`${msg.fromUser} switched to ${msg.mode === "host" ? "host only" : "everyone"} controls`);
      break;

    case "member-joined":
      members.push({ id: msg.userId, userName: msg.userName });
      updateMembersList();
      addSystemMessage(`${msg.userName} joined`);
      break;

    case "member-left":
      members = members.filter((m) => m.id !== msg.userId);
      updateMembersList();
      addSystemMessage(`${msg.userName} left`);
      break;

    case "heartbeat-role":
      leaderBadge.style.display = msg.isLeader ? "inline-flex" : "none";
      break;

    case "chat":
      addChatMessage(msg.userName, msg.message);
      handleRemoteTyping({ userId: msg.userId, userName: msg.userName, isTyping: false });
      break;

    case "chat-typing":
      handleRemoteTyping(msg);
      break;

    case "cc-state":
      addSystemMessage(`${msg.userName || "Someone"} turned captions ${msg.active ? "ON" : "OFF"}`);
      break;

    case "error":
      showToast(msg.message);
      break;
  }
}

function updateModeUI() {
  const modeLabel = $("#modeLabel");
  const toggleBtn = $("#btnToggleMode");
  modeLabel.textContent = currentMode === "host" ? "Host controls only" : "Everyone controls";
  toggleBtn.style.display = isHost ? "inline-flex" : "none";
}

function updateConnectionStatus(connected) {
  statusEl.className = `status-pill ${connected ? "connected" : "disconnected"}`;
  statusText.textContent = connected ? "Live" : "Offline";
}
