// Background service worker — manages WebSocket connection and relays messages

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

// Restore state from storage (survives MV3 service worker restarts)
chrome.storage.local.get(["serverUrl", "currentRoom", "userId"], (data) => {
  if (data.serverUrl) serverUrl = data.serverUrl;
  if (data.currentRoom) {
    currentRoom = data.currentRoom;
    userId = data.userId;
    connect(); // Reconnect and rejoin
  }
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
      case "mode-changed":
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

// Handle connections from content scripts and popup
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
          sendToServer({
            type: "create-room",
            userName: msg.userName,
            videoUrl: msg.videoUrl || "",
            mode: msg.mode || "everyone",
          });
        });
        break;

      case "join-room": {
        const roomCode = msg.roomCode?.toUpperCase();
        if (!roomCode) break;
        pendingJoin = true;
        connect();
        waitForConnection(() => {
          sendToServer({
            type: "join-room",
            roomCode,
            userName: msg.userName || "User",
          });
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
        // Only send heartbeats if we are the designated leader
        if (isHeartbeatLeader) {
          sendToServer(msg);
        }
        break;

      case "chat":
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
    // Keep trying to connect if WebSocket is dead
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connect();
    }
    setTimeout(() => waitForConnection(callback, retries - 1), 1000);
  } else {
    pendingJoin = false;
    broadcastToAllTabs({ type: "error", message: "Could not connect to server. Try again." });
  }
}
