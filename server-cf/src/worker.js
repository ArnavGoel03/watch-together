// Watch Together - Cloudflare Workers + Durable Objects port
// Single-DO design ("hub") that mirrors the Node server's protocol exactly,
// so the existing extension only needs the WebSocket URL changed.
// Uses the WebSocket Hibernation API so the DO doesn't burn CPU while idle.

// ---------- Configuration ----------
// Kept in lockstep with the Node twin and extension/config.js.
const PROTOCOL_VERSION = 1;
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
// 30 minutes, matching the Node server. It was 60 seconds here long after the Node twin
// was deliberately widened, because closing a tab, restarting the browser or riding out a
// dead wifi stretch all took longer than a minute and the party came back to "Room not
// found". An empty room costs one storage key.
const EMPTY_ROOM_GRACE_MS = 30 * 60000;
const PERSISTENT_ROOM_TTL_MS = 30 * 24 * 3600000; // 30 days for named rooms
const PERSISTENT_ROOM_EMPTY_GRACE_MS = 7 * 24 * 3600000; // 7 days
const MAX_VOICE_SIGNAL_BYTES = 8192;
const CUSTOM_NAME_REGEX = /^[a-zA-Z0-9-]{4,32}$/;
// The shape generateRoomCode() hands out (no I, O, 0 or 1: they read the same out loud).
const ROOM_CODE_REGEX = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

// A host token is an HMAC of the room code, so a room that has to be rebuilt can still
// prove who its host was without the object having remembered anything. Set
// HOST_TOKEN_SECRET as a Worker secret to make that survive a redeploy; without it, host
// is simply never restored on a rebuild, which is the safe direction to fail.
export async function mintHostToken(secret, roomCode) {
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(roomCode)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function isValidHostToken(secret, roomCode, token) {
  if (!secret || typeof token !== "string" || token.length !== 64) return false;
  const expected = await mintHostToken(secret, roomCode);
  if (!expected || expected.length !== token.length) return false;
  // Constant time: a check that leaks its answer through timing is not a check.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

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

    // Health endpoint - proxied to the DO so the numbers are real
    if (url.pathname === "/health") {
      const stub = env.ROOMS.get(env.ROOMS.idFromName("hub"));
      return stub.fetch(request);
    }

    // Read-only room existence - same as Node server
    if (url.pathname.startsWith("/room/")) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName("hub"));
      return stub.fetch(request);
    }

    // Shareable join link
    if (url.pathname.startsWith("/join/")) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName("hub"));
      return stub.fetch(request);
    }

    // WebSocket upgrade - single-hub DO model
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
// RoomHubDO - single Durable Object holding all rooms.
// Uses WebSocket Hibernation: register WSes with state.acceptWebSocket,
// then implement webSocketMessage / webSocketClose. Per-WS metadata
// (userId, userName, currentRoom) lives in the WS attachment so it
// survives DO hibernation cycles.
// ============================================================
// Three missed beats at a 5s heartbeat.
const LEADER_STALE_MS = 15000;
const LEADER_SWEEP_MS = 5000;

export class RoomHubDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // In-memory caches - rebuilt from storage on cold start.
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
      // The heartbeat clock is now persisted (throttled) by the heartbeat handler itself,
      // so a wake can restore the real one. Resetting it to now() on every wake, which is
      // what this used to do, meant the watchdog could never fire in the one situation it
      // exists for: a frozen leader keeps the room quiet, quiet lets the object hibernate,
      // and every alarm woke up to a clock that had just been zeroed. Fall back to now()
      // only when the room has never recorded a beat at all.
      this.rooms.set(code, {
        ...value,
        members: new Map(),
        emptyDeleteTimer: null,
        lastHeartbeatAt: typeof value.lastHeartbeatAt === "number" ? value.lastHeartbeatAt : Date.now(),
      });
    }
    // Re-attach surviving websockets to their rooms (after a hibernation wake)
    for (const ws of this.state.getWebSockets()) {
      const meta = this._meta(ws);
      // The per-IP connection cap lived only in memory, so every hibernation handed the
      // same address a fresh allowance of ten. Rebuild the census from the sockets that
      // actually survived.
      if (meta && meta.ip) {
        this.connectionsPerIp.set(meta.ip, (this.connectionsPerIp.get(meta.ip) || 0) + 1);
      }
      if (meta && meta.currentRoom) {
        const room = this.rooms.get(meta.currentRoom);
        if (room) {
          room.members.set(meta.userId, { ws, userName: meta.userName, voiceActive: !!meta.voiceActive });
        }
      }
    }

    // A setTimeout cannot survive hibernation, so any room that was counting down its
    // grace window when the object went to sleep woke up with no timer and nothing to
    // ever set one again: it stayed in storage forever, counting against MAX_ROOMS. Re-arm
    // on the way back, and sweep anything already past its deadline.
    this._sweepExpiredRooms();
    for (const [code, room] of this.rooms) {
      if (room.members.size === 0) this._scheduleEmptyDelete(code);
    }
  }

  // The Node server runs this on an interval. Here it rides the same alarm as the leader
  // watchdog, because an alarm is the only timer that outlives hibernation.
  _sweepExpiredRooms() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const ttl = room.persistent ? PERSISTENT_ROOM_TTL_MS : ROOM_TTL_MS;
      if (now - (room.lastActivity || room.createdAt || now) <= ttl) continue;
      this._broadcast(code, { type: "error", message: "Room expired due to inactivity" });
      for (const member of room.members.values()) {
        try { member.ws.close(4001, "Room expired"); } catch {}
      }
      if (room.emptyDeleteTimer) clearTimeout(room.emptyDeleteTimer);
      this.rooms.delete(code);
      this._deleteRoomStorage(code);
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
    // Strip what must never be persisted: live socket handles, a timer id, and our own
    // write-throttle bookkeeping.
    const { members: _members, emptyDeleteTimer: _timer, lastPersistAt: _lastPersist, ...rest } = room;
    room.lastPersistAt = Date.now();
    await this.state.storage.put(`room:${code}`, rest);
  }

  // Dragging a scrub bar produces a sync per frame of the drag, and every one of them used
  // to be a Durable Object storage write. The state being saved is only a resume hint, so
  // paying for the last one within a second or two is enough.
  _persistRoomThrottled(code, minIntervalMs = 2000) {
    const room = this.rooms.get(code);
    if (!room) return;
    if (Date.now() - (room.lastPersistAt || 0) < minIntervalMs) return;
    this._persistRoom(code);
  }
  async _deleteRoomStorage(code) {
    await this.state.storage.delete(`room:${code}`);
  }

  // -------- Broadcast helpers --------
  _broadcast(roomCode, message, excludeWs = null) {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    const data = JSON.stringify({ v: PROTOCOL_VERSION, ...message });
    for (const member of room.members.values()) {
      if (member.ws === excludeWs) continue;
      try { member.ws.send(data); } catch { /* ws closed */ }
    }
  }
  _sendTo(ws, message) {
    try { ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...message })); } catch { /* closed */ }
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
    // First member in order whose socket is actually open. Promoting a dead socket makes
    // the room go quiet with nobody able to notice until the next sweep.
    for (const [uid, m] of room.members) {
      if (m.ws && m.ws.readyState === 1 /* WebSocket.OPEN */) return uid;
    }
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

  // -------- Stale sync-leader watchdog --------
  // The leader is the only member who broadcasts position, so if they go quiet (an ad on
  // their side, a frozen tab, a sleeping laptop) the whole room silently loses drift
  // correction. Nobody else is talking either, so there is no message to hang this check
  // off: it runs on a DO alarm, which is the only timer that survives hibernation.
  _rotateStaleLeaders() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.members.size < 2) continue; // nobody to hand it to
      // A paused room's leader deliberately stops beating: there is no position to
      // correct. Silence is correct behaviour there, not a frozen tab.
      if (!room.playbackState || !room.playbackState.playing) continue;
      const since = now - (room.lastHeartbeatAt || room.createdAt || now);
      if (since <= LEADER_STALE_MS) continue;
      const leaderId = this._heartbeatLeader(room);
      if (!leaderId) continue;
      // The leader is whoever sits first in the member map, so demote by moving them to
      // the back of the queue. The next member up inherits the job.
      const demoted = room.members.get(leaderId);
      room.members.delete(leaderId);
      room.members.set(leaderId, demoted);
      // Reset the clock, or a room where nobody can heartbeat would rotate every sweep.
      room.lastHeartbeatAt = now;
      this._notifyHeartbeatLeader(room);
    }
  }

  async _scheduleLeaderSweep() {
    // Wake for a leader handoff, and also while any room is still alive at all, because
    // the same alarm carries the room expiry sweep and the dead-socket reaper.
    let needed = false;
    for (const room of this.rooms.values()) {
      if (room.members.size >= 1) { needed = true; break; }
    }
    if (!needed) return;
    const existing = await this.state.storage.getAlarm();
    if (existing !== null) return; // one sweep in flight is enough
    await this.state.storage.setAlarm(Date.now() + LEADER_SWEEP_MS);
  }

  async alarm() {
    await this.bootPromise;
    this._reapDeadSockets();
    this._rotateStaleLeaders();
    this._sweepExpiredRooms();
    await this._scheduleLeaderSweep();
  }

  // The Node server terminates a socket that misses a pong. There is no ping/pong to hang
  // that off here, so a member whose laptop lid closed with no clean close frame stayed in
  // the room forever: inflating every member count, holding a slot against the room cap,
  // and sitting in the heartbeat-leader queue as a candidate who can never beat.
  _reapDeadSockets() {
    for (const [code, room] of this.rooms) {
      let removed = false;
      for (const [uid, member] of Array.from(room.members)) {
        const open = member.ws && member.ws.readyState === 1 /* WebSocket.OPEN */;
        if (open) continue;
        room.members.delete(uid);
        removed = true;
        this._broadcast(code, {
          type: "member-left",
          userId: uid,
          userName: member.userName,
          memberCount: room.members.size,
        });
      }
      if (!removed) continue;
      if (room.members.size > 0) this._notifyHeartbeatLeader(room);
      else this._scheduleEmptyDelete(code);
    }
  }

  // -------- Empty-room grace --------
  _scheduleEmptyDelete(code) {
    const room = this.rooms.get(code);
    if (!room || room.members.size > 0) return;
    if (room.emptyDeleteTimer) return;
    const grace = room.persistent ? PERSISTENT_ROOM_EMPTY_GRACE_MS : EMPTY_ROOM_GRACE_MS;
    room.emptyDeleteTimer = setTimeout(() => {
      const r = this.rooms.get(code);
      if (r && r.members.size === 0) {
        this.rooms.delete(code);
        this._deleteRoomStorage(code);
      }
    }, grace);
    // Workers has no unref; Node does, and a pending 30-minute timer there holds the event
    // loop open forever, which is the difference between a test suite that finishes and one
    // that hangs. Harmless where it does not exist.
    if (typeof room.emptyDeleteTimer?.unref === "function") room.emptyDeleteTimer.unref();
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
      for (const _ of this.state.getWebSockets()) totalConnections++;
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
      const rawCode = decodeURIComponent(parts[0] || "").toUpperCase();
      // Anything that is not a code we could have issued is not a code. Without this the
      // path segment reaches the page below, and escapeHtml is the wrong tool for the JS
      // attribute it used to land in: an HTML attribute decodes &#39; back to a real
      // apostrophe before its JavaScript is compiled, so escaping never contained it.
      const code = ROOM_CODE_REGEX.test(rawCode) || CUSTOM_NAME_REGEX.test(rawCode) ? rawCode : "";
      if (!code) {
        return new Response(
          '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Watch Together</title></head><body style="font-family:-apple-system,sans-serif;background:#1c1c1e;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><p>That is not a valid room code.</p></body></html>',
          { status: 404, headers: { "Content-Type": "text/html", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'" } }
        );
      }
      const room = this.rooms.get(code);
      const memberCount = room ? room.members.size : 0;
      // Only ever redirect to the URL the ROOM is on. Honouring ?url= made this an open
      // redirect on our own origin: a link that sends someone to an attacker's page with
      // our domain doing the sending. Still accepted and ignored, so old links work.
      const videoUrl = validateUrl(room && room.videoUrl ? room.videoUrl : "");
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
<title>Join Watch Together - ${safeCode}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#1c1c1e;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:#2c2c2e;border-radius:16px;padding:44px 36px;max-width:400px;width:90%;text-align:center}h1{font-size:20px;font-weight:700;margin-bottom:4px}.sub{color:rgba(235,235,245,.5);font-size:14px;margin-bottom:24px}.code{font-size:38px;font-weight:800;color:#a78bfa;letter-spacing:8px;margin:12px 0 8px}.st{font-size:13px;font-weight:500;margin-bottom:24px;color:${room ? "#30d158" : "rgba(235,235,245,.4)"}}.err{color:#ff453a;font-size:14px;margin-bottom:20px}.btn{display:block;padding:14px;background:linear-gradient(135deg,#7c3aed,#a78bfa);color:#fff;text-decoration:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;border:none;width:100%;margin-bottom:10px}.hint{font-size:12px;color:rgba(235,235,245,.3);margin-top:16px;line-height:1.6}</style>
</head><body><div class="card"><h1>Watch Together</h1><p class="sub">You've been invited to watch together</p><div class="code">${safeCode}</div><div class="st">${room ? memberCount + " watching now" : "Waiting for host"}</div>${!room ? '<p class="err">Room not found - the host may have left.</p>' : ""}<p class="hint">Select the code above, then open your video, click Watch Together in the toolbar, and paste it in.</p></div></body></html>`,
        {
          headers: {
            "Content-Type": "text/html",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            // No inline JavaScript on this page any more, so scripts get nothing at all.
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
          },
        }
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
      // Hibernation API - DO can sleep when no messages flow
      this.state.acceptWebSocket(server);
      // Initial attachment for new connections
      this._setMeta(server, {
        userId: generateUserId(),
        userName: "User",
        currentRoom: null,
        ip,
        voiceActive: false,
      });

      // Same migration switch as the Node twin: set SERVER_MOVED_URL as a Worker secret and
      // every connecting client walks itself to the replacement relay, with no store
      // release. Sent first so a migrating client spends as little time here as possible.
      const movedTo = (this.env.SERVER_MOVED_URL || "").trim();
      if (/^wss:\/\/[^\s]+$/i.test(movedTo)) {
        this._sendTo(server, { type: "server-moved", url: movedTo });
      }

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
      this._sendTo(ws, { type: "error", message: "Rate limited - slow down" });
      return;
    }

    switch (msg.type) {
      case "create-room": return this._handleCreate(ws, meta, msg);
      case "join-room": return this._handleJoin(ws, meta, msg);
      case "leave-room": return this._handleLeave(ws, meta);
      case "sync": return this._handleSync(ws, meta, msg);
      case "heartbeat": return this._handleHeartbeat(ws, meta, msg);
      case "request-state": return this._handleRequestState(ws, meta);
      case "chat": return this._handleChat(ws, meta, msg);
      case "chat-typing": return this._handleChatTyping(ws, meta, msg);
      case "cc-state": return this._handleCcState(ws, meta, msg);
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

    let code;
    let persistent = false;
    if (typeof msg.customName === "string" && msg.customName.trim()) {
      const raw = msg.customName.trim();
      if (!CUSTOM_NAME_REGEX.test(raw)) {
        this._sendTo(ws, { type: "error", message: "Room name must be 4-32 letters, numbers, or hyphens" });
        return;
      }
      const candidate = raw.toUpperCase();
      if (this.rooms.has(candidate)) {
        this._sendTo(ws, { type: "error", message: "That room name is taken - try joining instead" });
        return;
      }
      code = candidate;
      persistent = true;
    } else {
      code = generateRoomCode(this.rooms);
    }

    const userName = sanitize(msg.userName, MAX_USERNAME_LENGTH) || "User";
    const mode = msg.mode === "host" ? "host" : "everyone";
    const videoUrl = validateUrl(msg.videoUrl);

    const room = {
      code,
      hostId: meta.userId,
      mode,
      persistent,
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
      persistent,
      isHost: true,
      // Replayed on every rejoin so a reload does not cost the host their own room.
      hostToken: await mintHostToken(this.env.HOST_TOKEN_SECRET, code),
      serverTime: Date.now(),
    });
    this._notifyHeartbeatLeader(room);
  }

  async _handleJoin(ws, meta, msg) {
    const code = typeof msg.roomCode === "string" ? msg.roomCode.toUpperCase().trim() : "";
    let room = this.rooms.get(code);

    // Rooms live in the DO's in-memory cache, so a cold start between requests can lose
    // one before storage is reloaded. A client that is REJOINING a room it was already in
    // may rebuild it: it replays the code and the last playback position it saw, and the
    // party carries on. Knowing the code is already the only credential this system has,
    // so rebuilding with it grants nothing that joining would not.
    //
    // Only auto-rejoins set recreateIfMissing. A human typing an unknown code still gets a
    // clean "Room not found" rather than silently landing in an empty room.
    if (!room && msg.recreateIfMissing === true && code) {
      if (this.rooms.size >= MAX_ROOMS) {
        this._sendTo(ws, { type: "error", message: "Server is at capacity. Try again later." });
        return;
      }

      // A rebuilt room has to look like a room we could have handed out in the first
      // place: either a generated code or a valid custom name. Otherwise a client could
      // key a room by any string it liked.
      if (!ROOM_CODE_REGEX.test(code) && !CUSTOM_NAME_REGEX.test(code)) {
        this._sendTo(ws, { type: "error", message: "Room not found" });
        return;
      }

      const rebuildIsHost = await isValidHostToken(this.env.HOST_TOKEN_SECRET, code, msg.hostToken);
      const seed = msg.resumeState && typeof msg.resumeState === "object" ? msg.resumeState : {};
      const seedTime = parseFloat(seed.currentTime);
      const seedRate = parseFloat(seed.playbackRate);

      room = {
        code,
        // Rebuilding is not the same as being the host. Anyone who knows the code can ask
        // for a rebuild, and there is nothing left to check them against but a token this
        // Worker itself issued. Without one, a stranger who waited for a party to go quiet
        // could come back as its exclusive controller.
        hostId: rebuildIsHost ? meta.userId : null,
        mode: msg.mode === "host" ? "host" : "everyone",
        persistent: CUSTOM_NAME_REGEX.test(code),
        members: new Map(),
        videoUrl: validateUrl(msg.videoUrl),
        playbackState: {
          playing: !!seed.playing,
          // isFinite, not isNaN: parseFloat("Infinity") is a number, and handing that back
          // to a real client would set video.currentTime = Infinity.
          currentTime: !isFinite(seedTime) || seedTime < 0 ? 0 : seedTime,
          playbackRate: !isFinite(seedRate) || seedRate < 0.1 || seedRate > 16 ? 1 : seedRate,
          lastUpdate: Date.now(),
        },
        createdAt: Date.now(),
        lastActivity: Date.now(),
        emptyDeleteTimer: null,
      };
      this.rooms.set(code, room);
    }

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
    // Same person, new connection: reloading the tab used to make the host a guest in
    // their own party, because every reconnect gets a fresh user id.
    const reclaimsHost = await isValidHostToken(this.env.HOST_TOKEN_SECRET, code, msg.hostToken);
    if (reclaimsHost) room.hostId = meta.userId;
    if (room.hostId === null || room.hostId === undefined) room.hostId = meta.userId;
    room.members.set(meta.userId, { ws, userName, voiceActive: false });
    room.lastActivity = Date.now();
    this._setMeta(ws, { userName, currentRoom: code });
    await this._persistRoom(code);

    this._sendTo(ws, {
      type: "room-joined",
      roomCode: code,
      userId: meta.userId,
      mode: room.mode,
      persistent: !!room.persistent,
      isHost: meta.userId === room.hostId,
      hostToken: reclaimsHost ? await mintHostToken(this.env.HOST_TOKEN_SECRET, code) : undefined,
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
    // The room now has someone to hand the job to, so start watching the leader.
    await this._scheduleLeaderSweep();
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
      // Empty - schedule grace deletion (don't delete now, allow rejoin)
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
    // isFinite, not isNaN. parseFloat("Infinity") is a number and isNaN(Infinity) is false,
    // so an isNaN guard relays it to every peer, where video.currentTime = Infinity breaks
    // the player. The rebuild path below already knew this; the live path did not.
    if (!isFinite(ct) || ct < 0) return;
    if (!isFinite(pr) || pr < 0.1 || pr > 16) return;

    room.playbackState = { playing: !!msg.playing, currentTime: ct, playbackRate: pr, lastUpdate: Date.now() };
    room.lastActivity = Date.now();
    // Throttled: dragging a scrub bar is one of these per frame, and every one was a
    // Durable Object storage write. What is being saved is only a resume hint.
    this._persistRoomThrottled(code);

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
    if (!isFinite(ct) || ct < 0) return;
    if (!isFinite(pr) || pr < 0.1 || pr > 16) return;

    room.playbackState = { playing: !!msg.playing, currentTime: ct, playbackRate: pr, lastUpdate: Date.now() };
    room.lastActivity = Date.now();
    room.lastHeartbeatAt = Date.now(); // the leader is alive and watching
    // The watchdog reads this clock after a hibernation wake, so it has to reach storage.
    // Throttled, because a beat lands every 5 seconds per room and the value only needs to
    // be accurate to well inside LEADER_STALE_MS.
    this._persistRoomThrottled(code, 10000);

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

  // Authoritative state on demand. Backs session resume (a reloaded tab catches up
  // instantly instead of drifting until the next heartbeat) and manual resync.
  // Read-only: it never mutates room.playbackState, so a stale client cannot rewind
  // everyone else by asking where the room is. Replies only to the asking socket.
  _handleRequestState(ws, meta) {
    const code = meta.currentRoom;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) return;

    const st = room.playbackState;
    const now = Date.now();
    this._sendTo(ws, {
      type: "sync",
      action: "resync",
      playing: !!st.playing,
      currentTime: st.currentTime,
      playbackRate: st.playbackRate,
      videoUrl: room.videoUrl || "",
      timestamp: st.lastUpdate,
      serverTime: now,
    });
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

  _handleChatTyping(ws, meta, msg) {
    const code = meta.currentRoom;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) return;
    this._broadcast(code, {
      type: "chat-typing",
      userId: meta.userId,
      userName: meta.userName,
      isTyping: !!msg.isTyping,
    }, ws);
  }

  _handleCcState(ws, meta, msg) {
    const code = meta.currentRoom;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) return;
    this._broadcast(code, {
      type: "cc-state",
      userId: meta.userId,
      userName: meta.userName,
      active: !!msg.active,
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
    // Echo to the sender too (see the Node server's navigate handler): when two people switch
    // apps at once, delivering every navigate to everyone in one settled order lets the last
    // url win for the whole room, and the loser cancels its queued redirect instead of
    // stranding there.
    this._broadcast(code, {
      type: "navigate",
      url: newUrl,
      fromUser: meta.userName,
      fromUserId: meta.userId,
      serverTime: Date.now(),
    });
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
