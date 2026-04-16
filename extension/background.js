// Background service worker — manages WebSocket connection and relays messages

// PRODUCTION: Change this to your deployed server URL (wss:// for secure)
// e.g. "wss://watch-together-server.onrender.com"
const DEFAULT_SERVER_URL = "ws://localhost:3000";

let ws = null;
let serverUrl = DEFAULT_SERVER_URL;
let currentRoom = null;
let userId = null;
let isHeartbeatLeader = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let connectedPorts = new Map(); // tabId -> port

// Load server URL from storage (allows runtime config)
chrome.storage.local.get(["serverUrl"], (data) => {
  if (data.serverUrl) serverUrl = data.serverUrl;
});

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
    broadcastToAllTabs({ type: "connection-status", connected: true });
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
        broadcastToAllTabs({
          type: "heartbeat-role",
          isLeader: msg.isLeader,
        });
        break;

      case "sync":
      case "heartbeat":
        // Forward to content scripts (only from other users)
        if (msg.fromUserId !== userId) {
          broadcastToAllTabs(msg);
        }
        break;

      case "chat":
      case "member-joined":
      case "member-left":
      case "error":
        broadcastToAllTabs(msg);
        break;
    }
  };

  ws.onclose = (event) => {
    console.log(`[WatchTogether] Disconnected (code: ${event.code})`);
    ws = null;
    broadcastToAllTabs({ type: "connection-status", connected: false });
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

function broadcastToAllTabs(msg) {
  for (const [tabId, port] of connectedPorts) {
    try {
      port.postMessage(msg);
    } catch {
      connectedPorts.delete(tabId);
    }
  }
}

function saveState() {
  chrome.storage.local.set({ currentRoom, userId });
}

// Handle connections from content scripts and popup
chrome.runtime.onConnect.addListener((port) => {
  const tabId = port.sender?.tab?.id || port.name;
  connectedPorts.set(tabId, port);

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "connect":
        connect();
        break;

      case "create-room":
        connect();
        waitForConnection(() => {
          sendToServer({
            type: "create-room",
            userName: msg.userName,
            origin: msg.origin || "",
          });
        });
        break;

      case "join-room":
        connect();
        waitForConnection(() => {
          sendToServer({
            type: "join-room",
            roomCode: msg.roomCode.toUpperCase(),
            userName: msg.userName,
          });
        });
        break;

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
        // Only send heartbeats if we are the designated leader
        if (isHeartbeatLeader) {
          sendToServer(msg);
        }
        break;

      case "chat":
        sendToServer(msg);
        break;

      case "set-server-url":
        serverUrl = msg.url;
        chrome.storage.local.set({ serverUrl: msg.url });
        // Reconnect to new server
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
    connectedPorts.delete(tabId);
  });
});

function waitForConnection(callback, retries = 15) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    callback();
  } else if (retries > 0) {
    setTimeout(() => waitForConnection(callback, retries - 1), 300);
  }
}
