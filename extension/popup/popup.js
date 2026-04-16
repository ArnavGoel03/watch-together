// Popup script — room management, chat, server config

const $ = (sel) => document.querySelector(sel);
const port = chrome.runtime.connect({ name: "popup" });

let currentRoom = null;
let members = [];

// Elements
const viewLanding = $("#view-landing");
const viewRoom = $("#view-room");
const statusEl = $("#status");
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

// Load saved state
chrome.storage.local.get(["userName", "serverUrl"], (data) => {
  if (data.userName) userNameInput.value = data.userName;
  if (data.serverUrl) serverUrlInput.value = data.serverUrl;
  port.postMessage({ type: "get-state" });
});

// --- Event Listeners ---

$("#btnCreate").addEventListener("click", () => {
  const name = getUserName();
  if (!name || name === "User") {
    showToast("Enter your name first");
    userNameInput.focus();
    return;
  }
  chrome.storage.local.set({ userName: name });
  port.postMessage({ type: "create-room", userName: name });
});

$("#btnJoin").addEventListener("click", () => {
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!code || code.length < 4) {
    showToast("Enter a valid room code");
    roomCodeInput.focus();
    return;
  }
  const name = getUserName();
  if (!name || name === "User") {
    showToast("Enter your name first");
    userNameInput.focus();
    return;
  }
  chrome.storage.local.set({ userName: name });
  port.postMessage({ type: "join-room", roomCode: code, userName: name });
});

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
    showToast("Room code copied!");
  });
});

$("#btnCopyLink").addEventListener("click", () => {
  const link = `Join my Watch Together room!\nCode: ${currentRoom}\n\nInstall the extension and enter this code to watch together.`;
  navigator.clipboard.writeText(link).then(() => {
    showToast("Shareable link copied!");
  });
});

$("#btnSaveServer").addEventListener("click", () => {
  const url = serverUrlInput.value.trim();
  if (!url) {
    showToast("Enter a server URL");
    return;
  }
  port.postMessage({ type: "set-server-url", url });
  showToast("Server updated — reconnecting...");
});

$("#btnSend").addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChatMessage();
});
roomCodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#btnJoin").click();
});

// --- Functions ---

function getUserName() {
  return userNameInput.value.trim() || "User";
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
  div.innerHTML = `<span class="name" style="${isOwn ? "color: #4caf50" : ""}">${escapeHtml(name)}</span>: <span class="text">${escapeHtml(text)}</span>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Keep max 200 messages in DOM
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
  membersListEl.innerHTML = members
    .map((m) => `<span class="member-tag">${escapeHtml(m.userName)}</span>`)
    .join("");
  memberCountEl.textContent = members.length;
}

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 2500);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Messages from background ---

port.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "state":
      statusEl.textContent = msg.connected ? "Connected" : "Disconnected";
      statusEl.className = `status ${msg.connected ? "connected" : "disconnected"}`;
      if (msg.serverUrl) serverUrlInput.value = msg.serverUrl;
      if (msg.currentRoom) {
        currentRoom = msg.currentRoom;
        displayRoomCode.textContent = currentRoom;
        showView("room");
      }
      if (msg.isHeartbeatLeader) {
        leaderBadge.style.display = "inline";
      }
      break;

    case "connection-status":
      statusEl.textContent = msg.connected ? "Connected" : "Disconnected";
      statusEl.className = `status ${msg.connected ? "connected" : "disconnected"}`;
      break;

    case "room-created":
      currentRoom = msg.roomCode;
      displayRoomCode.textContent = msg.roomCode;
      members = [{ id: msg.userId, userName: getUserName() }];
      updateMembersList();
      showView("room");
      addSystemMessage(`Room created: ${msg.roomCode}`);
      showToast("Room created!");
      break;

    case "room-joined":
      currentRoom = msg.roomCode;
      displayRoomCode.textContent = msg.roomCode;
      members = msg.members || [];
      updateMembersList();
      showView("room");
      addSystemMessage(`Joined room with ${members.length} member(s)`);
      break;

    case "member-joined":
      members.push({ id: msg.userId, userName: msg.userName });
      updateMembersList();
      addSystemMessage(`${msg.userName} joined (${msg.memberCount} watching)`);
      break;

    case "member-left":
      members = members.filter((m) => m.id !== msg.userId);
      updateMembersList();
      addSystemMessage(`${msg.userName} left (${msg.memberCount} watching)`);
      break;

    case "heartbeat-role":
      leaderBadge.style.display = msg.isLeader ? "inline" : "none";
      break;

    case "chat":
      addChatMessage(msg.userName, msg.message);
      break;

    case "error":
      showToast(msg.message);
      break;
  }
});
