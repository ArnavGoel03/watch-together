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
// Empty rooms linger for this long so a solo leaver / disconnect can rejoin
// the same code. Override via env for tests.
// 30 minutes, not 60 seconds: closing the tab, restarting the browser, rebooting, or
// riding out a dead wifi stretch all used to destroy the room inside the old window,
// and the party would come back to "Room not found". An empty room costs a Map entry.
const EMPTY_ROOM_GRACE_MS = parseInt(process.env.EMPTY_ROOM_GRACE_MS, 10) || 30 * 60000;
// Persistent (custom-named) rooms get longer TTLs so friends can keep reusing
// the same name for days.
const PERSISTENT_ROOM_TTL_MS = (parseInt(process.env.PERSISTENT_ROOM_TTL_HOURS, 10) || 24 * 30) * 3600000; // 30 days
const PERSISTENT_ROOM_EMPTY_GRACE_MS = parseInt(process.env.PERSISTENT_EMPTY_GRACE_MS, 10) || 7 * 24 * 3600000; // 7 days
const CUSTOM_NAME_REGEX = /^[a-zA-Z0-9-]{4,32}$/;
// The shape generateRoomCode() hands out (no I, O, 0 or 1: they read the same out loud).
const ROOM_CODE_REGEX = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

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

// When a room becomes empty, schedule deletion after a grace window so a
// solo leaver / accidental disconnect can rejoin the same code. The timer
// is canceled by case "join-room" when someone re-enters.
function cleanupRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.members.size > 0) return;
  if (room.emptyDeleteTimer) return; // already scheduled
  const grace = room.persistent ? PERSISTENT_ROOM_EMPTY_GRACE_MS : EMPTY_ROOM_GRACE_MS;
  room.emptyDeleteTimer = setTimeout(() => {
    const r = rooms.get(roomCode);
    if (r && r.members.size === 0) {
      rooms.delete(roomCode);
      console.log(`[cleanup] Room ${roomCode} deleted after ${grace}ms grace. Active rooms: ${rooms.size}`);
    }
  }, grace);
  console.log(`[cleanup] Room ${roomCode} empty - deletion scheduled in ${grace}ms (persistent=${!!room.persistent})`);
}

// Elect heartbeat leader - the first member in the room.
// Only this user sends heartbeats to avoid N^2 broadcast storm.
function getHeartbeatLeader(room) {
  const firstEntry = room.members.entries().next();
  if (firstEntry.done) return null;
  return firstEntry.value[0]; // userId
}

// The leader drives everyone else's drift correction, so a leader who has gone quiet is a
// room that has quietly stopped syncing. It happens: their tab is mid-ad (we deliberately
// stay silent through our own ads), their page never loaded a video, their tab froze.
// Nobody notices, because nothing errors. So take the job away and give it to someone who
// is actually watching.
// Three missed beats at a 5s heartbeat. Configurable so tests do not have to sit
// through fifteen real seconds to prove the handoff happens.
const LEADER_STALE_MS = parseInt(process.env.LEADER_STALE_MS, 10) || 15000;
const LEADER_SWEEP_MS = parseInt(process.env.LEADER_SWEEP_MS, 10) || 5000;

function rotateStaleLeaders() {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.members.size < 2) continue; // nobody to hand it to
    const since = now - (room.lastHeartbeatAt || room.createdAt || now);
    if (since <= LEADER_STALE_MS) continue;

    const leaderId = getHeartbeatLeader(room);
    if (!leaderId) continue;

    // The leader is whoever sits first in the member map, so demote by moving them to the
    // back of the queue. The next member up inherits the job.
    const demoted = room.members.get(leaderId);
    room.members.delete(leaderId);
    room.members.set(leaderId, demoted);

    // Reset the clock, or a room where nobody can heartbeat would rotate on every sweep.
    room.lastHeartbeatAt = now;
    console.log(`[room] ${room.code} sync leader was silent for ${Math.round(since / 1000)}s, handing off`);
    notifyHeartbeatLeader(room);
  }
}
setInterval(rotateStaleLeaders, LEADER_SWEEP_MS);

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
    // Defensive sweep for empty rooms older than 5 minutes that somehow
    // escaped the grace timer (e.g. timer never set on legacy state).
    // Only act when no grace timer is pending so we don't undercut it.
    if (room.members.size === 0 && !room.emptyDeleteTimer && now - room.createdAt > 300000) {
      rooms.delete(code);
      cleaned++;
      continue;
    }
    // Remove rooms older than TTL regardless. Persistent (named) rooms get
    // a much longer ceiling so friends can keep reusing the same name.
    const ttl = room.persistent ? PERSISTENT_ROOM_TTL_MS : ROOM_TTL_MS;
    if (now - room.lastActivity > ttl) {
      // Notify remaining members
      broadcastToRoom(code, {
        type: "error",
        message: "Room expired due to inactivity",
      });
      // Close all member connections gracefully
      for (const member of room.members.values()) {
        member.ws.close(4001, "Room expired");
      }
      if (room.emptyDeleteTimer) clearTimeout(room.emptyDeleteTimer);
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
<title>Join Watch Together - ${safeCode}</title>
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
  ${!roomExists ? '<p class="err">Room not found - the host may have left.</p>' : ""}
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
    // Only expose minimal info - no videoUrl, no exact member count
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
      sendTo(ws, { type: "error", message: "Rate limited - slow down" });
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

        // Optional custom room name - makes the room "persistent" with a longer
        // TTL so friends can keep reusing the same name for days.
        let roomCode;
        let persistent = false;
        if (typeof msg.customName === "string" && msg.customName.trim()) {
          const raw = msg.customName.trim();
          if (!CUSTOM_NAME_REGEX.test(raw)) {
            sendTo(ws, { type: "error", message: "Room name must be 4-32 letters, numbers, or hyphens" });
            return;
          }
          const candidate = raw.toUpperCase();
          if (rooms.has(candidate)) {
            sendTo(ws, { type: "error", message: "That room name is taken - try joining instead" });
            return;
          }
          roomCode = candidate;
          persistent = true;
        } else {
          roomCode = generateRoomCode();
        }

        userName = sanitize(msg.userName, MAX_USERNAME_LENGTH) || "User";

        const videoUrl = validateUrl(msg.videoUrl);

        // mode: "everyone" (default) or "host" (only creator controls)
        const mode = msg.mode === "host" ? "host" : "everyone";

        const room = {
          code: roomCode,
          hostId: userId,
          mode,
          persistent,
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
          persistent,
          isHost: true,
          serverTime: Date.now(),
        });

        notifyHeartbeatLeader(room);
        console.log(`[room] ${roomCode} created by ${userName}. Active rooms: ${rooms.size}`);
        break;
      }

      case "join-room": {
        const code = typeof msg.roomCode === "string" ? msg.roomCode.toUpperCase().trim() : "";
        let room = rooms.get(code);

        // Rooms live in memory, so a server restart (on a free tier, an idle spin-down is
        // routine) wipes every one of them and a happily-watching party would all get
        // "Room not found" at once. A client that is REJOINING a room it was already in
        // may rebuild it: it replays the code and the last playback position it saw, and
        // the party carries on. Knowing the code is already the only credential this
        // system has, so rebuilding with it grants nothing that joining would not.
        //
        // Only auto-rejoins set recreateIfMissing. A human typing an unknown code still
        // gets a clean "Room not found" rather than silently landing in an empty room.
        if (!room && msg.recreateIfMissing === true && code) {
          if (rooms.size >= MAX_ROOMS) {
            sendTo(ws, { type: "error", message: "Server is at capacity. Try again later." });
            return;
          }

          // A rebuilt room has to look like a room we could have handed out in the first
          // place: either a generated code or a valid custom name. Otherwise a client could
          // key a room by any 4KB string it liked.
          if (!ROOM_CODE_REGEX.test(code) && !CUSTOM_NAME_REGEX.test(code)) {
            sendTo(ws, { type: "error", message: "Room not found" });
            return;
          }

          const seed = msg.resumeState && typeof msg.resumeState === "object" ? msg.resumeState : {};
          const seedTime = parseFloat(seed.currentTime);
          const seedRate = parseFloat(seed.playbackRate);

          room = {
            code,
            hostId: userId, // whoever gets back first steers until the room settles
            mode: msg.mode === "host" ? "host" : "everyone",
            persistent: CUSTOM_NAME_REGEX.test(code),
            members: new Map(),
            videoUrl: validateUrl(msg.videoUrl),
            playbackState: {
              playing: !!seed.playing,
              // isFinite, not isNaN: parseFloat("Infinity") is a number, and handing that
              // back to a real client would set video.currentTime = Infinity.
              currentTime: !isFinite(seedTime) || seedTime < 0 ? 0 : seedTime,
              playbackRate: !isFinite(seedRate) || seedRate < 0.1 || seedRate > 16 ? 1 : seedRate,
              lastUpdate: Date.now(),
            },
            createdAt: Date.now(),
            lastActivity: Date.now(),
          };
          rooms.set(code, room);
          console.log(`[room] ${code} rebuilt after restart by ${sanitize(msg.userName, MAX_USERNAME_LENGTH) || "User"}`);
        }

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

        // The room may be in the empty-room grace window - cancel the
        // pending deletion since someone is rejoining.
        if (room.emptyDeleteTimer) {
          clearTimeout(room.emptyDeleteTimer);
          room.emptyDeleteTimer = null;
          console.log(`[cleanup] Room ${code} grace deletion canceled - rejoined by ${msg.userName || "User"}`);
        }

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
          persistent: !!room.persistent,
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
        rm.lastHeartbeatAt = Date.now(); // the leader is alive and watching

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

      // Authoritative state on demand. Backs session resume (a reloaded tab catches up
      // instantly instead of drifting until the next heartbeat) and manual resync.
      // Read-only: it never mutates room.playbackState, so a stale client cannot
      // rewind everyone else by asking where the room is.
      case "request-state": {
        if (!currentRoom) return;
        const rs = rooms.get(currentRoom);
        if (!rs) return;

        const st = rs.playbackState;
        const rsNow = Date.now();
        sendTo(ws, {
          type: "sync",
          action: "resync",
          playing: !!st.playing,
          currentTime: st.currentTime,
          playbackRate: st.playbackRate,
          videoUrl: rs.videoUrl || "",
          timestamp: st.lastUpdate,
          serverTime: rsNow,
        });
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
        // Reset playback state - we're on a different video now
        navRoom.playbackState = {
          playing: false,
          currentTime: 0,
          playbackRate: 1,
          lastUpdate: Date.now(),
        };
        navRoom.lastActivity = Date.now();
        // Echo to the sender too, not just the others. If two people switch apps at the same
        // instant, each sends a different url; the server settles them in one order and this
        // reaches everyone in that same order, so the last url wins for the whole room. The
        // sender of the losing url gets the winning one back (its own current page) and its
        // content script cancels the redirect the losing url had queued. Excluding the sender
        // is what used to leave that person stranded on a video the room had already moved off.
        broadcastToRoom(currentRoom, {
          type: "navigate",
          url: newUrl,
          fromUser: userName,
          fromUserId: userId,
          serverTime: Date.now(),
        });
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

      case "chat-typing": {
        // Pure relay - no persistence. Tells other clients "{userName} is typing".
        if (!currentRoom) return;
        const r = rooms.get(currentRoom);
        if (!r) return;
        broadcastToRoom(currentRoom, {
          type: "chat-typing",
          userId,
          userName,
          isTyping: !!msg.isTyping,
        }, ws);
        break;
      }

      case "cc-state": {
        // Pure relay - peer's CC toggle so we can show a presence toast.
        if (!currentRoom) return;
        const r = rooms.get(currentRoom);
        if (!r) return;
        broadcastToRoom(currentRoom, {
          type: "cc-state",
          userId,
          userName,
          active: !!msg.active,
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

      // ---------- Voice chat (WebRTC mesh) ----------
      // Server is purely a signaling relay - actual audio flows peer-to-peer.

      case "voice-state": {
        // Member toggled their mic on/off. Track state and broadcast.
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        const member = room.members.get(userId);
        if (!member) return;
        member.voiceActive = !!msg.active;
        room.lastActivity = Date.now();
        broadcastToRoom(currentRoom, {
          type: "voice-state",
          userId,
          userName,
          active: member.voiceActive,
          activeUserIds: Array.from(room.members.entries())
            .filter(([, m]) => m.voiceActive)
            .map(([id]) => id),
        });
        break;
      }

      case "voice-signal": {
        // Relay an SDP offer/answer or ICE candidate to a single target user.
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        const targetId = typeof msg.toUserId === "string" ? msg.toUserId : "";
        if (!targetId || targetId === userId) return;
        const target = room.members.get(targetId);
        if (!target) return;
        // Cap signal payload size - SDP is small, ICE smaller, anything huge is malformed
        const signal = msg.signal;
        if (!signal || JSON.stringify(signal).length > 8192) return;
        sendTo(target.ws, {
          type: "voice-signal",
          fromUserId: userId,
          fromUserName: userName,
          signal,
        });
        break;
      }
    }
  });

  function leaveCurrentRoom() {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) {
      const wasHost = room.hostId === userId;
      const wasVoiceActive = !!(room.members.get(userId)?.voiceActive);
      room.members.delete(userId);

      broadcastToRoom(currentRoom, {
        type: "member-left",
        userId,
        userName,
        memberCount: room.members.size,
      });

      // If they were in voice, tell remaining voice peers to tear down their RTCPeerConnection
      if (wasVoiceActive) {
        broadcastToRoom(currentRoom, {
          type: "voice-state",
          userId,
          userName,
          active: false,
          activeUserIds: Array.from(room.members.entries())
            .filter(([, m]) => m.voiceActive)
            .map(([id]) => id),
        });
      }

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
