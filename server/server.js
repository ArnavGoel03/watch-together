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
    const code = req.url.split("/room/")[1]?.split("?")[0]?.toUpperCase();
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

  // Shareable join link: /join/CODE?url=ENCODED_VIDEO_URL
  if (req.url.startsWith("/join/")) {
    const urlParts = req.url.split("/join/")[1] || "";
    const [codePart, queryString] = urlParts.split("?");
    const code = codePart.toUpperCase();
    const params = new URLSearchParams(queryString || "");
    const videoUrl = params.get("url") || "";
    const room = rooms.get(code);
    const memberCount = room ? room.members.size : 0;
    const roomExists = !!room;

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Join Watch Together Room ${code}</title>
  <meta name="description" content="Join a Watch Together room and watch videos in sync with friends!">
  <meta property="og:title" content="Join my Watch Together room!">
  <meta property="og:description" content="Watch videos together in real-time. Room code: ${code}${memberCount > 0 ? " — " + memberCount + " watching now" : ""}">
  <meta property="og:type" content="website">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e0e0e0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #1a1a1a; border-radius: 16px; padding: 40px; max-width: 420px; width: 90%; text-align: center; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
    h1 { font-size: 24px; margin-bottom: 8px; color: #fff; }
    .subtitle { color: #888; margin-bottom: 24px; font-size: 14px; }
    .room-code { font-size: 36px; font-weight: 700; color: #6c63ff; letter-spacing: 6px; margin: 16px 0; }
    .status { font-size: 13px; color: ${roomExists ? "#4caf50" : "#f44336"}; margin-bottom: 24px; }
    .btn { display: inline-block; padding: 14px 32px; background: #6c63ff; color: #fff; text-decoration: none; border-radius: 8px; font-size: 16px; font-weight: 600; transition: background 0.2s; cursor: pointer; border: none; width: 100%; margin-bottom: 12px; }
    .btn:hover { background: #5a52d5; }
    .btn-outline { background: transparent; border: 1px solid #444; color: #ccc; }
    .btn-outline:hover { background: #2a2a2a; }
    .steps { text-align: left; margin: 20px 0; padding: 16px; background: #111; border-radius: 8px; font-size: 13px; line-height: 1.8; color: #aaa; }
    .steps b { color: #fff; }
    .redirect-msg { color: #4caf50; font-size: 14px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Watch Together</h1>
    <p class="subtitle">You've been invited to watch together!</p>
    <div class="room-code">${code}</div>
    <div class="status">${roomExists ? memberCount + " watching now" : "Waiting for host to start"}</div>
    ${videoUrl ? `<a href="${videoUrl}" class="btn" id="joinBtn">Open Video & Join Room</a>` : ""}
    <div class="steps">
      <b>How to join:</b><br>
      1. Install the <a href="#" style="color:#6c63ff">Watch Together</a> extension<br>
      2. ${videoUrl ? 'Click the button above — the video will open' : 'Open the same video as your friend'}<br>
      3. Click the extension icon → enter code <b>${code}</b><br>
      4. You're in sync!
    </div>
    ${videoUrl ? '<p class="redirect-msg" id="redirectMsg" style="display:none">Opening video...</p>' : ""}
  </div>
  <script>
    const code = "${code}";
    const videoUrl = "${videoUrl.replace(/"/g, '\\"')}";
    // Store room code so the extension can auto-join
    if (videoUrl) {
      document.getElementById("joinBtn").addEventListener("click", function(e) {
        // Set a flag in localStorage for the extension to pick up
        try {
          localStorage.setItem("watchtogether_autojoin", JSON.stringify({ code: code, url: videoUrl, ts: Date.now() }));
        } catch(e) {}
      });
    }
  </script>
</body>
</html>`);
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Watch Together</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #0f0f0f; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { text-align: center; }
    h1 { font-size: 32px; margin-bottom: 8px; }
    p { color: #888; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Watch Together</h1>
    <p>Sync video playback with friends worldwide</p>
  </div>
</body>
</html>`);
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
