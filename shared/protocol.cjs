"use strict";

// The wire protocol, defined once, for both relays.
//
// server/server.js and server-cf/src/worker.js implement the same protocol on two
// runtimes, and until this file existed they each carried their own copy of every limit,
// every regex and every validator. That is exactly the arrangement that produced the
// background.js / background-firefox.js class of bug on the extension side, and it
// produced the same class here: the Cloudflare port, which is what production actually
// runs, was silently missing guards its Node twin had. A value that lives in two files
// does not stay in step, it only looks like it does until somebody reads both.
//
// CommonJS on purpose. Render runs `node server.js` on Node 20, where a CJS entry point
// cannot require an ES module, and wrangler bundles CJS for the Worker without complaint.
// One format both runtimes accept beats two files that agree by hand.
//
// Anything in here is shared BEHAVIOUR. Deployment knobs stay with each server: the Node
// twin reads env overrides so the test suite does not have to sit through a real minute,
// and the Worker takes the defaults because a Worker secret is not a per-test knob.

// ---- Message types ----
//
// Every type either relay will act on. A message the wire carries and this list does not
// name is a message one server handles and the other drops, which presents as a room that
// syncs for some people and not others, with nothing logged anywhere. A gate test asserts
// both switch statements match this list exactly.
const MESSAGE_TYPES = Object.freeze({
  CREATE_ROOM: "create-room",
  JOIN_ROOM: "join-room",
  LEAVE_ROOM: "leave-room",
  SYNC: "sync",
  HEARTBEAT: "heartbeat",
  REQUEST_STATE: "request-state",
  CHAT: "chat",
  CHAT_TYPING: "chat-typing",
  CC_STATE: "cc-state",
  PRESENCE: "presence",
  // The older, narrower spelling of `presence`. Still accepted, because an extension
  // release takes days of store review and the previous version stays installed
  // throughout: the server is permanently talking to clients it cannot upgrade.
  AD_STATE: "ad-state",
  PING: "ping",
  SET_MODE: "set-mode",
  SET_CALL_URL: "set-call-url",
  NAVIGATE: "navigate",
  VOICE_STATE: "voice-state",
  VOICE_SIGNAL: "voice-signal",
});

const CLIENT_MESSAGE_TYPES = Object.freeze(Object.values(MESSAGE_TYPES));

// Messages that do NOT prove the sender is watching the film.
//
// Every other message from a member is evidence they are back from their ad break, and
// both relays use it to clear the flag. That path is not a nicety: `ad-state` is edge
// triggered, so a "my break ended" that is lost to a dropped socket leaves that member
// marked dark forever. If every member is marked dark the room's clock stays frozen, and
// the party sits there watching a film that will not advance.
//
// A ping is excluded because it says "we are still here", not "I am watching". Counting it
// as proof would unfreeze the clock during the very break the freeze exists for.
/** @type {readonly string[]} */
const NOT_PROOF_OF_WATCHING = Object.freeze([
  MESSAGE_TYPES.AD_STATE,
  MESSAGE_TYPES.PRESENCE,
  MESSAGE_TYPES.PING,
]);

/** True when this message is evidence its sender is out of their ad break. */
function provesWatching(type) {
  return typeof type === "string" && !NOT_PROOF_OF_WATCHING.includes(type);
}

// ---- Room state enums ----

// What a member can be doing. "buffering" is not an ad break: it does not stop the room's
// clock, because the film really is playing for everybody else. It only disqualifies that
// member from driving everyone's position while their own is stalled.
const PRESENCE_STATES = Object.freeze(["watching", "ad", "buffering"]);
const PRESENCE_DEFAULT = "watching";

// Who may drive playback. "everyone" is the default; "host" narrows it to one person.
const ROOM_MODES = Object.freeze(["everyone", "host"]);
const ROOM_MODE_DEFAULT = "everyone";

/** The mode a client asked for, or the default. Never trusts the value through. */
function normalizeRoomMode(value) {
  return value === "host" ? "host" : ROOM_MODE_DEFAULT;
}

// ---- Route paths ----
//
// Both relays serve these, and the extension builds the shareable invite from JOIN.
const ROUTES = Object.freeze({
  HEALTH: "/health",
  ROOM: "/room/",
  JOIN: "/join/",
});

// ---- Limits and timeouts ----
//
// Defaults. The Node twin layers env overrides on top of these; the Worker uses them as
// they stand. The one rule that is not arbitrary: the client's heartbeat ceiling must stay
// under LEADER_STALE_MS, or the watchdog demotes a leader who is healthy and merely quiet.
const LIMITS = Object.freeze({
  MAX_ROOM_MEMBERS: 50,
  MAX_ROOMS: 10000,
  MAX_MESSAGE_SIZE: 4096,
  MAX_CHAT_LENGTH: 500,
  MAX_USERNAME_LENGTH: 30,
  MAX_CONNECTIONS_PER_IP: 10,
  MAX_VIDEO_URL_LENGTH: 2000,
  MAX_CALL_URL_LENGTH: 500,
  MAX_VOICE_SIGNAL_BYTES: 8192,
  // How many rooms one address may be holding at once. This, not a deletion heuristic, is
  // what stops a flood: rooms outlive their sockets by design, so limiting the RATE of
  // creation alone still lets them accumulate.
  MAX_LIVE_ROOMS_PER_IP: 20,
  RATE_LIMIT_MAX: 20,
  ROOM_CREATE_MAX: 60,
  // Joining a room you cannot name is guessing. A wrong code is free to send and the reply
  // says whether the room exists, so without a ceiling one socket can walk the code space
  // looking for somebody else's party. Well clear of any real person: a human mistypes a
  // six character code once or twice, not thirty times a minute.
  FAILED_JOIN_MAX: 30,
});

const TIMEOUTS = Object.freeze({
  RATE_LIMIT_WINDOW: 1000,
  ROOM_CREATE_WINDOW_MS: 60000,
  FAILED_JOIN_WINDOW_MS: 60000,
  ROOM_TTL_MS: 12 * 3600000,
  PERSISTENT_ROOM_TTL_MS: 30 * 24 * 3600000,
  // 30 minutes, not 60 seconds: closing the tab, restarting the browser, rebooting, or
  // riding out a dead wifi stretch all take longer than a minute, and the party came back
  // to "Room not found". An empty room costs one map entry.
  EMPTY_ROOM_GRACE_MS: 30 * 60000,
  PERSISTENT_ROOM_EMPTY_GRACE_MS: 7 * 24 * 3600000,
  // The window a sync leader may be silent for before the job is handed on.
  //
  // It used to be 15s, described as "three missed beats at a 5s heartbeat", and that
  // description stopped being true when the client's heartbeat grew an adaptive cadence
  // that eases out to a 12s ceiling while a room is in sync. Three seconds of slack is a
  // quarter of one beat, so ordinary jitter on a single beat demoted leaders who were
  // healthy and merely quiet. This value must always stay comfortably above that ceiling.
  LEADER_STALE_MS: 20000,
  LEADER_SWEEP_MS: 5000,
  // A host who reloads must keep their locked room; a host who leaves must not leave
  // everybody else locked out of a room nobody can drive.
  HOST_ABSENCE_GRACE_MS: 60000,
  // A connection that never recovers must not hold four other people hostage.
  WAIT_FOR_SLOW_MAX_MS: 60000,
  ROOM_CLEANUP_INTERVAL: 60000,
  WS_PING_INTERVAL: 30000,
});

// ---- Shapes ----

// The shape generateRoomCode hands out. No I, O, 0 or 1: they read the same out loud, and
// a code's whole job is to survive being said down a phone.
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_REGEX = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const CUSTOM_NAME_REGEX = /^[a-zA-Z0-9-]{4,32}$/;
const USER_ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const USER_ID_LENGTH = 8;

// A video-call link the room can share. An allowlist of the platforms people actually use
// rather than "any https URL", because this becomes a button every member is invited to
// press, so a free-text field would be a convenient way to get a room full of people to
// click on anything at all. Kept in step with CALL_HOSTS in extension/config.js.
const CALL_HOSTS = Object.freeze([
  "zoom.us",
  "zoomgov.com",
  "meet.google.com",
  "teams.microsoft.com",
  "teams.live.com",
  "discord.gg",
  "discord.com",
  "whereby.com",
  "meet.jit.si",
]);

// ---- Random ----

// getRandomValues rather than Math.random, and this is not theatre.
//
// The room code is the ONLY credential this system has. Holding one lets you read the
// party's chat, see the address of everything they watch, and, in a room in its default
// mode, seek their film and send every member's tab to any http(s) address you like.
// Math.random is a fast non-cryptographic generator whose internal state is recoverable
// from a handful of outputs, so an attacker who makes a few rooms of their own and reads
// their codes can predict the codes handed to strangers on the same process. Codes must
// be unguessable for the same reason a session token is.
//
// globalThis.crypto rather than node:crypto or the Workers global: it is the one spelling
// both runtimes answer to, and server.js shadows the name `crypto` with the Node module.
function randomChars(alphabet, length) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    // 32 divides 256, so masking a byte is uniform for the room-code alphabet. The user-id
    // alphabet is 36, which does not, so reject the tail rather than fold it: folding
    // makes the first four characters likelier and shrinks the space for free.
    let b = bytes[i];
    if (256 % alphabet.length !== 0) {
      const ceiling = 256 - (256 % alphabet.length);
      while (b >= ceiling) {
        const one = new Uint8Array(1);
        globalThis.crypto.getRandomValues(one);
        b = one[0];
      }
    }
    out += alphabet[b % alphabet.length];
  }
  return out;
}

/**
 * A room code nobody is holding. `isTaken` is the caller's view of live rooms, because the
 * Node server keeps them in a Map and the Worker in a Durable Object cache.
 */
function generateRoomCode(isTaken) {
  let code;
  do {
    code = randomChars(ROOM_CODE_CHARS, ROOM_CODE_LENGTH);
  } while (typeof isTaken === "function" ? isTaken(code) : false);
  return code;
}

function generateUserId() {
  return randomChars(USER_ID_CHARS, USER_ID_LENGTH);
}

// ---- Validators ----
//
// Both relays run these on everything a client sends. The extension validates too, but a
// user is free to point it at any relay and an attacker is free to skip the extension
// entirely, so the server can never treat a client-side check as a control.

function sanitize(str, maxLen) {
  if (typeof str !== "string") return "";
  return str.substring(0, maxLen).trim();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A video URL a room may point at, or "" for anything else. */
function validateUrl(str) {
  if (typeof str !== "string") return "";
  const trimmed = str.substring(0, LIMITS.MAX_VIDEO_URL_LENGTH).trim();
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) return trimmed;
  return "";
}

/** A call link the room may pin, or "" for anything else. */
function validateCallUrl(str) {
  if (typeof str !== "string") return "";
  const trimmed = str.trim().substring(0, LIMITS.MAX_CALL_URL_LENGTH);
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed);
    // Zoom's own scheme, which opens the installed client straight into the meeting.
    if (u.protocol === "zoommtg:" || u.protocol === "zoomus:") return trimmed;
    if (u.protocol !== "https:") return "";
    const host = u.hostname.toLowerCase();
    return CALL_HOSTS.some((d) => host === d || host.endsWith("." + d)) ? trimmed : "";
  } catch {
    return "";
  }
}

/** A room key either relay could have issued. Anything else is not a room. */
function isIssuableRoomKey(code) {
  return typeof code === "string" && (ROOM_CODE_REGEX.test(code) || CUSTOM_NAME_REGEX.test(code));
}

// The longest position we will carry, in seconds. A week is far past any film, any
// episode and any single sitting of a livestream, and short enough that the number stays
// a plausible position rather than a weapon.
const MAX_PLAYBACK_TIME = 7 * 24 * 3600;

/**
 * A playback position we are willing to hand to a real player, or null.
 *
 * isFinite, not isNaN: parseFloat("Infinity") is a number and isNaN(Infinity) is false, so
 * an isNaN guard relays it to every peer, where video.currentTime = Infinity breaks the
 * player for somebody who did nothing wrong.
 *
 * The upper bound is the other half of that, and it was missing. isFinite(1e308) is true
 * and 1e308 >= 0, so it passed every guard, became the room's authoritative position, and
 * was broadcast to everybody: one malformed or hostile message corrupted the shared clock
 * for the whole party until the next good heartbeat overwrote it.
 */
function validPlaybackTime(value) {
  const n = parseFloat(value);
  return isFinite(n) && n >= 0 && n <= MAX_PLAYBACK_TIME ? n : null;
}

/** A playback rate a player will accept. Outside this range is a hostile or broken client. */
function validPlaybackRate(value) {
  const n = parseFloat(value) || 1;
  return isFinite(n) && n >= 0.1 && n <= 16 ? n : null;
}

// A hit counter with a window, used for every per-address budget on both relays. Shared
// because the Worker's copy grew a room-creation check the Node twin's did not have, and
// neither ever pruned itself: a Map keyed by client address that only ever grows is a slow
// memory leak on Node and an unbounded object on a Durable Object that never restarts.
class WindowedLimiter {
  constructor(windowMs, max) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }

  /** True while the caller is inside its budget. Counts the attempt either way. */
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

  /** Drop expired windows. Without this the map is a leak keyed by every address seen. */
  cleanup() {
    const now = Date.now();
    for (const [id, entry] of this.hits) {
      if (now > entry.resetAt) this.hits.delete(id);
    }
  }
}

module.exports = {
  MESSAGE_TYPES,
  CLIENT_MESSAGE_TYPES,
  NOT_PROOF_OF_WATCHING,
  provesWatching,
  PRESENCE_STATES,
  PRESENCE_DEFAULT,
  ROOM_MODES,
  ROOM_MODE_DEFAULT,
  normalizeRoomMode,
  ROUTES,
  LIMITS,
  TIMEOUTS,
  ROOM_CODE_CHARS,
  ROOM_CODE_LENGTH,
  ROOM_CODE_REGEX,
  CUSTOM_NAME_REGEX,
  USER_ID_CHARS,
  USER_ID_LENGTH,
  CALL_HOSTS,
  randomChars,
  generateRoomCode,
  generateUserId,
  sanitize,
  escapeHtml,
  validateUrl,
  validateCallUrl,
  isIssuableRoomKey,
  MAX_PLAYBACK_TIME,
  validPlaybackTime,
  validPlaybackRate,
  WindowedLimiter,
};
