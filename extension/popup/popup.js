// Popup — Room management, chat, and server config

const $ = (sel) => document.querySelector(sel);
let port = null;
let inFlight = new Set();

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
      showToast("Connection lost — try again");
      return false;
    }
  }
}

// Robust clipboard write — async clipboard with execCommand fallback.
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
const chatMessages = $("#chatMessages");
const chatInput = $("#chatInput");
const toastEl = $("#toast");
const btnCreate = $("#btnCreate");

// Backend presets — Render is the original Node server, Cloudflare is the new Worker.
// Per-backend URL is remembered so flipping the radio swaps the URL field instantly.
const BACKEND_DEFAULTS = {
  render: "wss://watch-together-server-acwi.onrender.com",
  cloudflare: "",
};
let backendUrls = { ...BACKEND_DEFAULTS };
let activeBackend = "render";

// Load saved state & trigger connection
chrome.storage.local.get(
  ["userName", "serverUrl", "overlayMode", "overlayHotkey", "backend", "renderUrl", "cloudflareUrl", "voiceQuality"],
  (data) => {
    if (data.userName) userNameInput.value = data.userName;
    backendUrls.render = data.renderUrl || BACKEND_DEFAULTS.render;
    backendUrls.cloudflare = data.cloudflareUrl || "";
    activeBackend = data.backend === "cloudflare" ? "cloudflare" : "render";
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

function applyVoiceQuality(q) {
  document.querySelectorAll('input[name="voiceQuality"]').forEach((r) => {
    r.checked = r.value === q;
  });
}

document.querySelectorAll('input[name="voiceQuality"]').forEach((r) => {
  r.addEventListener("change", () => {
    if (!r.checked) return;
    const q = r.value === "voice" ? "voice" : "media";
    chrome.storage.local.set({ voiceQuality: q });
    showToast(q === "voice" ? "High voice quality (may duck media)" : "Media-friendly voice");
  });
});

function applyBackendRadios(backend) {
  document.querySelectorAll('input[name="backend"]').forEach((r) => {
    r.checked = r.value === backend;
  });
}

// Backend radio — switching repopulates the URL field with that backend's saved URL,
// then the user clicks Save to actually apply (avoids accidental disconnects).
document.querySelectorAll('input[name="backend"]').forEach((r) => {
  r.addEventListener("change", () => {
    if (!r.checked) return;
    activeBackend = r.value;
    serverUrlInput.value = backendUrls[activeBackend] || "";
    if (activeBackend === "cloudflare" && !backendUrls.cloudflare) {
      showToast("Paste your Cloudflare worker URL, then Save");
      serverUrlInput.focus();
    }
  });
});

function applyOverlaySettings(mode, hotkey) {
  document.querySelectorAll('input[name="overlayMode"]').forEach((r) => {
    r.checked = r.value === mode;
  });
  const hotkeyInput = $("#overlayHotkey");
  const hotkeyRow = $("#hotkeyRow");
  if (hotkeyInput) hotkeyInput.value = hotkey;
  if (hotkeyRow) hotkeyRow.style.display = mode === "hold" ? "flex" : "none";
}

// Mode radios — save on change, no separate Save button
document.querySelectorAll('input[name="overlayMode"]').forEach((r) => {
  r.addEventListener("change", () => {
    if (!r.checked) return;
    const mode = r.value;
    chrome.storage.local.set({ overlayMode: mode });
    const row = $("#hotkeyRow");
    if (row) row.style.display = mode === "hold" ? "flex" : "none";
  });
});

// Hotkey input — captures one keypress, persists immediately
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
    updateCreateButton();
  });
}
refreshActiveTabUrl();
// Keep activeTabUrl fresh while popup is open (user may navigate the underlying tab)
const tabRefreshInterval = setInterval(refreshActiveTabUrl, 1500);
window.addEventListener("unload", () => clearInterval(tabRefreshInterval));

function updateCreateButton() {
  const hint = $("#tab-hint");
  if (isVideoTab(activeTabUrl)) {
    btnCreate.disabled = false;
    btnCreate.style.opacity = "1";
    if (hint) hint.style.display = "none";
  } else {
    btnCreate.disabled = true;
    btnCreate.style.opacity = "0.35";
    if (hint) hint.style.display = "block";
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
  withInFlight("create", btnCreate, () => {
    chrome.storage.local.set({ userName: name });
    safePost({ type: "create-room", userName: name, videoUrl: activeTabUrl, mode: selectedMode });
    // Re-enable in 4s if no room-created arrives, so a flake doesn't lock the button
    return new Promise((resolve) => setTimeout(resolve, 4000));
  });
});

// Mode selection buttons
document.querySelectorAll(".mode-btn").forEach((btn) => {
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
    safePost({ type: "join-room", roomCode: code, userName: name });
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

$("#btnCopyCode").addEventListener("click", async () => {
  const btn = $("#btnCopyCode");
  if (!currentRoom) { showToast("No room code yet"); return; }
  const ok = await safeCopy(currentRoom);
  if (ok) {
    showToast("Room code copied");
    flashButton(btn);
  } else {
    showToast("Couldn't copy — long-press the code to select");
  }
});

// Build the share link synchronously from cached state — no async hops
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
  return `https://watch-together-server-acwi.onrender.com/join/${currentRoom}`;
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
    showToast("Couldn't copy — try Copy Code instead");
  }
});

$("#btnSaveServer").addEventListener("click", () => {
  const url = serverUrlInput.value.trim();
  if (!url) {
    showToast("Enter a server URL");
    return;
  }
  if (!/^wss?:\/\//i.test(url)) {
    showToast("Server URL must start with ws:// or wss://");
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
  showToast(`Saved — using ${activeBackend === "cloudflare" ? "Cloudflare" : "Render"}`);
});

$("#btnSend").addEventListener("click", sendChatMessage);

let pendingChatEnter = false;
chatInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  // Don't send mid-IME — emoji picker / IME composition won't have committed input.value yet
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

roomCodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinRoom();
});

// Auto-format room code input
roomCodeInput.addEventListener("input", () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

// --- Functions ---

function getUserName() {
  return userNameInput.value.trim() || "";
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
  chatInput.focus();
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
        showView("room");
      }
      if (msg.isHeartbeatLeader) {
        leaderBadge.style.display = "inline-flex";
      }
      break;

    case "connection-status":
      updateConnectionStatus(msg.connected);
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
      showToast("Room created — share the code!");
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
