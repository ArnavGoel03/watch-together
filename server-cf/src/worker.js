// Watch Together — Cloudflare Workers + Durable Objects port
// Single-DO design ("hub") that mirrors the Node server's protocol exactly,
// so the existing extension only needs the WebSocket URL changed.
// Uses the WebSocket Hibernation API so the DO doesn't burn CPU while idle.

// ---------- Configuration ----------
const MAX_ROOM_MEMBERS = 50;
const MAX_ROOMS = 10000;
const ROOM_TTL_MS = 12 * 3600000; // 12h
const MAX_MESSAGE_SIZE = 4096;
const RATE_LIMIT_WINDOW = 1000; // 1s
const RATE_LIMIT_MAX = 20;
const MAX_CHAT_LENGTH = 500;
const MAX_USERNAME_LENGTH = 30;
const MAX_CONNECTIONS_PER_IP = 10;
const MAX_VIDEO_URL_LENGTH = 2000;
const EMPTY_ROOM_GRACE_MS = 60000;
const MAX_VOICE_SIGNAL_BYTES = 8192;

// ---------- Utilities ----------
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateRoomCode(existing) {
  let code;
  do {
    code = "";
    for (let i = 0; i < 6; i++) code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  } while (existing.has(code));
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

// ---------- Worker entry ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Health endpoint — proxied to the DO so the numbers are real
    if (url.pathname === "/health") {
      const stub = env.ROOMS.get(env.ROOMS.idFromName("hub"));
      return stub.fetch(request);
    }

    // Read-only room existence — same as Node server
    if (url.pathname.startsWith("/room/")) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName("hub"));
      return stub.fetch(request);
    }

    // Shareable join link
    if (url.pathname.startsWith("/join/")) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName("hub"));
      return stub.fetch(request);
    }

    // WebSocket upgrade — single-hub DO model
    if (request.headers.get("Upgrade") === "websocket") {
      const stub = env.ROOMS.get(env.ROOMS.idFromName("hub"));
      // Pass through cf-connecting-ip for the per-IP cap
      return stub.fetch(request);
    }

    // Landing page
    return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Watch Together</title>
<style>body{font-family:-apple-system,sans-serif;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{text-align:center}h1{font-size:32px;margin-bottom:8px}p{color:#888}.tag{font-size:11px;color:#a78bfa;margin-top:8px}</style>
</head><body><div class="card"><h1>Watch Together</h1><p>Sync video playback with friends worldwide</p><p class="tag">Cloudflare edge</p></div></body></html>`, {
      headers: { "Content-Type": "text/html", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'self' 'unsafe-inline'" },
    });
  },
};

// ============================================================
// RoomHubDO — single Durable Object holding all rooms.
// Uses WebSocket Hibernation: register WSes with state.acceptWebSocket,
// then implement webSocketMessage / webSocketClose. Per-WS metadata
// (userId, userName, currentRoom) lives in the WS attachment so it
// survives DO hibernation cycles.
// ============================================================
export class RoomHubDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // In-memory caches — rebuilt from storage on cold start.
    this.rooms = null;            // Map<code, room>
    this.connectionsPerIp = new Map();
    this.rateLimits = new Map();  // userId -> { count, resetAt }
    this.bootPromise = this._boot();
  }

  async _boot() {
    // Load rooms from storage. Storage holds room metadata (members are
    // reconstructed from active WebSockets, not persisted by ws ref).
    this.rooms = new Map();
    const stored = await this.state.storage.list({ prefix: "room:" });
    for (const [key, value] of stored) {
      const code = key.slice("room:".length);
      this.rooms.set(code, { ...value, members: new Map(), emptyDeleteTimer: null });
    }
    // Re-attach surviving websockets to their rooms (after a hibernation wake)
    for (const ws of this.state.getWebSockets()) {
      const meta = this._meta(ws);
      if (meta && meta.currentRoom) {
        const room = this.rooms.get(meta.currentRoom);
        if (room) {
          room.members.set(meta.userId, { ws, userName: meta.userName, voiceActive: !!meta.voiceActive });
        }
      }
    }
  }

  // -------- WS attachment helpers --------
  _meta(ws) {
    try { return ws.deserializeAttachment() || {}; } catch { return {}; }
  }
  _setMeta(ws, partial) {
    const cur = this._meta(ws) || {};
    ws.serializeAttachment({ ...cur, ...partial });
  }

  // -------- Room storage helpers --------
  async _persistRoom(code) {
    const room = this.rooms.get(code);
    if (!room) {
      await this.state.storage.delete(`room:${code}`);
      return;
    }
    // Don't persist live ws references or timers
    const { members, emptyDeleteTimer, ...rest } = room;
    await this.state.storage.put(`room:${code}`, rest);
  }
  async _deleteRoomStorage(code) {
    await this.state.storage.delete(`room:${code}`);
  }

  // -------- Broadcast helpers --------
  _broadcast(roomCode, message, excludeWs = null) {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    const data = JSON.stringify(message);
    for (const member of room.members.values()) {
      if (member.ws === excludeWs) continue;
      try { member.ws.send(data); } catch { /* ws closed */ }
    }
  }
  _sendTo(ws, message) {
    try { ws.send(JSON.stringify(message)); } catch { /* closed */ }
  }

  // -------- Rate limit --------
  _checkRate(userId) {
    const now = Date.now();
    const e = this.rateLimits.get(userId);
    if (!e || now > e.resetAt) {
      this.rateLimits.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
      return true;
    }
    e.count++;
    return e.count <= RATE_LIMIT_MAX;
  }

  // -------- Heartbeat leader (first member) --------
  _heartbeatLeader(room) {
    const it = room.members.entries().next();
    return it.done ? null : it.value[0];
  }
  _notifyHeartbeatLeader(room) {
    const leader = this._heartbeatLeader(room);
    if (!leader) return;
    for (const [uid, m] of room.members) {
      this._sendTo(m.ws, { type: "heartbeat-role", isLeader: uid === leader });
    }
  }

  // -------- Empty-room grace --------
  _scheduleEmptyDelete(code) {
    const room = this.rooms.get(code);
    if (!room || room.members.size > 0) return;
    if (room.emptyDeleteTimer) return;
    room.emptyDeleteTimer = setTimeout(() => {
      const r = this.rooms.get(code);
      if (r && r.members.size === 0) {
        this.rooms.delete(code);
        this._deleteRoomStorage(code);
      }
    }, EMPTY_ROOM_GRACE_MS);
  }
  _cancelEmptyDelete(code) {
    const room = this.rooms.get(code);
    if (room && room.emptyDeleteTimer) {
      clearTimeout(room.emptyDeleteTimer);
      room.emptyDeleteTimer = null;
    }
  }

  // -------- HTTP fetch entry --------
  async fetch(request) {
    await this.bootPromise;
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      let totalMembers = 0;
      for (const r of this.rooms.values()) totalMembers += r.members.size;
      let totalConnections = 0;
      for (const ws of this.state.getWebSockets()) totalConnections++;
      return new Response(
        JSON.stringify({ status: "ok", rooms: this.rooms.size, connections: totalConnections, members: totalMembers, runtime: "cloudflare-workers" }),
        { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }

    if (url.pathname.startsWith("/room/")) {
      const code = url.pathname.slice("/room/".length).split("?")[0]?.toUpperCase() || "";
      const room = this.rooms.get(code);
      return new Response(JSON.stringify({ exists: !!room, code }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname.startsWith("/join/")) {
      const parts = url.pathname.slice("/join/".length).split("?");
      const code = parts[0].toUpperCase();
      const room = this.rooms.get(code);
      const memberCount = room ? room.members.size : 0;
      const params = new URLSearchParams(url.search);
      const videoUrl = validateUrl((room && room.videoUrl) ? room.videoUrl : (params.get("url") || ""));
      if (videoUrl) {
        try {
          const r = new URL(videoUrl);
          r.searchParams.set("wt_room", code);
          return Response.redirect(r.toString(), 302);
        } catch { /* fall through */ }
      }
      const safeCode = escapeHtml(code);
      return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Join Watch Together — ${safeCode}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#1c1c1e;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:#2c2c2e;border-radius:16px;padding:44px 36px;max-width:400px;width:90%;text-align:center}h1{font-size:20px;font-weight:700;margin-bottom:4px}.sub{color:rgba(235,235,245,.5);font-size:14px;margin-bottom:24px}.code{font-size:38px;font-weight:800;color:#a78bfa;letter-spacing:8px;margin:12px 0 8px}.st{font-size:13px;font-weight:500;margin-bottom:24px;color:${room ? "#30d158" : "rgba(235,235,245,.4)"}}.err{color:#ff453a;font-size:14px;margin-bottom:20px}.btn{display:block;padding:14px;background:linear-gradient(135deg,#7c3aed,#a78bfa);color:#fff;text-decoration:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;border:none;width:100%;margin-bottom:10px}.hint{font-size:12px;color:rgba(235,235,245,.3);margin-top:16px;line-height:1.6}</style>
</head><body><div class="card"><h1>Watch Together</h1><p class="sub">You've been invited to watch together</p><div class="code">${safeCode}</div><div class="st">${room ? memberCount + " watching now" : "Waiting for host"}</div>${!room ? '<p class="err">Room not found — the host may have left.</p>' : ""}<button class="btn" onclick="navigator.clipboard.writeText('${safeCode}').then(function(){this.textContent='Copied!'}.bind(this))">Copy Room Code</button><p class="hint">Open the video, click Watch Together, and paste this code.</p></div></body></html>`,
        { headers: { "Content-Type": "text/html", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'self' 'unsafe-inline'" } }
      );
    }

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anon";
      const ipCount = (this.connectionsPerIp.get(ip) || 0) + 1;
      if (ipCount > MAX_CONNECTIONS_PER_IP) {
        return new Response("Too many connections", { status: 429 });
      }
      this.connectionsPerIp.set(ip, ipCount);

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Hibernation API — DO can sleep when no messages flow
      this.state.acceptWebSocket(server);
      // Initial attachment for new connections
      this._setMeta(server, {
        userId: generateUserId(),
        userName: "User",
        currentRoom: null,
        ip,
        voiceActive: false,
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not Found", { status: 404 });
  }

  // -------- Hibernation handlers --------
  async webSocketMessage(ws, raw) {
    await this.bootPromise;
    if (typeof raw !== "string") raw = String(raw);
    if (raw.length > MAX_MESSAGE_SIZE) return;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;

    const meta = this._meta(ws);
    if (!this._checkRate(meta.userId)) {
      this._sendTo(ws, { type: "error", message: "Rate limited — slow down" });
      return;
    }

    switch (msg.type) {
      case "create-room": return this._handleCreate(ws, meta, msg);
      case "join-room": return this._handleJoin(ws, meta, msg);
      case "leave-room": return this._handleLeave(ws, meta);
      case "sync": return this._handleSync(ws, meta, msg);
      case "heartbeat": return this._handleHeartbeat(ws, meta, msg);
      case "chat": return this._handleChat(ws, meta, msg);
      case "set-mode": return this._handleSetMode(ws, meta, msg);
      case "navigate": return this._handleNavigate(ws, meta, msg);
      case "voice-state": return this._handleVoiceState(ws, meta, msg);
      case "voice-signal": return this._handleVoiceSignal(ws, meta, msg);
    }
  }

  async webSocketClose(ws /*, code, reason, wasClean */) {
    await this.bootPromise;
    const meta = this._meta(ws);
    // Per-IP counter
    if (meta.ip) {
      const remaining = (this.connectionsPerIp.get(meta.ip) || 1) - 1;
      if (remaining <= 0) this.connectionsPerIp.delete(meta.ip);
      else this.connectionsPerIp.set(meta.ip, remaining);
    }
    await this._leaveCurrentRoom(ws, meta);
  }

  async webSocketError(ws, error) {
    // Treat as close
    return this.webSocketClose(ws);
  }

  // -------- Handlers --------
  async _handleCreate(ws, meta, msg) {
    if (meta.currentRoom) await this._leaveCurrentRoom(ws, meta);
    if (this.rooms.size >= MAX_ROOMS) {
      this._sendTo(ws, { type: "error", message: "Server is at capacity. Try again later." });
      return;
    }
    const code = generateRoomCode(this.rooms);
    const userName = sanitize(msg.userName, MAX_USERNAME_LENGTH) || "User";
    const mode = msg.mode === "host" ? "host" : "everyone";
    const videoUrl = validateUrl(msg.videoUrl);

    const room = {
      code,
      hostId: meta.userId,
      mode,
      members: new Map([[meta.userId, { ws, userName, voiceActive: false }]]),
      videoUrl,
      playbackState: { playing: false, currentTime: 0, playbackRate: 1, lastUpdate: Date.now() },
      createdAt: Date.now(),
      lastActivity: Date.now(),
      emptyDeleteTimer: null,
    };
    this.rooms.set(code, room);
    this._setMeta(ws, { userName, currentRoom: code });
    await this._persistRoom(code);

    this._sendTo(ws, {
      type: "room-created",
      roomCode: code,
      userId: meta.userId,
      mode,
      isHost: true,
      serverTime: Date.now(),
    });
    this._notifyHeartbeatLeader(room);
  }

  async _handleJoin(ws, meta, msg) {
    const code = typeof msg.roomCode === "string" ? msg.roomCode.toUpperCase().trim() : "";
    const room = this.rooms.get(code);
    if (!room) {
      this._sendTo(ws, { type: "error", message: "Room not found" });
      return;
    }
    if (room.members.size >= MAX_ROOM_MEMBERS) {
      this._sendTo(ws, { type: "error", message: `Room is full (max ${MAX_ROOM_MEMBERS})` });
      return;
    }
    if (meta.currentRoom) await this._leaveCurrentRoom(ws, meta);
    this._cancelEmptyDelete(code);

    const userName = sanitize(msg.userName, MAX_USERNAME_LENGTH) || "User";
    room.members.set(meta.userId, { ws, userName, voiceActive: false });
    room.lastActivity = Date.now();
    this._setMeta(ws, { userName, currentRoom: code });
    await this._persistRoom(code);

    this._sendTo(ws, {
      type: "room-joined",
      roomCode: code,
      userId: meta.userId,
      mode: room.mode,
      isHost: meta.userId === room.hostId,
      videoUrl: room.videoUrl || "",
      serverTime: Date.now(),
      playbackState: { ...room.playbackState, timestamp: room.playbackState.lastUpdate, serverTime: Date.now() },
      members: Array.from(room.members.entries()).map(([id, m]) => ({ id, userName: m.userName })),
    });
    this._broadcast(code, {
      type: "member-joined",
      userId: meta.userId,
      userName,
      memberCount: room.members.size,
    }, ws);
    this._notifyHeartbeatLeader(room);
  }

  async _handleLeave(ws, meta) {
    await this._leaveCurrentRoom(ws, meta);
  }

  async _leaveCurrentRoom(ws, meta) {
    const code = meta.currentRoom;
    if (!code) return;
    const room = this.rooms.get(code);
    this._setMeta(ws, { currentRoom: null, voiceActive: false });
    if (!room) return;
    const wasHost = room.hostId === meta.userId;
    const wasVoiceActive = !!(room.members.get(meta.userId)?.voiceActive);
    room.members.delete(meta.userId);

    this._broadcast(code, {
      type: "member-left",
      userId: meta.userId,
      userName: meta.userName,
      memberCount: room.members.size,
    });

    if (wasVoiceActive) {
      this._broadcast(code, {
        type: "voice-state",
        userId: meta.userId,
        userName: meta.userName,
        active: false,
        activeUserIds: Array.from(room.members.entries()).filter(([, m]) => m.voiceActive).map(([id]) => id),
      });
    }

    if (room.members.size > 0) {
      this._notifyHeartbeatLeader(room);
      if (wasHost) {
        const nextHostId = room.members.keys().next().value;
        room.hostId = nextHostId;
        room.mode = "everyone";
        this._broadcast(code, { type: "mode-changed", mode: "everyone", fromUser: "System" });
        const newHost = room.members.get(nextHostId);
        if (newHost) this._sendTo(newHost.ws, { type: "host-transferred", isHost: true });
      }
      await this._persistRoom(code);
    } else {
      // Empty — schedule grace deletion (don't delete now, allow rejoin)
      this._scheduleEmptyDelete(code);
      await this._persistRoom(code);
    }
  }

  _handleSync(ws, meta, msg) {
    const code = meta.currentRoom;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.mode === "host" && room.hostId !== meta.userId) {
      this._sendTo(ws, { type: "error", message: "Only the host can control playback" });
      return;
    }
    const ct = parseFloat(msg.currentTime);
    const pr = parseFloat(msg.playbackRate) || 1;
    if (isNaN(ct) || ct < 0) return;
    if (pr < 0.1 || pr > 16) return;

    room.playbackState = { playing: !!msg.playing, currentTime: ct, playbackRate: pr, lastUpdate: Date.now() };
    room.lastActivity = Date.now();
    this._persistRoom(code); // fire and forget — eventual consistency is fine

    const now = Date.now();
    this._broadcast(code, {
      type: "sync",
      playing: !!msg.playing,
      currentTime: ct,
      playbackRate: pr,
      action: sanitize(msg.action || "", 20),
      fromUser: meta.userName,
      fromUserId: meta.userId,
      timestamp: now,
      serverTime: now,
      isLive: !!msg.isLive,
    }, ws);
  }

  _handleHeartbeat(ws, meta, msg) {
    const code = meta.currentRoom;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) return;
    if (this._heartbeatLeader(room) !== meta.userId) return;

    const ct = parseFloat(msg.currentTime);
    const pr = parseFloat(msg.playbackRate) || 1;
    if (isNaN(ct) || ct < 0) return;

    room.playbackState = { playing: !!msg.playing, currentTime: ct, playbackRate: pr, lastUpdate: Date.now() };
    room.lastActivity = Date.now();

    const now = Date.now();
    this._broadcast(code, {
      type: "heartbeat",
      playing: !!msg.playing,
      currentTime: ct,
      playbackRate: pr,
      fromUserId: meta.userId,
      timestamp: now,
      serverTime: now,
      isLive: !!msg.isLive,
    }, ws);
  }

  _handleChat(ws, meta, msg) {
    const code = meta.currentRoom;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) return;
    const message = sanitize(msg.message, MAX_CHAT_LENGTH);
    if (!message) return;
    room.lastActivity = Date.now();
    this._broadcast(code, {
      type: "chat",
      message,
      userName: meta.userName,
      userId: meta.userId,
      timestamp: Date.now(),
      serverTime: Date.now(),
    }, ws);
  }

  _handleSetMode(ws, meta, msg) {
    const code = meta.currentRoom;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room || room.hostId !== meta.userId) return;
    const newMode = msg.mode === "host" ? "host" : "everyone";
    room.mode = newMode;
    this._persistRoom(code);
    this._broadcast(code, { type: "mode-changed", mode: newMode, fromUser: meta.userName });
  }

  _handleNavigate(ws, meta, msg) {
    const code = meta.currentRoom;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.mode === "host" && room.hostId !== meta.userId) return;
    const newUrl = validateUrl(msg.url);
    if (!newUrl) return;
    if (newUrl === room.videoUrl) return;
    room.videoUrl = newUrl;
    room.playbackState = { playing: false, currentTime: 0, playbackRate: 1, lastUpdate: Date.now() };
    room.lastActivity = Date.now();
    this._persistRoom(code);
    this._broadcast(code, {
      type: "navigate",
      url: newUrl,
      fromUser: meta.userName,
      fromUserId: meta.userId,
      serverTime: Date.now(),
    }, ws);
  }

  _handleVoiceState(ws, meta, msg) {
    const code = meta.currentRoom;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) return;
    const member = room.members.get(meta.userId);
    if (!member) return;
    member.voiceActive = !!msg.active;
    this._setMeta(ws, { voiceActive: member.voiceActive });
    room.lastActivity = Date.now();
    this._broadcast(code, {
      type: "voice-state",
      userId: meta.userId,
      userName: meta.userName,
      active: member.voiceActive,
      activeUserIds: Array.from(room.members.entries()).filter(([, m]) => m.voiceActive).map(([id]) => id),
    });
  }

  _handleVoiceSignal(ws, meta, msg) {
    const code = meta.currentRoom;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) return;
    const targetId = typeof msg.toUserId === "string" ? msg.toUserId : "";
    if (!targetId || targetId === meta.userId) return;
    const target = room.members.get(targetId);
    if (!target) return;
    const signal = msg.signal;
    if (!signal || JSON.stringify(signal).length > MAX_VOICE_SIGNAL_BYTES) return;
    this._sendTo(target.ws, {
      type: "voice-signal",
      fromUserId: meta.userId,
      fromUserName: meta.userName,
      signal,
    });
  }
}
