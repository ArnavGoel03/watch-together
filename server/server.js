const http = require("http");
const { WebSocketServer } = require("ws");

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const MAX_ROOM_MEMBERS = parseInt(process.env.MAX_ROOM_MEMBERS) || 50;
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS) || 10000;
const ROOM_TTL_MS = parseInt(process.env.ROOM_TTL_HOURS) * 3600000 || 12 * 3600000; // 12h default
const ROOM_CLEANUP_INTERVAL = 60000; // check every minute
const WS_PING_INTERVAL = 30000; // ping every 30s to detect dead connections
const MAX_MESSAGE_SIZE = 4096; // bytes
const RATE_LIMIT_WINDOW = 1000; // 1 second
const RATE_LIMIT_MAX = 20; // max messages per window
const MAX_CHAT_LENGTH = 500;
const MAX_USERNAME_LENGTH = 30;

// --- State ---
const rooms = new Map();
let totalConnections = 0;

// --- Utilities ---

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  // Ensure uniqueness
  do {
    code = "";
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function generateUserId() {
  return Math.random().toString(36).substring(2, 10);
}

function sanitize(str, maxLen) {
  if (typeof str !== "string") return "";
  return str.replace(/[<>&"']/g, "").substring(0, maxLen).trim();
}

function broadcastToRoom(roomCode, message, excludeWs = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const data = JSON.stringify(message);
  for (const member of room.members.values()) {
    if (member.ws !== excludeWs && member.ws.readyState === 1) {
      member.ws.send(data);
    }
  }
}

function sendTo(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function cleanupRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (room && room.members.size === 0) {
    rooms.delete(roomCode);
    console.log(`[cleanup] Room ${roomCode} deleted (empty). Active rooms: ${rooms.size}`);
  }
}

// Elect heartbeat leader — the first member in the room.
// Only this user sends heartbeats to avoid N^2 broadcast storm.
function getHeartbeatLeader(room) {
  const firstEntry = room.members.entries().next();
  if (firstEntry.done) return null;
  return firstEntry.value[0]; // userId
}

function notifyHeartbeatLeader(room) {
  const leaderId = getHeartbeatLeader(room);
  if (!leaderId) return;
  for (const [uid, member] of room.members) {
    sendTo(member.ws, {
      type: "heartbeat-role",
      isLeader: uid === leaderId,
    });
  }
}

// --- Rate Limiter ---
class RateLimiter {
  constructor(windowMs, max) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map(); // usedId -> { count, resetAt }
  }

  check(id) {
    const now = Date.now();
    const entry = this.hits.get(id);
    if (!entry || now > entry.resetAt) {
      this.hits.set(id, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= this.max;
  }

  // Periodic cleanup of expired entries
  cleanup() {
    const now = Date.now();
    for (const [id, entry] of this.hits) {
      if (now > entry.resetAt) this.hits.delete(id);
    }
  }
}

const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW, RATE_LIMIT_MAX);

// --- Stale Room Cleanup ---
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [code, room] of rooms) {
    // Remove rooms with no members that are older than 5 minutes
    if (room.members.size === 0 && now - room.createdAt > 300000) {
      rooms.delete(code);
      cleaned++;
      continue;
    }
    // Remove rooms older than TTL regardless
    if (now - room.lastActivity > ROOM_TTL_MS) {
      // Notify remaining members
      broadcastToRoom(code, {
        type: "error",
        message: "Room expired due to inactivity",
      });
      // Close all member connections gracefully
      for (const member of room.members.values()) {
        member.ws.close(4001, "Room expired");
      }
      rooms.delete(code);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[cleanup] Removed ${cleaned} stale rooms. Active rooms: ${rooms.size}`);
  }
  rateLimiter.cleanup();
}, ROOM_CLEANUP_INTERVAL);

// --- HTTP Server ---
const server = http.createServer((req, res) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  if (req.url === "/health") {
    let totalMembers = 0;
    for (const room of rooms.values()) totalMembers += room.members.size;
    res.writeHead(200, headers);
    res.end(
      JSON.stringify({
        status: "ok",
        rooms: rooms.size,
        connections: totalConnections,
        members: totalMembers,
        uptime: Math.floor(process.uptime()),
      })
    );
    return;
  }

  if (req.url === "/stats") {
    const roomStats = [];
    for (const [code, room] of rooms) {
      roomStats.push({
        code,
        members: room.members.size,
        ageMinutes: Math.floor((Date.now() - room.createdAt) / 60000),
      });
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({ rooms: roomStats }));
    return;
  }

  if (req.url.startsWith("/room/")) {
    const code = req.url.split("/room/")[1]?.toUpperCase();
    const room = rooms.get(code);
    res.writeHead(200, headers);
    res.end(
      JSON.stringify({
        exists: !!room,
        code,
        members: room ? room.members.size : 0,
      })
    );
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Watch Together Sync Server v1.0");
});

// --- WebSocket Server ---
const wss = new WebSocketServer({
  server,
  maxPayload: MAX_MESSAGE_SIZE,
});

// Ping all clients periodically to detect dead connections
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`[ping] Terminating dead connection`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, WS_PING_INTERVAL);

wss.on("close", () => clearInterval(pingInterval));

wss.on("connection", (ws, req) => {
  const userId = generateUserId();
  let currentRoom = null;
  let userName = "User";

  ws.isAlive = true;
  totalConnections++;

  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress;
  console.log(`[connect] ${userId} from ${clientIp}. Total: ${totalConnections}`);

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    // Rate limit check
    if (!rateLimiter.check(userId)) {
      sendTo(ws, { type: "error", message: "Rate limited — slow down" });
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "create-room": {
        // Leave current room if in one
        if (currentRoom) leaveCurrentRoom();

        if (rooms.size >= MAX_ROOMS) {
          sendTo(ws, { type: "error", message: "Server is at capacity. Try again later." });
          return;
        }

        const roomCode = generateRoomCode();
        userName = sanitize(msg.userName, MAX_USERNAME_LENGTH) || "User";

        const room = {
          code: roomCode,
          members: new Map([[userId, { ws, userName }]]),
          playbackState: {
            playing: false,
            currentTime: 0,
            playbackRate: 1,
            lastUpdate: Date.now(),
          },
          createdAt: Date.now(),
          lastActivity: Date.now(),
        };
        rooms.set(roomCode, room);
        currentRoom = roomCode;

        sendTo(ws, {
          type: "room-created",
          roomCode,
          userId,
        });

        notifyHeartbeatLeader(room);
        console.log(`[room] ${roomCode} created by ${userName}. Active rooms: ${rooms.size}`);
        break;
      }

      case "join-room": {
        const code = typeof msg.roomCode === "string" ? msg.roomCode.toUpperCase().trim() : "";
        const room = rooms.get(code);
        if (!room) {
          sendTo(ws, { type: "error", message: "Room not found" });
          return;
        }

        if (room.members.size >= MAX_ROOM_MEMBERS) {
          sendTo(ws, { type: "error", message: `Room is full (max ${MAX_ROOM_MEMBERS})` });
          return;
        }

        // Leave current room if in one
        if (currentRoom) leaveCurrentRoom();

        userName = sanitize(msg.userName, MAX_USERNAME_LENGTH) || "User";
        room.members.set(userId, { ws, userName });
        room.lastActivity = Date.now();
        currentRoom = code;

        // Send current state to the joining user
        sendTo(ws, {
          type: "room-joined",
          roomCode: code,
          userId,
          playbackState: room.playbackState,
          members: Array.from(room.members.entries()).map(([id, m]) => ({
            id,
            userName: m.userName,
          })),
        });

        // Notify others
        broadcastToRoom(
          code,
          {
            type: "member-joined",
            userId,
            userName,
            memberCount: room.members.size,
          },
          ws
        );

        // Reassign heartbeat leader (new member might change it)
        notifyHeartbeatLeader(room);
        console.log(`[room] ${userName} joined ${code}. Members: ${room.members.size}`);
        break;
      }

      case "sync": {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;

        const currentTime = parseFloat(msg.currentTime);
        const playbackRate = parseFloat(msg.playbackRate) || 1;
        if (isNaN(currentTime) || currentTime < 0) return;
        if (playbackRate < 0.1 || playbackRate > 16) return;

        room.playbackState = {
          playing: !!msg.playing,
          currentTime,
          playbackRate,
          lastUpdate: Date.now(),
        };
        room.lastActivity = Date.now();

        broadcastToRoom(
          currentRoom,
          {
            type: "sync",
            playing: !!msg.playing,
            currentTime,
            playbackRate,
            action: sanitize(msg.action || "", 20),
            fromUser: userName,
            fromUserId: userId,
            timestamp: Date.now(),
          },
          ws
        );
        break;
      }

      case "heartbeat": {
        if (!currentRoom) return;
        const rm = rooms.get(currentRoom);
        if (!rm) return;

        // Only accept heartbeats from the designated leader
        const leaderId = getHeartbeatLeader(rm);
        if (userId !== leaderId) return;

        const ct = parseFloat(msg.currentTime);
        const pr = parseFloat(msg.playbackRate) || 1;
        if (isNaN(ct) || ct < 0) return;

        rm.playbackState = {
          playing: !!msg.playing,
          currentTime: ct,
          playbackRate: pr,
          lastUpdate: Date.now(),
        };
        rm.lastActivity = Date.now();

        broadcastToRoom(
          currentRoom,
          {
            type: "heartbeat",
            playing: !!msg.playing,
            currentTime: ct,
            playbackRate: pr,
            fromUserId: userId,
            timestamp: Date.now(),
          },
          ws
        );
        break;
      }

      case "chat": {
        if (!currentRoom) return;
        const chatRoom = rooms.get(currentRoom);
        if (!chatRoom) return;

        const message = sanitize(msg.message, MAX_CHAT_LENGTH);
        if (!message) return;

        chatRoom.lastActivity = Date.now();

        broadcastToRoom(currentRoom, {
          type: "chat",
          message,
          userName,
          userId,
          timestamp: Date.now(),
        });
        break;
      }

      case "leave-room": {
        leaveCurrentRoom();
        break;
      }
    }
  });

  function leaveCurrentRoom() {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) {
      room.members.delete(userId);
      broadcastToRoom(currentRoom, {
        type: "member-left",
        userId,
        userName,
        memberCount: room.members.size,
      });
      // If the leader left, reassign
      if (room.members.size > 0) {
        notifyHeartbeatLeader(room);
      }
      cleanupRoom(currentRoom);
    }
    currentRoom = null;
  }

  ws.on("close", () => {
    totalConnections--;
    console.log(`[disconnect] ${userId}. Total: ${totalConnections}`);
    leaveCurrentRoom();
  });

  ws.on("error", (err) => {
    console.error(`[error] ${userId}: ${err.message}`);
  });
});

// --- Graceful Shutdown ---
function shutdown(signal) {
  console.log(`\n[shutdown] Received ${signal}. Closing gracefully...`);

  // Notify all clients
  wss.clients.forEach((ws) => {
    sendTo(ws, { type: "error", message: "Server is restarting. You will reconnect automatically." });
    ws.close(1001, "Server shutting down");
  });

  clearInterval(pingInterval);
  wss.close(() => {
    server.close(() => {
      console.log("[shutdown] Server closed.");
      process.exit(0);
    });
  });

  // Force exit after 5 seconds
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// --- Start ---
server.listen(PORT, () => {
  console.log(`[start] Watch Together server running on port ${PORT}`);
  console.log(`[start] Max rooms: ${MAX_ROOMS}, Max members/room: ${MAX_ROOM_MEMBERS}, Room TTL: ${ROOM_TTL_MS / 3600000}h`);
});
