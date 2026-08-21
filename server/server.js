const http = require("http");
const crypto = require("crypto");
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
// Set this to the new relay's wss:// URL and every client that connects is told to move
// there, permanently, and reconnects on its own. That is the whole migration story: the
// extension cannot be redeployed quickly (Chrome Web Store review, then auto-update), so
// the OLD server is what has to do the redirecting. Leave it unset in normal operation.
//
// It is deliberately not a list and not clever: one address, read from the environment,
// so moving to Oracle or anywhere else is a config change on a running service, not a
// release. Clients validate it themselves and refuse anything that is not wss://.
const SERVER_MOVED_URL = (process.env.SERVER_MOVED_URL || "").trim();
if (SERVER_MOVED_URL && !/^wss:\/\/[^\s]+$/i.test(SERVER_MOVED_URL)) {
  console.error(`[start] SERVER_MOVED_URL is set but is not a wss:// URL, ignoring: ${SERVER_MOVED_URL}`);
}
const SERVER_MOVED_VALID = /^wss:\/\/[^\s]+$/i.test(SERVER_MOVED_URL);

const CUSTOM_NAME_REGEX = /^[a-zA-Z0-9-]{4,32}$/;
// The shape generateRoomCode() hands out (no I, O, 0 or 1: they read the same out loud).
const ROOM_CODE_REGEX = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

// Host tokens are an HMAC of the room code, not a stored value, so a room that has to be
// rebuilt after a restart can still prove who its host was without the server having
// remembered anything. Set HOST_TOKEN_SECRET to a fixed string in the environment to make
// that survive deploys. Without one we mint a per-boot secret and simply stop granting
// host on a rebuild: a party that comes back as a room everyone can drive is a small
// annoyance, a stranger silently inheriting control of it is not.
const HOST_TOKEN_SECRET = process.env.HOST_TOKEN_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.HOST_TOKEN_SECRET) {
  console.warn("[start] HOST_TOKEN_SECRET is not set. Host status will not survive a server restart.");
}

function mintHostToken(roomCode) {
  return crypto.createHmac("sha256", HOST_TOKEN_SECRET).update(String(roomCode)).digest("hex");
}

function isValidHostToken(roomCode, token) {
  if (typeof token !== "string" || token.length !== 64) return false;
  const expected = mintHostToken(roomCode);
  // Constant time: a token check that leaks its answer through timing is not a check.
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(token, "hex"));
  } catch {
    return false;
  }
}

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
  const data = JSON.stringify({ v: PROTOCOL_VERSION, ...message });
  for (const member of room.members.values()) {
    if (member.ws !== excludeWs && member.ws.readyState === 1) {
      member.ws.send(data);
    }
  }
}

// The protocol version this build speaks. Clients stamp `v` on what they send; anything
// without one is a pre-1.2.0 extension, which is normal for weeks after a store release
// and must keep working. Replies carry it so a client can tell what it is talking to.
const PROTOCOL_VERSION = 1;

function sendTo(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...message }));
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
      releaseRoomSlot(r);
      rooms.delete(roomCode);
      console.log(`[cleanup] Room ${roomCode} deleted after ${grace}ms grace. Active rooms: ${rooms.size}`);
    }
  }, grace);
  console.log(`[cleanup] Room ${roomCode} empty - deletion scheduled in ${grace}ms (persistent=${!!room.persistent})`);
}

// Ads are per-viewer: your pre-roll is not your friend's, so an ad is a "drop out and
// catch back up" event rather than a "pause the room" event. That works fine when one
// person hits an ad. It breaks when EVERYONE does, which is exactly what a platform
// mid-roll causes, because everybody is at the same timestamp of the same title.
//
// The room's position is stored as (currentTime, lastUpdate) and read by extrapolating
// forward from lastUpdate, on the assumption that playback carried on. While every single
// member is sitting out an ad, nobody is playing anything, so that assumption is false: a
// 90-second ad break made the room believe 90 seconds of film had gone by. Everyone came
// back, asked where the room was, and got hard-seeked 90 seconds past the scene they were
// about to watch. In sync with each other, and a minute and a half into the future.
//
// So when the last viewer goes dark, freeze the clock. When the first one comes back,
// start it again from where it stopped.
function everyMemberInAd(room) {
  let live = 0;
  for (const member of room.members.values()) {
    // A socket that died without a close frame sits in the map for up to a minute before
    // ping/pong reaps it, carrying whatever it last reported. A ghost still marked
    // "watching" would veto the freeze on behalf of somebody who is not there, and the
    // room would run on through an ad break exactly as it did before any of this existed.
    if (!member.ws || member.ws.readyState !== 1) continue;
    live++;
    if (!member.adActive) return false;
  }
  return live > 0;
}

function updateRoomAdFreeze(room) {
  const st = room.playbackState;
  if (!st) return;
  const dark = everyMemberInAd(room);

  if (dark && !st.frozenAt) {
    // Advance to where the film actually was at the moment the last person looked away,
    // then hold it there.
    if (st.playing) {
      const elapsed = Math.max(0, Date.now() - st.lastUpdate) / 1000;
      st.currentTime += elapsed * (st.playbackRate || 1);
    }
    st.lastUpdate = Date.now();
    st.frozenAt = Date.now();
    console.log(`[room] ${room.code} every member is in an ad break, holding the clock at ${st.currentTime.toFixed(1)}s`);
  } else if (!dark && st.frozenAt) {
    // Somebody is watching again. Restart from the held position, not from before the break.
    st.lastUpdate = Date.now();
    st.frozenAt = null;
    // The staleness clock has to restart too. The whole break counted as silence, and the
    // sweep was exempting the room for exactly that reason; without this the first sweep
    // after the break sees a minute of quiet and demotes the leader at the precise moment
    // playback is trying to resume.
    room.lastHeartbeatAt = Date.now();
    console.log(`[room] ${room.code} ad break over, clock running again from ${st.currentTime.toFixed(1)}s`);
  }
}

// What to stamp on a position we are handing out. While the clock is frozen the answer is
// "now", so the client extrapolates by zero instead of by the length of the ad break.
function positionTimestamp(room) {
  const st = room.playbackState;
  return st && st.frozenAt ? Date.now() : st.lastUpdate;
}

// Elect heartbeat leader - the first member in the room.
// Only this user sends heartbeats to avoid N^2 broadcast storm.
function getHeartbeatLeader(room) {
  // In a host-only room the host is the only member the server will accept playback from,
  // so they are the only member it is meaningful to make leader. Handing the role to a
  // guest there produces a leader whose every heartbeat is rejected, which looks exactly
  // like a room that has silently stopped syncing.
  if (room.mode === "host") {
    const host = room.members.get(room.hostId);
    return host && host.ws && host.ws.readyState === 1 ? room.hostId : null;
  }

  // First member in insertion order, but only one whose socket is actually open AND who is
  // not currently sitting out an ad. A member whose connection died without a clean close
  // is still in the map until ping/pong reaps it, and a member watching an ad deliberately
  // stops broadcasting position; handing the job to either one stalls drift correction for
  // the whole room until the next sweep, silently.
  for (const [uid, member] of room.members) {
    if (member.ws && member.ws.readyState === 1 && !member.adActive) return uid;
  }
  // Everyone is either gone or in an ad. Fall back to anyone still connected: the room has
  // nothing to sync to right now anyway, and this keeps the role assigned.
  for (const [uid, member] of room.members) {
    if (member.ws && member.ws.readyState === 1) return uid;
  }
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
    // A paused room has no position to correct, so its leader deliberately stops beating.
    // Silence there is the system working, not a frozen tab, and demoting over it would
    // churn the leader for the whole time a room sits paused. The same is true of a room
    // where every member is sitting out an ad.
    if (!room.playbackState || !room.playbackState.playing) continue;
    if (everyMemberInAd(room)) continue;
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

// Creating a room is far more expensive than any other message: the room outlives the
// socket by the grace window (30 minutes, or 7 days if it was given a custom name), so
// the generic 20-per-second limiter lets one connection mint rooms faster than they can
// ever be reclaimed and fill MAX_ROOMS in minutes. Rooms are cheap to make and slow to
// free, so they get their own much stricter budget, keyed by IP rather than by
// connection: reconnecting must not hand out a fresh allowance.
// Generous on purpose. The real defence against a flood is that an abandoned room is now
// reclaimed the moment its maker walks away (see cleanupRoom), so rooms can no longer be
// minted faster than they are freed. This is the backstop, and it has to stay well clear
// of legitimate traffic: a university or an office behind one NAT address is a single IP
// to us, and locking those people out of making rooms would be a worse bug than the one
// it prevents.
const ROOM_CREATE_WINDOW_MS = parseInt(process.env.ROOM_CREATE_WINDOW_MS, 10) || 60000;
const ROOM_CREATE_MAX = parseInt(process.env.ROOM_CREATE_MAX, 10) || 60;
const roomCreateLimiter = new RateLimiter(ROOM_CREATE_WINDOW_MS, ROOM_CREATE_MAX);

// Loopback is this machine talking to itself: local development and the test suite. It is
// not an address an attacker can arrive from, because anything crossing the network shows
// up as the proxy's forwarded address instead.
function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

// How many rooms one address may have alive at the same time. This, not a deletion
// heuristic, is what stops a flood: rooms outlive their sockets by design (that is the
// whole point of the grace window, so a solo viewer who closed their tab can come back to
// the same code), so limiting the RATE of creation alone still lets rooms accumulate.
// Limiting how many one address can be holding at once is exact, and a real person is
// never anywhere near it.
// When the host of a locked room disconnects, the room does not unlock straight away.
// Reloading the party tab, or riding out a wifi blip, is not leaving: it looks identical
// to a departure from here, and unlocking instantly meant a host-only room fell open to
// everyone the first time its host hit refresh, permanently. Wait a little; if the host
// comes back with their token inside the window nothing ever changed, and if they do not,
// the room unlocks exactly as it always did.
const HOST_ABSENCE_GRACE_MS = parseInt(process.env.HOST_ABSENCE_GRACE_MS, 10) || 60000;

const MAX_LIVE_ROOMS_PER_IP = parseInt(process.env.MAX_LIVE_ROOMS_PER_IP, 10) || 20;
const liveRoomsPerIp = new Map(); // ip -> count

function claimRoomSlot(ip) {
  if (isLoopback(ip)) return true;
  const n = liveRoomsPerIp.get(ip) || 0;
  if (n >= MAX_LIVE_ROOMS_PER_IP) return false;
  liveRoomsPerIp.set(ip, n + 1);
  return true;
}

// Called from every path that removes a room, so the slot comes back exactly once.
function releaseRoomSlot(room) {
  if (!room || !room.ownerIp || room.slotReleased) return;
  room.slotReleased = true;
  const n = (liveRoomsPerIp.get(room.ownerIp) || 1) - 1;
  if (n <= 0) liveRoomsPerIp.delete(room.ownerIp);
  else liveRoomsPerIp.set(room.ownerIp, n);
}

// --- Stale Room Cleanup ---
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [code, room] of rooms) {
    // Defensive sweep for empty rooms older than 5 minutes that somehow
    // escaped the grace timer (e.g. timer never set on legacy state).
    // Only act when no grace timer is pending so we don't undercut it.
    if (room.members.size === 0 && !room.emptyDeleteTimer && now - room.createdAt > 300000) {
      releaseRoomSlot(room);
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
      releaseRoomSlot(room);
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
  // No 'unsafe-inline' for scripts: the page carries no inline JavaScript any more, so
  // there is no JS context for a room code to reach even if one slipped past validation.
  res.writeHead(200, {
    "Content-Type": "text/html",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  });
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
  <p class="hint">Select the code above, then open your video, click Watch Together in the toolbar, and paste it in.</p>
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
    const rawCode = decodeURIComponent(urlParts[0] || "").toUpperCase();
    // Anything that is not a code we could have issued is not a code. Without this the
    // path segment reaches an HTML attribute below, and escapeHtml is the wrong tool
    // there: it turns ' into &#39;, which the HTML parser decodes back to ' before the
    // attribute's JavaScript is parsed, so escaping does not contain it.
    const code = ROOM_CODE_REGEX.test(rawCode) || CUSTOM_NAME_REGEX.test(rawCode) ? rawCode : "";
    if (!code) {
      res.writeHead(404, { "Content-Type": "text/html", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'self'" });
      res.end("<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\"><title>Watch Together</title></head><body style=\"font-family:-apple-system,sans-serif;background:#1c1c1e;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0\"><p>That is not a valid room code.</p></body></html>");
      return;
    }
    const room = rooms.get(code);
    const memberCount = room ? room.members.size : 0;
    const roomExists = !!room;
    // Only ever redirect to the URL the ROOM itself is on. Honouring a ?url= from the
    // query string turns this path into an open redirect on our own origin: send someone
    // /join/ABCDEF?url=https://evil.example and they land on the attacker's page having
    // been sent there by the domain the invite told them to trust. The param is still
    // accepted and ignored so old invite links keep working.
    const videoUrl = validateUrl(room && room.videoUrl ? room.videoUrl : "");

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

// How many reverse proxies sit in front of this process and append to X-Forwarded-For.
// Render terminates TLS and adds exactly one. Behind no proxy at all, set 0 and we read
// the socket directly, which cannot be forged.
const TRUSTED_PROXY_HOPS = parseInt(process.env.TRUSTED_PROXY_HOPS, 10);
const PROXY_HOPS = Number.isFinite(TRUSTED_PROXY_HOPS) ? TRUSTED_PROXY_HOPS : 1;

function resolveClientIp(req) {
  const socketIp = req.socket.remoteAddress || "unknown";
  if (PROXY_HOPS <= 0) return socketIp;
  const chain = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (chain.length === 0) return socketIp;
  // Walk back from the end by the number of hops we own. Anything further left was
  // written by someone we do not control.
  const idx = chain.length - PROXY_HOPS;
  return chain[idx >= 0 ? idx : 0] || socketIp;
}

wss.on("connection", (ws, req) => {
  const userId = generateUserId();
  let currentRoom = null;
  let userName = "User";

  // X-Forwarded-For is a client-supplied header. Reading the LEFTMOST entry reads a
  // value the client wrote, so any non-browser socket can forge a fresh "IP" per
  // connection and the per-IP cap never engages. The only entry we can trust is the one
  // our own proxy appended: the rightmost. TRUSTED_PROXY_HOPS says how many hops in
  // front of us are ours (Render puts exactly one there); 0 means read the socket.
  const clientIp = resolveClientIp(req);

  // Logged as a short salted hash, never in the clear. The counter still works, abuse is
  // still traceable within a boot, and the host's log retention never sees a real address.
  const ipTag = crypto.createHmac("sha256", HOST_TOKEN_SECRET).update(String(clientIp)).digest("hex").slice(0, 8);

  // Per-IP connection limiting
  const ipCount = (connectionsPerIp.get(clientIp) || 0) + 1;
  if (ipCount > MAX_CONNECTIONS_PER_IP) {
    console.log(`[reject] client ${ipTag} exceeded max connections (${MAX_CONNECTIONS_PER_IP})`);
    ws.close(4002, "Too many connections");
    return;
  }
  connectionsPerIp.set(clientIp, ipCount);

  // If this deployment has been retired, say so immediately and let the client walk over
  // to its replacement. Sent before anything else so a migrating client spends as little
  // time as possible on the server that is going away.
  if (SERVER_MOVED_VALID) {
    sendTo(ws, { type: "server-moved", url: SERVER_MOVED_URL });
  }

  ws.isAlive = true;
  totalConnections++;
  console.log(`[connect] ${userId} (client ${ipTag}). Total: ${totalConnections}`);

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    // Every room on this process shares one event loop. An unhandled throw anywhere in
    // the switch below would take the whole server down and end every live party, so the
    // blast radius is capped at the one socket that caused it.
    try {
      handleMessage(raw);
    } catch (err) {
      console.error(`[error] message handler threw for ${userId}: ${describeError(err)}`);
      sendTo(ws, { type: "error", message: "Something went wrong handling that. Try again." });
    }
  });

  function handleMessage(raw) {
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

    // Anything at all arriving from this member, other than the message that sets the flag,
    // is proof they are connected and doing something. The ad flag is edge-triggered, so
    // without a path like this a lost "my ad ended" leaves them marked in a break with no
    // organic way back: their heartbeats are dropped before the reset line if they are not
    // the leader, and a solo viewer stops heartbeating altogether.
    if (msg.type !== "ad-state" && currentRoom) {
      const self = rooms.get(currentRoom)?.members.get(userId);
      if (self && self.adActive) {
        self.adActive = false;
        updateRoomAdFreeze(rooms.get(currentRoom));
      }
    }

    switch (msg.type) {
      case "create-room": {
        if (!isLoopback(clientIp) && !roomCreateLimiter.check(clientIp)) {
          sendTo(ws, { type: "error", message: "Too many rooms created. Wait a minute and try again." });
          return;
        }
        if (!claimRoomSlot(clientIp)) {
          sendTo(ws, { type: "error", message: "You already have too many rooms open. Close one and try again." });
          return;
        }

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
          peakMembers: 1,
          ownerIp: clientIp,
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
          // Kept by the creator's extension and replayed on every rejoin. Reloading the
          // tab used to cost you your own room: each connection gets a fresh user id, so
          // the host came back as a guest and a host-only room fell open to everyone.
          hostToken: mintHostToken(roomCode),
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

          // Rebuilding is not the same as being the host. Anyone who knows the code can
          // ask for a rebuild, and the room is gone, so there is nothing to check them
          // against except a token this server itself issued. Without one, the rebuilt
          // room is a free-for-all: a stranger who waits for a party to go quiet must not
          // be able to come back as its exclusive controller and drive everyone's
          // playback (and their tab's location) when the real members reconnect.
          const rebuildIsHost = isValidHostToken(code, msg.hostToken);
          room = {
            code,
            hostId: rebuildIsHost ? userId : null,
            mode: rebuildIsHost && msg.mode === "host" ? "host" : "everyone",
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
            ownerIp: clientIp,
          };
          if (!claimRoomSlot(clientIp)) {
            sendTo(ws, { type: "error", message: "You already have too many rooms open. Close one and try again." });
            return;
          }
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

        // Reclaim host. The same person coming back to their own room after a reload, a
        // browser restart or a dropped connection arrives as a brand new user id, so
        // without this they were a guest in the party they started.
        const reclaimsHost = isValidHostToken(code, msg.hostToken);
        if (reclaimsHost) {
          room.hostId = userId;
          // They only reloaded. Call off the pending unlock.
          if (room.hostAbsenceTimer) {
            clearTimeout(room.hostAbsenceTimer);
            room.hostAbsenceTimer = null;
          }
        }
        // A room whose host never came back has nobody steering; the first arrival takes it.
        if (room.hostId === null) room.hostId = userId;

        room.members.set(userId, { ws, userName, adActive: false });
        room.peakMembers = Math.max(room.peakMembers || 0, room.members.size);
        // A new arrival is watching the film, so a room that was entirely in ads is not
        // any more.
        updateRoomAdFreeze(room);
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
          // Only ever handed back to someone who already proved they hold it.
          hostToken: reclaimsHost ? mintHostToken(code) : undefined,
          videoUrl: room.videoUrl || "",
          serverTime: Date.now(),
          playbackState: {
            ...room.playbackState,
            timestamp: positionTimestamp(room),
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
        // isFinite, not isNaN. parseFloat("Infinity") is a number and isNaN(Infinity) is
        // false, so an isNaN guard passes it straight through to every peer, where
        // video.currentTime = Infinity breaks the player. The rebuild path already
        // guarded this; the live path is the one that actually gets used.
        if (!isFinite(currentTime) || currentTime < 0) return;
        if (!isFinite(playbackRate) || playbackRate < 0.1 || playbackRate > 16) return;

        room.playbackState = {
          playing: !!msg.playing,
          currentTime,
          playbackRate,
          lastUpdate: Date.now(),
        };
        // Somebody is demonstrably watching the film, so the clock is running whatever we
        // believed a moment ago.
        const syncMember = room.members.get(userId);
        if (syncMember) syncMember.adActive = false;
        updateRoomAdFreeze(room);
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

        // And in a host-only room, only from the host. The `sync` path has always checked
        // this; the heartbeat path never did, which did not matter while the leader was
        // almost always the host. It matters now that the leader role deliberately steps
        // over anybody in an ad break: the host hits a routine advert, a guest inherits the
        // role, and that guest's self-reported position starts driving the host's own
        // video. That is exactly what host-only mode exists to prevent.
        if (rm.mode === "host" && rm.hostId !== userId) return;

        const ct = parseFloat(msg.currentTime);
        const pr = parseFloat(msg.playbackRate) || 1;
        if (!isFinite(ct) || ct < 0) return;
        if (!isFinite(pr) || pr < 0.1 || pr > 16) return;

        rm.playbackState = {
          playing: !!msg.playing,
          currentTime: ct,
          playbackRate: pr,
          lastUpdate: Date.now(),
        };
        const hbMember = rm.members.get(userId);
        if (hbMember) hbMember.adActive = false;
        updateRoomAdFreeze(rm);
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
          // Frozen means "nobody has been watching, do not add the elapsed time".
          timestamp: positionTimestamp(rs),
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

      // Who is currently sitting out an ad. Two things depend on knowing this, and neither
      // can be worked out from silence alone: the room clock has to stop when every member
      // is in a break, and the sync leader should not be somebody who has deliberately
      // stopped broadcasting. It also lets the others see why one person went quiet.
      case "ad-state": {
        if (!currentRoom) return;
        const adRoom = rooms.get(currentRoom);
        if (!adRoom) return;
        const adMember = adRoom.members.get(userId);
        if (!adMember) return;

        const wasLeader = getHeartbeatLeader(adRoom);
        adMember.adActive = !!msg.active;
        adRoom.lastActivity = Date.now();
        updateRoomAdFreeze(adRoom);

        broadcastToRoom(currentRoom, {
          type: "ad-state",
          userId,
          userName,
          active: adMember.adActive,
          // How many people are watching the film right now, as opposed to an advert.
          watchingCount: Array.from(adRoom.members.values()).filter((m) => !m.adActive).length,
          memberCount: adRoom.members.size,
        }, ws);

        // The leader may have just walked into an ad, or come back out of one.
        if (getHeartbeatLeader(adRoom) !== wasLeader) notifyHeartbeatLeader(adRoom);
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
  }

  function leaveCurrentRoom() {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) {
      const wasHost = room.hostId === userId;
      const wasVoiceActive = !!(room.members.get(userId)?.voiceActive);
      room.members.delete(userId);
      // If the one person still watching just left, the rest are all in ads and the clock
      // should stop rather than run on without them.
      updateRoomAdFreeze(room);

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

        // If the host left, hand the controls to someone still here, but give the host a
        // moment to prove they only reloaded before the room actually unlocks.
        if (wasHost) {
          const nextHostId = room.members.keys().next().value;
          room.hostId = nextHostId;
          const newHost = room.members.get(nextHostId);
          if (newHost) {
            sendTo(newHost.ws, { type: "host-transferred", isHost: true });
          }
          if (room.mode === "host") {
            if (room.hostAbsenceTimer) clearTimeout(room.hostAbsenceTimer);
            const lockedCode = currentRoom;
            room.hostAbsenceTimer = setTimeout(() => {
              const r = rooms.get(lockedCode);
              if (!r) return;
              r.hostAbsenceTimer = null;
              if (r.mode !== "host") return;
              r.mode = "everyone";
              broadcastToRoom(lockedCode, {
                type: "mode-changed",
                mode: "everyone",
                fromUser: "System",
              });
            }, HOST_ABSENCE_GRACE_MS);
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

// A crash here is not one user's problem, it is every party on the box dropping at once.
// Log loudly and stay up: a server that is still relaying is strictly better than one
// that exits and takes an hour of everyone's film with it.
// A caught value can be anything a throw site felt like throwing, so read a stack only if
// there actually is one rather than assuming an Error.
function describeError(err) {
  if (err && typeof err === "object" && "stack" in err && err.stack) return String(err.stack);
  return String(err);
}

process.on("uncaughtException", (err) => {
  console.error(`[fatal] uncaughtException: ${describeError(err)}`);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[fatal] unhandledRejection: ${describeError(reason)}`);
});

// --- Start ---
server.listen(PORT, () => {
  console.log(`[start] Watch Together server running on port ${PORT}`);
  console.log(`[start] Max rooms: ${MAX_ROOMS}, Max members/room: ${MAX_ROOM_MEMBERS}, Room TTL: ${ROOM_TTL_MS / 3600000}h`);
  if (SERVER_MOVED_VALID) {
    console.log(`[start] RETIRED: telling every client to move to ${SERVER_MOVED_URL}`);
  }

  // NOTE: there used to be a 13-minute self-ping to http://localhost here, meant to keep
  // the Render free tier from sleeping. It never worked. Render's idle timer counts
  // requests that arrive through its front door; a request the process makes to itself
  // never leaves the container, so the service still spun down and users still hit a cold
  // start plus the room-rebuild path. Keeping it alive needs an EXTERNAL pinger hitting
  // the public /health URL (cron-job.org, UptimeRobot, a GitHub Actions schedule). See
  // DEPLOY.md. Burning a timer to fake it only hid the problem.
});
