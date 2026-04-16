// Popup — Room management, chat, and server config

const $ = (sel) => document.querySelector(sel);
const port = chrome.runtime.connect({ name: "popup" });

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

// Load saved state & check active tab
chrome.storage.local.get(["userName", "serverUrl"], (data) => {
  if (data.userName) userNameInput.value = data.userName;
  if (data.serverUrl) serverUrlInput.value = data.serverUrl;
  port.postMessage({ type: "get-state" });
});

// Check if current tab is suitable for creating a room
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  activeTabUrl = tabs[0]?.url || "";
  updateCreateButton();
});

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
  chrome.storage.local.set({ userName: name });
  port.postMessage({ type: "create-room", userName: name, videoUrl: activeTabUrl, mode: selectedMode });
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
  const newMode = currentMode === "everyone" ? "host" : "everyone";
  port.postMessage({ type: "set-mode", mode: newMode });
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
  chrome.storage.local.set({ userName: name });
  port.postMessage({ type: "join-room", roomCode: code, userName: name });
}

$("#btnLeave").addEventListener("click", () => {
  port.postMessage({ type: "leave-room" });
  currentRoom = null;
  members = [];
  showView("landing");
  chatMessages.innerHTML = "";
  membersListEl.innerHTML = "";
});

$("#btnCopyCode").addEventListener("click", () => {
  navigator.clipboard.writeText(currentRoom).then(() => {
    showToast("Room code copied");
    flashButton($("#btnCopyCode"));
  });
});

$("#btnCopyLink").addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabUrl = tabs[0]?.url || "";
    const base = `https://watch-together-server-acwi.onrender.com/join/${currentRoom}`;
    const link = isVideoTab(tabUrl) ? `${base}?url=${encodeURIComponent(tabUrl)}` : base;
    navigator.clipboard.writeText(link).then(() => {
      showToast("Share link copied");
      flashButton($("#btnCopyLink"));
    });
  });
});

$("#btnSaveServer").addEventListener("click", () => {
  const url = serverUrlInput.value.trim();
  if (!url) {
    showToast("Enter a server URL");
    return;
  }
  port.postMessage({ type: "set-server-url", url });
  showToast("Server updated");
});

$("#btnSend").addEventListener("click", sendChatMessage);

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChatMessage();
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
  port.postMessage({ type: "chat", message: text });
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
  btn.style.borderColor = "#30d158";
  btn.style.color = "#30d158";
  setTimeout(() => {
    btn.style.borderColor = "";
    btn.style.color = "";
  }, 1000);
}

// Shake animation
const style = document.createElement("style");
style.textContent = `@keyframes shake { 0%,100%{transform:translateX(0)} 20%,60%{transform:translateX(-4px)} 40%,80%{transform:translateX(4px)} }`;
document.head.appendChild(style);

// --- Messages from background ---

port.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "state":
      updateConnectionStatus(msg.connected);
      if (msg.serverUrl) serverUrlInput.value = msg.serverUrl;
      if (msg.currentRoom) {
        currentRoom = msg.currentRoom;
        displayRoomCode.textContent = currentRoom;
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
});

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
