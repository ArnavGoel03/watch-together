// Firefox background script — same logic as background.js, Manifest V2 compatible

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

chrome.storage.local.get(["serverUrl", "currentRoom", "userId"], (data) => {
  if (data.serverUrl) serverUrl = data.serverUrl;
  if (data.currentRoom) {
    currentRoom = data.currentRoom;
    userId = data.userId;
    connect();
  }
});

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
    broadcastToAllTabs({ type: "connection-status", connected: true });
    // Auto-rejoin room after reconnect
    if (currentRoom) {
      chrome.storage.local.get(["userName"], (data) => {
        sendToServer({
          type: "join-room",
          roomCode: currentRoom,
          userName: data.userName || "User",
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
        saveState();
        broadcastToAllTabs(msg);
        break;

      case "room-joined":
        currentRoom = msg.roomCode;
        userId = msg.userId;
        saveState();
        broadcastToAllTabs(msg);
        break;

      case "heartbeat-role":
        isHeartbeatLeader = msg.isLeader;
        broadcastToAllTabs({ type: "heartbeat-role", isLeader: msg.isLeader });
        break;

      case "sync":
      case "heartbeat":
        if (msg.fromUserId !== userId) {
          broadcastToAllTabs(msg);
        }
        break;

      case "chat":
      case "member-joined":
      case "member-left":
      case "mode-changed":
      case "error":
        broadcastToAllTabs(msg);
        break;
    }
  };

  ws.onclose = (event) => {
    ws = null;
    broadcastToAllTabs({ type: "connection-status", connected: false });
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

function broadcastToAllTabs(msg) {
  for (const [key, p] of connectedPorts) {
    try {
      p.postMessage(msg);
    } catch {
      connectedPorts.delete(key);
    }
  }
}

function saveState() {
  chrome.storage.local.set({ currentRoom, userId });
}

chrome.runtime.onConnect.addListener((port) => {
  const tabId = port.sender?.tab?.id;
  const portKey = tabId ? `${tabId}:${port.name}` : port.name;
  connectedPorts.set(portKey, port);

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "connect":
        connect();
        break;

      case "create-room":
        connect();
        waitForConnection(() => {
          sendToServer({ type: "create-room", userName: msg.userName, videoUrl: msg.videoUrl || "" });
        });
        break;

      case "join-room": {
        const roomCode = msg.roomCode?.toUpperCase();
        if (!roomCode) break;
        pendingJoin = true;
        connect();
        waitForConnection(() => {
          sendToServer({ type: "join-room", roomCode, userName: msg.userName || "User" });
          pendingJoin = false;
        });
        break;
      }

      case "leave-room":
        sendToServer({ type: "leave-room" });
        currentRoom = null;
        userId = null;
        isHeartbeatLeader = false;
        saveState();
        break;

      case "sync":
        sendToServer(msg);
        break;

      case "heartbeat":
        if (isHeartbeatLeader) sendToServer(msg);
        break;

      case "chat":
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

      case "get-state":
        port.postMessage({
          type: "state",
          currentRoom,
          userId,
          connected: ws && ws.readyState === WebSocket.OPEN,
          isHeartbeatLeader,
          serverUrl,
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
    broadcastToAllTabs({ type: "error", message: "Could not connect to server. Try again." });
  }
}
