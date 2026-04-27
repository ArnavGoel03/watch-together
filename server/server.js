const http = require("http");
const { WebSocketServer } = require("ws");

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const MAX_ROOM_MEMBERS = parseInt(process.env.MAX_ROOM_MEMBERS) || 50;
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS) || 10000;
const ROOM_TTL_MS = (parseInt(process.env.ROOM_TTL_HOURS, 10) || 12) * 3600000; // 12h default
const ROOM_CLEANUP_INTERVAL = 60000; // check every minute
const WS_PING_INTERVAL = 30000; // ping every 30s to detect dead connections
const MAX_MESSAGE_SIZE = 4096; // bytes
const RATE_LIMIT_WINDOW = 1000; // 1 second
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 20;
const MAX_CHAT_LENGTH = 500;
const MAX_USERNAME_LENGTH = 30;
const MAX_CONNECTIONS_PER_IP = 10;
const MAX_VIDEO_URL_LENGTH = 2000;

// --- State ---
const rooms = new Map();
let totalConnections = 0;
const connectionsPerIp = new Map(); // ip -> count

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
  return str.substring(0, maxLen).trim();
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function validateUrl(str) {
  if (typeof str !== "string") return "";
  const trimmed = str.substring(0, MAX_VIDEO_URL_LENGTH).trim();
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) return trimmed;
  return "";
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

// --- Join Page (fallback when no video URL or bad URL) ---
function serveJoinPage(res, code, roomExists, memberCount) {
  const safeCode = escapeHtml(code);
  res.writeHead(200, { "Content-Type": "text/html", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'self' 'unsafe-inline'" });
  res.end(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Join Watch Together — ${safeCode}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#1c1c1e;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;-webkit-font-smoothing:antialiased}
.card{background:#2c2c2e;border-radius:16px;padding:44px 36px;max-width:400px;width:90%;text-align:center}
h1{font-size:20px;font-weight:700;margin-bottom:4px}
.sub{color:rgba(235,235,245,.5);font-size:14px;margin-bottom:24px}
.code{font-size:38px;font-weight:800;color:#a78bfa;letter-spacing:8px;margin:12px 0 8px}
.st{font-size:13px;font-weight:500;margin-bottom:24px;color:${roomExists ? "#30d158" : "rgba(235,235,245,.4)"}}
.err{color:#ff453a;font-size:14px;margin-bottom:20px}
.btn{display:block;padding:14px;background:linear-gradient(135deg,#7c3aed,#a78bfa);color:#fff;text-decoration:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;border:none;width:100%;margin-bottom:10px}
.btn:hover{opacity:.9}
.hint{font-size:12px;color:rgba(235,235,245,.3);margin-top:16px;line-height:1.6}
</style></head><body>
<div class="card">
  <h1>Watch Together</h1>
  <p class="sub">You've been invited to watch together</p>
  <div class="code">${safeCode}</div>
  <div class="st">${roomExists ? memberCount + " watching now" : "Waiting for host"}</div>
  ${!roomExists ? '<p class="err">Room not found — the host may have left.</p>' : ""}
  <button class="btn" onclick="navigator.clipboard.writeText('${safeCode}').then(function(){this.textContent='Copied!'}.bind(this))">Copy Room Code</button>
  <p class="hint">Open the video, click Watch Together, and paste this code.</p>
</div></body></html>`);
}

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



  if (req.url.startsWith("/room/")) {
    // Only expose minimal info — no videoUrl, no exact member count
    const code = req.url.split("/room/")[1]?.split("?")[0]?.toUpperCase();
    const room = rooms.get(code);
    res.writeHead(200, headers);
    res.end(JSON.stringify({ exists: !!room, code }));
    return;
  }

  // Shareable join link: /join/CODE or /join/CODE?url=ENCODED_URL
  if (req.url.startsWith("/join/")) {
    const urlParts = (req.url.split("/join/")[1] || "").split("?");
    const code = urlParts[0].toUpperCase();
    const params = new URLSearchParams(urlParts[1] || "");
    const room = rooms.get(code);
    const memberCount = room ? room.members.size : 0;
    const roomExists = !!room;
    // Prefer room's stored URL, fall back to query param
    const videoUrl = validateUrl((room && room.videoUrl) ? room.videoUrl : (params.get("url") || ""));

    // If video URL exists, auto-redirect to the video with wt_room param
    if (videoUrl) {
      try {
        const redirectUrl = new URL(videoUrl);
        redirectUrl.searchParams.set("wt_room", code);
        res.writeHead(302, { "Location": redirectUrl.toString() });
        res.end();
      } catch {
        // Bad URL, fall through to manual page
        serveJoinPage(res, code, roomExists, memberCount);
      }
    } else {
      serveJoinPage(res, code, roomExists, memberCount);
    }
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'self' 'unsafe-inline'" });
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

  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress;

  // Per-IP connection limiting
  const ipCount = (connectionsPerIp.get(clientIp) || 0) + 1;
  if (ipCount > MAX_CONNECTIONS_PER_IP) {
    console.log(`[reject] ${clientIp} exceeded max connections (${MAX_CONNECTIONS_PER_IP})`);
    ws.close(4002, "Too many connections");
    return;
  }
  connectionsPerIp.set(clientIp, ipCount);

  ws.isAlive = true;
  totalConnections++;
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

        const videoUrl = validateUrl(msg.videoUrl);

        // mode: "everyone" (default) or "host" (only creator controls)
        const mode = msg.mode === "host" ? "host" : "everyone";

        const room = {
          code: roomCode,
          hostId: userId,
          mode,
          members: new Map([[userId, { ws, userName }]]),
          videoUrl,
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
          mode: room.mode,
          isHost: true,
          serverTime: Date.now(),
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
          mode: room.mode,
          isHost: userId === room.hostId,
          videoUrl: room.videoUrl || "",
          serverTime: Date.now(),
          playbackState: {
            ...room.playbackState,
            timestamp: room.playbackState.lastUpdate,
            serverTime: Date.now(),
          },
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

        // In host mode, only the host can control playback
        if (room.mode === "host" && room.hostId !== userId) {
          sendTo(ws, { type: "error", message: "Only the host can control playback" });
          return;
        }

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

        const now = Date.now();
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
            timestamp: now,
            serverTime: now,
            isLive: !!msg.isLive,
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

        const hbNow = Date.now();
        broadcastToRoom(
          currentRoom,
          {
            type: "heartbeat",
            playing: !!msg.playing,
            currentTime: ct,
            playbackRate: pr,
            fromUserId: userId,
            timestamp: hbNow,
            serverTime: hbNow,
            isLive: !!msg.isLive,
          },
          ws
        );
        break;
      }

      case "navigate": {
        if (!currentRoom) return;
        const navRoom = rooms.get(currentRoom);
        if (!navRoom) return;
        // In host mode, only host can change videos
        if (navRoom.mode === "host" && navRoom.hostId !== userId) return;
        const newUrl = validateUrl(msg.url);
        if (!newUrl) return;
        // Ignore if url didn't actually change (avoid noise)
        if (newUrl === navRoom.videoUrl) return;
        navRoom.videoUrl = newUrl;
        // Reset playback state — we're on a different video now
        navRoom.playbackState = {
          playing: false,
          currentTime: 0,
          playbackRate: 1,
          lastUpdate: Date.now(),
        };
        navRoom.lastActivity = Date.now();
        broadcastToRoom(currentRoom, {
          type: "navigate",
          url: newUrl,
          fromUser: userName,
          fromUserId: userId,
          serverTime: Date.now(),
        }, ws);
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
          serverTime: Date.now(),
        }, ws);
        break;
      }

      case "set-mode": {
        if (!currentRoom) return;
        const modeRoom = rooms.get(currentRoom);
        if (!modeRoom) return;
        // Only the host can change mode
        if (modeRoom.hostId !== userId) return;
        const newMode = msg.mode === "host" ? "host" : "everyone";
        modeRoom.mode = newMode;
        broadcastToRoom(currentRoom, {
          type: "mode-changed",
          mode: newMode,
          fromUser: userName,
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
      const wasHost = room.hostId === userId;
      room.members.delete(userId);

      broadcastToRoom(currentRoom, {
        type: "member-left",
        userId,
        userName,
        memberCount: room.members.size,
      });

      if (room.members.size > 0) {
        // Reassign heartbeat leader
        notifyHeartbeatLeader(room);

        // If the host left, transfer host to next member and switch to everyone mode
        if (wasHost) {
          const nextHostId = room.members.keys().next().value;
          room.hostId = nextHostId;
          room.mode = "everyone";
          broadcastToRoom(currentRoom, {
            type: "mode-changed",
            mode: "everyone",
            fromUser: "System",
          });
          // Notify new host
          const newHost = room.members.get(nextHostId);
          if (newHost) {
            sendTo(newHost.ws, { type: "host-transferred", isHost: true });
          }
        }
      }
      cleanupRoom(currentRoom);
    }
    currentRoom = null;
  }

  ws.on("close", () => {
    totalConnections--;
    const remaining = (connectionsPerIp.get(clientIp) || 1) - 1;
    if (remaining <= 0) connectionsPerIp.delete(clientIp);
    else connectionsPerIp.set(clientIp, remaining);
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

  // Keep-alive: ping self every 13 minutes to prevent Render free tier from sleeping
  const KEEP_ALIVE_INTERVAL = 13 * 60 * 1000;
  setInterval(() => {
    http.get(`http://localhost:${PORT}/health`, (res) => {
      res.resume();
      console.log(`[keep-alive] Pinged at ${new Date().toISOString()}`);
    }).on("error", () => {});
  }, KEEP_ALIVE_INTERVAL);
});
