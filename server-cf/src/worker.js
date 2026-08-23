// Watch Together - Cloudflare Workers + Durable Objects port
// Single-DO design ("hub") that mirrors the Node server's protocol exactly,
// so the existing extension only needs the WebSocket URL changed.
// Uses the WebSocket Hibernation API so the DO doesn't burn CPU while idle.

// ---------- Configuration ----------
// Every value below is READ from the shared protocol definition, not restated here.
//
// This file used to carry its own copy of all of them, "kept in lockstep with the Node
// twin" by hand. They were not in lockstep. This relay, which is the one production runs,
// was missing the host-mode heartbeat check, the ad-flag reset, the dead-socket filter in
// the ad-freeze test and the room-creation budget entirely, and nothing anywhere could
// have told you: two files that agree by hand only look like they agree.
import P from "../../shared/protocol.cjs";

const PROTOCOL_VERSION = 1;
const PRESENCE_STATES = P.PRESENCE_STATES;
const WAIT_FOR_SLOW_MAX_MS = P.TIMEOUTS.WAIT_FOR_SLOW_MAX_MS;
const MAX_ROOM_MEMBERS = P.LIMITS.MAX_ROOM_MEMBERS;
const MAX_ROOMS = P.LIMITS.MAX_ROOMS;
const ROOM_TTL_MS = P.TIMEOUTS.ROOM_TTL_MS;
const MAX_MESSAGE_SIZE = P.LIMITS.MAX_MESSAGE_SIZE;
const RATE_LIMIT_WINDOW = P.TIMEOUTS.RATE_LIMIT_WINDOW;
const RATE_LIMIT_MAX = P.LIMITS.RATE_LIMIT_MAX;
const MAX_CHAT_LENGTH = P.LIMITS.MAX_CHAT_LENGTH;
const MAX_USERNAME_LENGTH = P.LIMITS.MAX_USERNAME_LENGTH;
const MAX_CONNECTIONS_PER_IP = P.LIMITS.MAX_CONNECTIONS_PER_IP;
const EMPTY_ROOM_GRACE_MS = P.TIMEOUTS.EMPTY_ROOM_GRACE_MS;
const PERSISTENT_ROOM_TTL_MS = P.TIMEOUTS.PERSISTENT_ROOM_TTL_MS;
const PERSISTENT_ROOM_EMPTY_GRACE_MS = P.TIMEOUTS.PERSISTENT_ROOM_EMPTY_GRACE_MS;
const MAX_VOICE_SIGNAL_BYTES = P.LIMITS.MAX_VOICE_SIGNAL_BYTES;
const CUSTOM_NAME_REGEX = P.CUSTOM_NAME_REGEX;
const ROOM_CODE_REGEX = P.ROOM_CODE_REGEX;

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
// Codes and ids come from a CSPRNG. The room code is the only credential this system has,
// and Math.random's internal state is recoverable from a handful of its own outputs, so an
// attacker who made a few rooms could predict the codes handed to strangers. See
// shared/protocol.cjs.
function generateRoomCode(existing) {
  return P.generateRoomCode((code) => existing.has(code));
}
const generateUserId = P.generateUserId;
const sanitize = P.sanitize;
const escapeHtml = P.escapeHtml;
// The call-link allowlist and both URL validators live in shared/protocol.cjs, so this
// relay, the Node one and extension/config.js cannot disagree about what a room is allowed
// to point its members at.
const validateCallUrl = P.validateCallUrl;
const validateUrl = P.validateUrl;

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
<style>body{font-family:-apple-system,sans-serif;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{text-align:center}h1{font-size:32px;margin-bottom:8px}p{color:#888}.tag{font-size:11px;color:#f2f2f4;margin-top:8px}</style>
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
const LEADER_STALE_MS = P.TIMEOUTS.LEADER_STALE_MS;
const HOST_ABSENCE_GRACE_MS = P.TIMEOUTS.HOST_ABSENCE_GRACE_MS;
// Generous on purpose: a university or an office behind one NAT address is a single IP to
// us, and locking those people out of making rooms would be a worse bug than the flood it
// prevents.
const ROOM_CREATE_WINDOW_MS = P.TIMEOUTS.ROOM_CREATE_WINDOW_MS;
const ROOM_CREATE_MAX = P.LIMITS.ROOM_CREATE_MAX;
const MAX_LIVE_ROOMS_PER_IP = P.LIMITS.MAX_LIVE_ROOMS_PER_IP;
const LEADER_SWEEP_MS = P.TIMEOUTS.LEADER_SWEEP_MS;
const FAILED_JOIN_WINDOW_MS = P.TIMEOUTS.FAILED_JOIN_WINDOW_MS;
const FAILED_JOIN_MAX = P.LIMITS.FAILED_JOIN_MAX;

export class RoomHubDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // In-memory caches - rebuilt from storage on cold start.
    this.rooms = null;            // Map<code, room>
    this.connectionsPerIp = new Map();
    // Rooms outlive the sockets that made them (that is the whole point of the grace
    // window), so limiting the RATE of creation is not enough on its own: they accumulate.
    // Limiting how many one address is holding at once is exact. Matches the Node server.
    this.liveRoomsPerIp = new Map();
    // Windowed budgets, all three the same shared implementation. A Durable Object is
    // long lived by design, so a hit map that is never pruned is not a rounding error: it
    // grows by one entry for every address that ever spoke to it and never shrinks.
    this.roomCreateLimiter = new P.WindowedLimiter(ROOM_CREATE_WINDOW_MS, ROOM_CREATE_MAX);
    this.rateLimiter = new P.WindowedLimiter(RATE_LIMIT_WINDOW, RATE_LIMIT_MAX);
    // A wrong room code costs nothing to send and the reply says whether that room exists,
    // so an unbounded stream of them is a search of the code space for other people's
    // parties. Counted per address and only ever on a miss.
    this.failedJoinLimiter = new P.WindowedLimiter(FAILED_JOIN_WINDOW_MS, FAILED_JOIN_MAX);
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
          // adActive rides the socket attachment for the same reason voiceActive does: the
          // members map is rebuilt from scratch on every wake, and an ad break is precisely
          // the period during which nobody sends anything, so the object is very likely to
          // hibernate in the middle of one. Losing it there meant the room believed
          // everybody was watching again, unfroze the clock while they were all still in
          // their breaks, and delivered the exact over-advance this feature exists to stop.
          room.members.set(meta.userId, {
            ws,
            userName: meta.userName,
            voiceActive: !!meta.voiceActive,
            adActive: !!meta.adActive,
            presence: meta.presence || (meta.adActive ? "ad" : "watching"),
          });
        }
      }
    }

    // Deadlines, not timers, so a sleep does not reset them. Sweep anything already past
    // its own on the way back up.
    this._sweepExpiredRooms();
    this._sweepEmptyRooms();
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
      this._releaseRoomSlot(room);
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
    // Strip what must never be persisted: live socket handles and our own write-throttle
    // bookkeeping. Everything else, emptySince and hostAbsentSince included, is exactly
    // what has to survive a sleep.
    const { members: _members, lastPersistAt: _lastPersist, ...rest } = room;
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
    return this.rateLimiter.check(userId);
  }

  // -------- Heartbeat leader (first member) --------
  _heartbeatLeader(room) {
    // In a host-only room the host is the only member whose playback this relay will
    // accept, so they are the only member it is meaningful to make leader. Handing the
    // role to a guest produces a leader whose every beat is rejected, which looks exactly
    // like a room that has silently stopped syncing.
    if (room.mode === "host") {
      const host = room.members.get(room.hostId);
      return host && host.ws && host.ws.readyState === 1 /* WebSocket.OPEN */ ? room.hostId : null;
    }

    // First member in order whose socket is open AND who is not sitting out an ad.
    // Promoting a dead socket, or someone who has deliberately stopped broadcasting,
    // makes the room go quiet with nobody able to notice until the next sweep.
    for (const [uid, m] of room.members) {
      if (!m.ws || m.ws.readyState !== 1 /* WebSocket.OPEN */) continue;
      // Not somebody in an ad break, and not somebody whose own playback has stalled.
      if (m.adActive || m.presence === "buffering") continue;
      return uid;
    }
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
      // correct. Silence is correct behaviour there, not a frozen tab. Same for a room
      // where every member is sitting out an ad.
      if (!room.playbackState || !room.playbackState.playing) continue;
      if (this._everyMemberInAd(room)) continue;
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
    // Wake for a leader handoff while anybody is in a room, because the same alarm carries
    // the room expiry sweep and the dead-socket reaper.
    let wanted = null;
    for (const room of this.rooms.values()) {
      if (room.members.size >= 1) { wanted = Date.now() + LEADER_SWEEP_MS; break; }
    }
    // With nobody anywhere there is still one thing left to wake for: an empty room's
    // grace window running out. Wake once, then, rather than every five seconds through a
    // window that is thirty minutes long and can be seven days. Without this the object
    // slept with no alarm at all and the room was never collected.
    if (wanted === null) {
      const due = this._nextEmptyDeadline();
      if (due === null) return;
      wanted = Math.max(due, Date.now() + 1000);
    }
    const existing = await this.state.storage.getAlarm();
    // An alarm already set for sooner does the job. One set for later does not, which is
    // the case when a room fills up again while a far-off empty-room wake was pending.
    if (existing !== null && existing <= wanted) return;
    await this.state.storage.setAlarm(wanted);
  }

  async alarm() {
    await this.bootPromise;
    this._reapDeadSockets();
    this._sweepStuckWaits();
    this._sweepHostAbsence();
    this._rotateStaleLeaders();
    this._sweepExpiredRooms();
    this._sweepEmptyRooms();
    this.rateLimiter.cleanup();
    this.roomCreateLimiter.cleanup();
    this.failedJoinLimiter.cleanup();
    await this._scheduleLeaderSweep();
  }

  // The Node server terminates a socket that misses a pong. There is no ping/pong to hang
  // that off here, so a member whose laptop lid closed with no clean close frame stayed in
  // the room forever: inflating every member count, holding a slot against the room cap,
  // and sitting in the heartbeat-leader queue as a candidate who can never beat.
  // There are two ways to stop being in a room: leaving, and dying. They used to be two
  // separate pieces of code, and the second one did less than the first, so a member whose
  // laptop lid closed without a clean close frame took a different and worse path than one
  // who clicked Leave. Most damagingly, a reaped HOST never handed over, which left
  // room.hostId pointing at somebody who could never come back and, in a host-only room,
  // permanently rejected everyone else's play and pause. Both paths go through here now.
  _removeMember(code, room, userId, member, displayName) {
    const wasHost = room.hostId === userId;
    const wasVoiceActive = !!(member && member.voiceActive);
    room.members.delete(userId);
    // The one person still watching may have just gone, leaving a room that is entirely in
    // ad breaks, whose clock should stop rather than run on without anybody. And if the
    // person the room was WAITING for is the one who left, it should stop waiting.
    this._updateRoomAdFreeze(room);
    this._updateWaitForSlow(room, code);

    this._broadcast(code, {
      type: "member-left",
      userId,
      userName: displayName,
      memberCount: room.members.size,
    });

    if (wasVoiceActive) {
      // Otherwise every remaining peer keeps a WebRTC connection open to somebody who is
      // gone, and the "who is speaking" list keeps showing them.
      this._broadcast(code, {
        type: "voice-state",
        userId,
        userName: displayName,
        active: false,
        activeUserIds: Array.from(room.members.entries()).filter(([, m]) => m.voiceActive).map(([id]) => id),
      });
    }

    if (room.members.size === 0) {
      if (wasHost) {
        // The room outlives its last member by the grace window, so it is very much still
        // joinable. Leaving hostId pointing at somebody gone meant the first-arrival rule
        // could never fire (a stale id is not null), and in a host-only room the first
        // friend back could not play, pause or seek anything, with nothing to say why.
        room.hostId = null;
        room.hostClaimable = true;
      }
      this._markEmpty(code);
      return;
    }

    this._notifyHeartbeatLeader(room);
    if (!wasHost) return;

    // Hand the controls to somebody still here, but do not unlock a host-only room yet:
    // a reload and a departure look identical from here, and unlocking instantly meant a
    // host-only room fell open to everyone the first time its host refreshed.
    const nextHostId = room.members.keys().next().value;
    room.hostId = nextHostId;
    const newHost = room.members.get(nextHostId);
    if (newHost) this._sendTo(newHost.ws, { type: "host-transferred", isHost: true });
    if (room.mode === "host" && !room.hostAbsentSince) {
      room.hostAbsentSince = Date.now();
    }
  }

  _reapDeadSockets() {
    for (const [code, room] of this.rooms) {
      let removed = false;
      for (const [uid, member] of Array.from(room.members)) {
        const open = member.ws && member.ws.readyState === 1 /* WebSocket.OPEN */;
        if (open) continue;
        this._removeMember(code, room, uid, member, member.userName);
        removed = true;
      }
      if (removed) this._persistRoom(code);
    }
  }

  // A host who has been gone longer than the grace window really has left, so the room
  // unlocks. Timestamp rather than a timer, because a setTimeout does not survive
  // hibernation and this has to still be true when the object wakes up.
  _sweepHostAbsence() {
    for (const [code, room] of this.rooms) {
      if (!room.hostAbsentSince) continue;
      if (room.mode !== "host") { room.hostAbsentSince = null; continue; }
      if (Date.now() - room.hostAbsentSince < HOST_ABSENCE_GRACE_MS) continue;
      room.hostAbsentSince = null;
      room.mode = "everyone";
      this._broadcast(code, { type: "mode-changed", mode: "everyone", fromUser: "System" });
      this._persistRoom(code);
    }
  }

  // -------- Empty-room grace --------
  //
  // A timestamp swept by the alarm, not a setTimeout, for the same reason hostAbsentSince
  // is one. A pending timer does not survive hibernation, and this object hibernates
  // precisely when a room is empty and quiet, so the countdown was destroyed and then
  // restarted from the full 30 minutes by whichever unrelated wake happened to reload the
  // room. Worse, when the LAST room went empty nothing scheduled an alarm at all, so the
  // object slept with no timer of any kind and the room was never deleted: it sat in
  // storage counting against MAX_ROOMS until something else woke the object, up to its
  // whole 12 hour or 30 day inactivity ceiling. Persisted, so the deadline is the same one
  // on the other side of a sleep.
  _markEmpty(code) {
    const room = this.rooms.get(code);
    if (!room || room.members.size > 0 || room.emptySince) return;
    room.emptySince = Date.now();
    this._persistRoom(code);
  }
  _markOccupied(code) {
    const room = this.rooms.get(code);
    if (room && room.emptySince) room.emptySince = null;
  }

  _sweepEmptyRooms() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.members.size > 0) {
        if (room.emptySince) room.emptySince = null;
        continue;
      }
      if (!room.emptySince) {
        room.emptySince = now;
        this._persistRoom(code);
        continue;
      }
      const grace = room.persistent ? PERSISTENT_ROOM_EMPTY_GRACE_MS : EMPTY_ROOM_GRACE_MS;
      if (now - room.emptySince < grace) continue;
      this._releaseRoomSlot(room);
      this.rooms.delete(code);
      this._deleteRoomStorage(code);
    }
  }

  /** When the earliest empty room is due to go, or null if none is waiting. */
  _nextEmptyDeadline() {
    let soonest = null;
    for (const room of this.rooms.values()) {
      if (room.members.size > 0 || !room.emptySince) continue;
      const grace = room.persistent ? PERSISTENT_ROOM_EMPTY_GRACE_MS : EMPTY_ROOM_GRACE_MS;
      const due = room.emptySince + grace;
      if (soonest === null || due < soonest) soonest = due;
    }
    return soonest;
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
          '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Watch Together</title></head><body style="font-family:-apple-system,sans-serif;background:#0d0d0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><p>That is not a valid room code.</p></body></html>',
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
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#0d0d0f;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:#141417;border-radius:16px;padding:44px 36px;max-width:400px;width:90%;text-align:center}h1{font-size:20px;font-weight:700;margin-bottom:4px}.sub{color:rgba(235,235,245,.5);font-size:14px;margin-bottom:24px}.code{font-size:38px;font-weight:800;color:#f2f2f4;letter-spacing:8px;margin:12px 0 8px}.st{font-size:13px;font-weight:500;margin-bottom:24px;color:${room ? "#4ade80" : "rgba(235,235,245,.4)"}}.err{color:#f87171;font-size:14px;margin-bottom:20px}.btn{display:block;padding:14px;background:#f2f2f4;color:#0d0d0f;text-decoration:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;border:none;width:100%;margin-bottom:10px}.hint{font-size:12px;color:rgba(235,235,245,.3);margin-top:16px;line-height:1.6}</style>
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

    // Anything from this member other than the three messages that are not evidence of
    // watching proves they are out of their ad break. The Node twin has always done this
    // and this relay never did, so the only paths that could clear the flag here were sync
    // and heartbeat, both behind checks a guest in a host-only room can never pass.
    //
    // ad-state is edge triggered: a "my break ended" lost to a socket that was down at that
    // moment left that member marked dark with no organic way back, and a room where every
    // member is marked dark holds its clock still. The party sits watching a film that will
    // not advance, and nothing anywhere reports an error.
    //
    // A ping is excluded on purpose. It says "we are still here", not "I am watching", and
    // counting it would unfreeze the clock during the very break the freeze exists for.
    if (P.provesWatching(msg.type) && meta.currentRoom) {
      const adRoom = this.rooms.get(meta.currentRoom);
      const self = adRoom && adRoom.members.get(meta.userId);
      if (self && self.adActive) {
        self.adActive = false;
        this._setMeta(ws, { adActive: false, presence: P.PRESENCE_DEFAULT });
        this._updateRoomAdFreeze(adRoom);
      }
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
      case "ad-state":
      case "presence": return this._handleAdState(ws, meta, msg);
      // Proof the party is still there, sent once a minute. Marks the room alive so its
      // TTL never expires mid-film, and nothing else.
      case "ping": {
        const pingRoom = this.rooms.get(meta.currentRoom);
        if (pingRoom) pingRoom.lastActivity = Date.now();
        return;
      }
      case "set-mode": return this._handleSetMode(ws, meta, msg);
      case "set-call-url": return this._handleSetCallUrl(ws, meta, msg);
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

    // The whole reason this exists. This call was simply absent, so on the primary relay
    // neither budget was enforced on the path that actually makes rooms: one address could
    // mint them as fast as the generic message limiter allowed, times ten sockets, and fill
    // the global MAX_ROOMS ceiling for every real user everywhere in under a minute. Rooms
    // then sit in Durable Object storage for their whole grace window, so it does not even
    // undo itself. The Node twin has had this check the entire time.
    if (!this._claimRoomSlot(meta.ip)) {
      this._sendTo(ws, { type: "error", message: "You already have too many rooms open. Close one and try again." });
      return;
    }

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
      ownerIp: meta.ip,
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
    // Arm the sweep for this room too. Without it a lone creator whose socket dies is
    // never reaped, because nothing else would wake the object on their behalf.
    await this._scheduleLeaderSweep();
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

      // That await is a yield point, and a Durable Object's input gate only holds events
      // back across STORAGE operations, not across a Web Crypto call. Several members of
      // one room auto-reconnecting after a cold start is the ordinary case, not a contrived
      // one, and two of them could both find the room missing, both build one, and both
      // publish it: the second replaced the first, and the first caller went on to add
      // itself to an object nobody could ever look up again. It got a normal room-joined,
      // then sat in the real room as a socket that could still inject sync, navigate and
      // chat while appearing in no member list and no reap. Re-read here so the loser of
      // that race joins the room that actually won.
      const raced = this.rooms.get(code);
      if (raced) {
        room = raced;
      } else {
        room = {
          code,
          // Rebuilding is not the same as being the host. Anyone who knows the code can ask
          // for a rebuild, and there is nothing left to check them against but a token this
          // Worker itself issued. Without one, a stranger who waited for a party to go quiet
          // could come back as its exclusive controller.
          hostId: rebuildIsHost ? meta.userId : null,
          // And whether the "an unsteered room goes to whoever arrives first" rule below is
          // allowed to fire for it. It must not be: the rebuilder IS the first arrival,
          // always, so that rule handed host to them anyway and made the token check above
          // decorative. mode was worse still, taken straight from the rebuild request, so
          // asking for mode:"host" without any token produced a room locked to a stranger.
          hostClaimable: rebuildIsHost,
          mode: rebuildIsHost ? P.normalizeRoomMode(msg.mode) : P.ROOM_MODE_DEFAULT,
          persistent: CUSTOM_NAME_REGEX.test(code),
          members: new Map(),
          videoUrl: validateUrl(msg.videoUrl),
          playbackState: {
            playing: !!seed.playing,
            currentTime: P.validPlaybackTime(seed.currentTime) ?? 0,
            playbackRate: P.validPlaybackRate(seed.playbackRate) ?? 1,
            lastUpdate: Date.now(),
          },
          createdAt: Date.now(),
          lastActivity: Date.now(),
          ownerIp: meta.ip,
        };
        if (!this._claimRoomSlot(meta.ip)) {
          this._sendTo(ws, { type: "error", message: "You already have too many rooms open. Close one and try again." });
          return;
        }
        this.rooms.set(code, room);
      }
    }

    if (!room) {
      // A miss is free to produce and its answer is informative, which together make an
      // unbounded stream of them a search for somebody else's party. Only misses count, so
      // no legitimate join is ever affected by how much anybody else is guessing.
      if (!this.failedJoinLimiter.check(meta.ip || "anon")) {
        this._sendTo(ws, { type: "error", message: "Rate limited - slow down" });
        return;
      }
      this._sendTo(ws, { type: "error", message: "Room not found" });
      return;
    }
    if (room.members.size >= MAX_ROOM_MEMBERS) {
      this._sendTo(ws, { type: "error", message: `Room is full (max ${MAX_ROOM_MEMBERS})` });
      return;
    }
    if (meta.currentRoom) await this._leaveCurrentRoom(ws, meta);
    this._markOccupied(code);

    const userName = sanitize(msg.userName, MAX_USERNAME_LENGTH) || "User";
    // Same person, new connection: reloading the tab used to make the host a guest in
    // their own party, because every reconnect gets a fresh user id.
    const reclaimsHost = await isValidHostToken(this.env.HOST_TOKEN_SECRET, code, msg.hostToken);
    if (reclaimsHost) {
      room.hostId = meta.userId;
      // They only reloaded. Call off the pending unlock.
      room.hostAbsentSince = null;
    }
    // A room whose host never came back has nobody steering; the first arrival takes it.
    // Not a room rebuilt without a valid host token: see hostClaimable above.
    if ((room.hostId === null || room.hostId === undefined) && room.hostClaimable !== false) {
      room.hostId = meta.userId;
      room.hostClaimable = true;
    }
    room.members.set(meta.userId, { ws, userName, voiceActive: false, adActive: false });
    // A new arrival is watching the film, so a room that was entirely in ads is not.
    this._updateRoomAdFreeze(room);
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
      waitForSlow: !!room.waitForSlow,
      callUrl: room.callUrl || "",
      hostToken: reclaimsHost ? await mintHostToken(this.env.HOST_TOKEN_SECRET, code) : undefined,
      videoUrl: room.videoUrl || "",
      serverTime: Date.now(),
      playbackState: { ...room.playbackState, timestamp: this._positionTimestamp(room), serverTime: Date.now() },
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
    const member = room.members.get(meta.userId);
    this._removeMember(code, room, meta.userId, member, meta.userName);
    await this._persistRoom(code);
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
    // Both bounds at both ends, shared with the Node relay. Infinity was not the only
    // value that survived the old guard: isFinite(1e308) is true and 1e308 is not negative,
    // so it became the room's authoritative position and went out to every member.
    const ct = P.validPlaybackTime(msg.currentTime);
    const pr = P.validPlaybackRate(msg.playbackRate);
    if (ct === null || pr === null) return;

    room.playbackState = { playing: !!msg.playing, currentTime: ct, playbackRate: pr, lastUpdate: Date.now() };
    // Somebody is demonstrably watching the film, so the clock is running.
    const syncMember = room.members.get(meta.userId);
    if (syncMember && syncMember.adActive) {
      syncMember.adActive = false;
      this._setMeta(ws, { adActive: false });
    }
    this._updateRoomAdFreeze(room);
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

    // And in a host-only room, only from the host. The sync path has always checked this
    // and the heartbeat path never did, which did not matter while the leader was almost
    // always the host. It matters now that the leader role deliberately steps over anybody
    // in an ad break: the host hits a routine advert, a guest inherits the role, and that
    // guest's self-reported position starts driving the host's own video. That is exactly
    // what host-only mode exists to prevent.
    if (room.mode === "host" && room.hostId !== meta.userId) return;

    const ct = P.validPlaybackTime(msg.currentTime);
    const pr = P.validPlaybackRate(msg.playbackRate);
    if (ct === null || pr === null) return;

    room.playbackState = { playing: !!msg.playing, currentTime: ct, playbackRate: pr, lastUpdate: Date.now() };
    const hbMember = room.members.get(meta.userId);
    if (hbMember && hbMember.adActive) {
      hbMember.adActive = false;
      this._setMeta(ws, { adActive: false });
    }
    this._updateRoomAdFreeze(room);
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
      timestamp: this._positionTimestamp(room),
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

  // Ads are per-viewer, so one person's break is not the room's. But when EVERY member is
  // in one, which is what a platform mid-roll produces because everybody is at the same
  // timestamp of the same title, nobody is playing anything, and the room's position is
  // stored as (currentTime, lastUpdate) and read by extrapolating forward from lastUpdate.
  // That extrapolation assumes playback continued. Left alone, a 90-second break convinced
  // the room 90 seconds of film had gone by and hurled everyone that far past the scene
  // they were about to watch. Hold the clock while the room is dark; restart it from where
  // it stopped when somebody comes back.
  _everyMemberInAd(room) {
    // A socket that died without a close frame sits in the map until the next alarm reaps
    // it, still carrying whatever it last reported. A ghost marked "watching" vetoes the
    // freeze on behalf of somebody who is not there, and the room runs on through an ad
    // break exactly as it did before any of this existed; a ghost marked "ad" freezes it
    // for people who are watching. Neither is a vote it gets to cast. The Node twin filters
    // these out and this one did not, alone among its own member scans.
    let live = 0;
    for (const m of room.members.values()) {
      if (!m.ws || m.ws.readyState !== 1 /* WebSocket.OPEN */) continue;
      live++;
      if (!m.adActive) return false;
    }
    return live > 0;
  }

  _updateRoomAdFreeze(room) {
    const st = room.playbackState;
    if (!st) return;
    const dark = this._everyMemberInAd(room);
    if (dark && !st.frozenAt) {
      if (st.playing) {
        const elapsed = Math.max(0, Date.now() - st.lastUpdate) / 1000;
        st.currentTime += elapsed * (st.playbackRate || 1);
      }
      st.lastUpdate = Date.now();
      st.frozenAt = Date.now();
    } else if (!dark && st.frozenAt) {
      st.lastUpdate = Date.now();
      st.frozenAt = null;
    }
  }

  // Frozen means "nobody has been watching, do not add the elapsed time".
  _positionTimestamp(room) {
    const st = room.playbackState;
    return st && st.frozenAt ? Date.now() : st.lastUpdate;
  }

  // Both budgets a new room has to clear: how fast one address may mint them, and how many
  // it may be holding at once. Rooms outlive the sockets that made them, so a rate limit on
  // its own still lets them accumulate.
  //
  // Only ever called once a room is CERTAIN to exist. A slot is released when a room is
  // deleted, so claiming it before a check that can still reject the room burns it forever.
  _claimRoomSlot(ip) {
    if (!ip || ip === "anon") return true;
    if (!this.roomCreateLimiter.check(ip)) return false;
    const live = this.liveRoomsPerIp.get(ip) || 0;
    if (live >= MAX_LIVE_ROOMS_PER_IP) return false;
    this.liveRoomsPerIp.set(ip, live + 1);
    return true;
  }

  _releaseRoomSlot(room) {
    if (!room || !room.ownerIp || room.slotReleased) return;
    room.slotReleased = true;
    const n = (this.liveRoomsPerIp.get(room.ownerIp) || 1) - 1;
    if (n <= 0) this.liveRoomsPerIp.delete(room.ownerIp);
    else this.liveRoomsPerIp.set(room.ownerIp, n);
  }

  _membersBuffering(room) {
    const names = [];
    for (const [, m] of room.members) {
      if (!m.ws || m.ws.readyState !== 1 /* WebSocket.OPEN */) continue;
      if (m.presence === "buffering") names.push(m.userName);
    }
    return names;
  }

  _updateWaitForSlow(room, code) {
    if (!room.waitForSlow) {
      if (room.autoPaused) this._resumeAfterWait(room, code);
      return;
    }
    const stuck = this._membersBuffering(room);
    const st = room.playbackState;

    if (stuck.length > 0 && !room.autoPaused) {
      if (!st.playing) return;
      const elapsed = Math.max(0, Date.now() - st.lastUpdate) / 1000;
      st.currentTime += elapsed * (st.playbackRate || 1);
      st.playing = false;
      st.lastUpdate = Date.now();
      room.autoPaused = true;
      room.autoPausedAt = Date.now();
      this._broadcast(code, {
        type: "sync",
        action: "pause",
        playing: false,
        currentTime: st.currentTime,
        playbackRate: st.playbackRate,
        fromUser: "System",
        waitingFor: stuck,
        timestamp: Date.now(),
        serverTime: Date.now(),
      });
      return;
    }

    if (room.autoPaused && stuck.length === 0) this._resumeAfterWait(room, code);
  }

  _resumeAfterWait(room, code) {
    if (!room.autoPaused) return;
    room.autoPaused = false;
    room.autoPausedAt = 0;
    const st = room.playbackState;
    st.playing = true;
    st.lastUpdate = Date.now();
    this._broadcast(code, {
      type: "sync",
      action: "play",
      playing: true,
      currentTime: st.currentTime,
      playbackRate: st.playbackRate,
      fromUser: "System",
      resumedAfterWait: true,
      timestamp: Date.now(),
      serverTime: Date.now(),
    });
  }

  _sweepStuckWaits() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (!room.autoPaused) continue;
      if (now - room.autoPausedAt < WAIT_FOR_SLOW_MAX_MS) continue;
      for (const m of room.members.values()) {
        if (m.presence === "buffering") m.presence = "watching";
      }
      this._resumeAfterWait(room, code);
    }
  }

  _handleAdState(ws, meta, msg) {
    const code = meta.currentRoom;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) return;
    const member = room.members.get(meta.userId);
    if (!member) return;

    // Accept both spellings, and do not depend on the envelope's type field being present:
    // a message carrying `active` is the older ad-state shape whatever it calls itself.
    const state = PRESENCE_STATES.includes(msg.state)
      ? msg.state
      : typeof msg.active === "boolean"
        ? (msg.active ? "ad" : "watching")
        : "watching";

    const wasLeader = this._heartbeatLeader(room);
    member.presence = state;
    member.adActive = state === "ad";
    this._setMeta(ws, { adActive: member.adActive, presence: state });
    room.lastActivity = Date.now();
    this._updateRoomAdFreeze(room);
    this._updateWaitForSlow(room, code);
    // The freeze itself (frozenAt, and the position it was held at) has to reach storage,
    // or a wake reloads the pre-freeze playbackState and extrapolates across the whole
    // break plus the hibernation.
    this._persistRoom(code);

    this._broadcast(code, {
      type: "presence",
      userId: meta.userId,
      userName: meta.userName,
      state,
      // Kept for anything still reading the older shape.
      active: member.adActive,
      watchingCount: Array.from(room.members.values()).filter((m) => !m.adActive).length,
      memberCount: room.members.size,
    }, ws);

    if (this._heartbeatLeader(room) !== wasLeader) this._notifyHeartbeatLeader(room);
  }

  // The host pins a call to the room. Everyone watching together is usually also talking,
  // and making them paste the link into chat every time somebody joins late is the kind of
  // small friction that makes a product feel unfinished.
  _handleSetCallUrl(ws, meta, msg) {
    const code = meta.currentRoom;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) return;
    // Host only: this becomes a button the whole room is invited to press.
    if (room.hostId !== meta.userId) return;

    const raw = typeof msg.url === "string" ? msg.url.trim() : "";
    if (raw && !validateCallUrl(raw)) {
      this._sendTo(ws, { type: "error", message: "That does not look like a Zoom, Meet, Teams, Discord or Whereby link" });
      return;
    }
    room.callUrl = validateCallUrl(raw);
    room.lastActivity = Date.now();
    this._persistRoom(code);
    this._broadcast(code, { type: "call-url", callUrl: room.callUrl, fromUser: meta.userName });
  }

  _handleSetMode(ws, meta, msg) {
    const code = meta.currentRoom;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room || room.hostId !== meta.userId) return;
    const newMode = msg.mode === "host" ? "host" : "everyone";
    room.mode = newMode;
    if (typeof msg.waitForSlow === "boolean") {
      room.waitForSlow = msg.waitForSlow;
      this._updateWaitForSlow(room, code);
    }
    this._persistRoom(code);
    this._broadcast(code, {
      type: "mode-changed",
      mode: newMode,
      waitForSlow: !!room.waitForSlow,
      fromUser: meta.userName,
    });
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
