// The wire protocol itself, pinned.
//
// Everything here used to be checked by a person reading two files side by side and
// believing they matched. They did not. The Cloudflare relay, which is what production
// runs, was missing four guards its Node twin had, and the comment at the top of it said
// "kept in lockstep with the Node twin" the entire time. A comment is not a check.
//
// Two kinds of test live here:
//
//   1. Drift gates, which read the real source of both relays and the real extension
//      config and fail when they stop agreeing. These are cheap and they are the only
//      thing that can catch a value being changed in one place and not the other.
//   2. Behaviour of the shared validators, which now run on both relays, so a bug fixed
//      here is fixed on both at once and a test here covers both at once.
//
// Deliberately static where it can be. A test that has to stand a server up can only
// check the paths it thinks to exercise; a test that reads the source catches the case
// nobody thought of, which is the case that ships.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const require = createRequire(import.meta.url);
const P = require("../shared/protocol.cjs");

const nodeServerSrc = readFileSync(join(repoRoot, "server", "server.js"), "utf8");
const workerSrc = readFileSync(join(repoRoot, "server-cf", "src", "worker.js"), "utf8");
const contentSrc = readFileSync(join(repoRoot, "extension", "content.js"), "utf8");

/** The real extension config, loaded exactly as a browser loads it. */
function loadExtensionConfig() {
  const scope = {};
  const context = vm.createContext({ self: scope, window: scope, console, URL, URLSearchParams });
  vm.runInContext(readFileSync(join(repoRoot, "extension", "config.js"), "utf8"), context, { filename: "config.js" });
  return scope.__wtConfig;
}
const config = loadExtensionConfig();

/** Every `case "..."` label in a relay's message dispatch. */
function dispatchedTypes(src) {
  return new Set([...src.matchAll(/case\s+"([a-z-]+)"\s*:/g)].map((m) => m[1]));
}

// ---------------------------------------------------------------------------
// Drift gates: the two relays
// ---------------------------------------------------------------------------

test("drift: both relays dispatch exactly the message types the protocol names", () => {
  const declared = new Set(P.CLIENT_MESSAGE_TYPES);
  for (const [name, src] of [["node", nodeServerSrc], ["worker", workerSrc]]) {
    const handled = dispatchedTypes(src);
    for (const type of handled) {
      assert.ok(declared.has(type), `${name} handles "${type}", which shared/protocol.cjs does not name`);
    }
    for (const type of declared) {
      assert.ok(handled.has(type), `shared/protocol.cjs names "${type}", which the ${name} relay never handles`);
    }
  }
});

test("drift: the two relays handle the same set of message types as each other", () => {
  // The failure this catches directly. A type one relay acts on and the other drops is a
  // room that syncs for some people and not others, depending only on which relay their
  // extension happened to reach, with nothing logged anywhere.
  const node = dispatchedTypes(nodeServerSrc);
  const worker = dispatchedTypes(workerSrc);
  assert.deepEqual([...node].sort(), [...worker].sort());
});

test("drift: neither relay restates a shared limit as its own literal", () => {
  // Not a style rule. Every one of these numbers was written out twice, and the copies
  // stopped matching: the empty-room grace was 60 seconds on one relay for a long time
  // after it was deliberately widened to 30 minutes on the other, and parties came back
  // to "Room not found".
  const shared = [
    ["MAX_ROOM_MEMBERS", P.LIMITS.MAX_ROOM_MEMBERS],
    ["MAX_ROOMS", P.LIMITS.MAX_ROOMS],
    ["MAX_MESSAGE_SIZE", P.LIMITS.MAX_MESSAGE_SIZE],
    ["MAX_CHAT_LENGTH", P.LIMITS.MAX_CHAT_LENGTH],
    ["MAX_USERNAME_LENGTH", P.LIMITS.MAX_USERNAME_LENGTH],
    ["MAX_CONNECTIONS_PER_IP", P.LIMITS.MAX_CONNECTIONS_PER_IP],
    ["MAX_LIVE_ROOMS_PER_IP", P.LIMITS.MAX_LIVE_ROOMS_PER_IP],
    ["RATE_LIMIT_MAX", P.LIMITS.RATE_LIMIT_MAX],
    ["ROOM_CREATE_MAX", P.LIMITS.ROOM_CREATE_MAX],
    ["LEADER_STALE_MS", P.TIMEOUTS.LEADER_STALE_MS],
    ["LEADER_SWEEP_MS", P.TIMEOUTS.LEADER_SWEEP_MS],
    ["HOST_ABSENCE_GRACE_MS", P.TIMEOUTS.HOST_ABSENCE_GRACE_MS],
    ["WAIT_FOR_SLOW_MAX_MS", P.TIMEOUTS.WAIT_FOR_SLOW_MAX_MS],
    ["ROOM_CREATE_WINDOW_MS", P.TIMEOUTS.ROOM_CREATE_WINDOW_MS],
    ["RATE_LIMIT_WINDOW", P.TIMEOUTS.RATE_LIMIT_WINDOW],
    ["MAX_VOICE_SIGNAL_BYTES", P.LIMITS.MAX_VOICE_SIGNAL_BYTES],
    ["PERSISTENT_ROOM_EMPTY_GRACE_MS", P.TIMEOUTS.PERSISTENT_ROOM_EMPTY_GRACE_MS],
  ];
  for (const [name, value] of shared) {
    for (const [relay, src] of [["node", nodeServerSrc], ["worker", workerSrc]]) {
      // `const NAME = <a bare number>` is the shape that drifts. Reading it off P, or
      // layering an env override on top of P, is the shape that cannot.
      const restated = new RegExp(`const\\s+${name}\\s*=\\s*[\\d(]`);
      assert.ok(
        !restated.test(src),
        `the ${relay} relay defines ${name} as its own literal instead of reading ${value} from shared/protocol.cjs`
      );
    }
  }
});

test("drift: both relays read the shared protocol definition at all", () => {
  assert.match(nodeServerSrc, /require\("\.\.\/shared\/protocol\.cjs"\)/);
  assert.match(workerSrc, /from "\.\.\/\.\.\/shared\/protocol\.cjs"/);
});

test("drift: both relays use the shared helpers rather than their own copy of the rule", () => {
  // These are used inline rather than bound to a named constant, so the literal check
  // above cannot see them. Each one was written out twice and had to be found by reading
  // both files side by side, which is exactly the review this file exists to replace.
  const required = [
    "P.LIMITS.MAX_ACTION_LENGTH",
    "P.LIMITS.MAX_VOICE_SIGNAL_BYTES",
    "P.normalizeRoomMode",
    "P.validPlaybackTime",
    "P.validPlaybackRate",
    "P.provesWatching",
  ];
  for (const helper of required) {
    for (const [relay, src] of [["node", nodeServerSrc], ["worker", workerSrc]]) {
      assert.ok(src.includes(helper), `the ${relay} relay does not use ${helper}, so it has its own copy of that rule`);
    }
  }
  // And nobody re-implements the mode ternary by hand any more.
  for (const [relay, src] of [["node", nodeServerSrc], ["worker", workerSrc]]) {
    assert.ok(
      !/=== "host" \? "host" : "everyone"/.test(src),
      `the ${relay} relay still spells out the room-mode rule instead of calling P.normalizeRoomMode`
    );
  }
});

test("drift: room codes come from a CSPRNG on both relays, never Math.random", () => {
  // A room code is the only credential this system has. Math.random's internal state is
  // recoverable from a handful of its own outputs, so an attacker who made a few rooms
  // could predict the codes being handed to strangers on the same process.
  // The call, not the word: both files explain in a comment why they do not use it.
  const called = /Math\.random\s*\(/;
  for (const [relay, src] of [["node", nodeServerSrc], ["worker", workerSrc]]) {
    assert.ok(!called.test(src), `the ${relay} relay still calls Math.random somewhere`);
  }
  assert.ok(!called.test(readFileSync(join(repoRoot, "shared", "protocol.cjs"), "utf8")));
});

// ---------------------------------------------------------------------------
// Drift gates: the extension, which cannot import any of this
// ---------------------------------------------------------------------------
//
// extension/config.js is loaded by the browser as a plain script with no bundler, so it
// genuinely cannot require shared/protocol.cjs. It is the one surface where a second copy
// is unavoidable, which makes it the one surface that needs a gate.

test("drift: the extension and the relays agree on which call links are allowed", () => {
  // This one is not cosmetic. The link becomes a button a whole room is invited to press,
  // so a host allowed to pin something the client would have refused, or the reverse, is
  // either a broken feature or a way to point a room full of people at anything at all.
  assert.deepEqual([...config.CALL_HOSTS].sort(), [...P.CALL_HOSTS].sort());
});

test("drift: the extension and the relays agree on what a room code looks like", () => {
  // Not regex identity: the client uppercases before testing and the relays accept either
  // case and uppercase afterwards, so the sources legitimately differ. What must match is
  // the ANSWER, for anything a person could type into the join box.
  const cases = [
    "ABC234", "abc234", "ABCDEF", "AB1234", "ABC23", "ABC2345",
    "FILM-CLUB", "film-club", "movie", "MOV", "a".repeat(32), "a".repeat(33),
    "not a code", "ABC 34", "../etc/passwd", "", "AAAAAA'; DROP",
  ];
  for (const raw of cases) {
    const client = config.isJoinableCode(raw);
    const relay = P.isIssuableRoomKey(raw.toUpperCase());
    assert.equal(client, relay, `client and relay disagree about whether "${raw}" is a room code`);
  }
});

test("drift: the extension and the relays speak the same protocol version", () => {
  const nodeVersion = /const PROTOCOL_VERSION = (\d+)/.exec(nodeServerSrc)?.[1];
  const workerVersion = /const PROTOCOL_VERSION = (\d+)/.exec(workerSrc)?.[1];
  assert.equal(Number(nodeVersion), config.PROTOCOL_VERSION);
  assert.equal(Number(workerVersion), config.PROTOCOL_VERSION);
});

test("drift: the sync-leader watchdog stays clear of the client's own heartbeat ceiling", () => {
  // The invariant that actually bites. The client eases its heartbeat out to a ceiling
  // while a room stays in sync, and if the server's staleness window is not comfortably
  // above that ceiling it demotes a leader who is healthy and merely quiet, churning the
  // role for the whole time a room is behaving. This gate is here because the two numbers
  // live in different files on different release timescales, and the extension's copy
  // takes days of store review to change while the server's changes in seconds.
  const ceiling = Number(/const HEARTBEAT_MAX_INTERVAL = (\d+)/.exec(contentSrc)?.[1]);
  assert.ok(ceiling > 0, "could not read the client's heartbeat ceiling out of content.js");
  assert.ok(
    P.TIMEOUTS.LEADER_STALE_MS >= ceiling * 1.5,
    `LEADER_STALE_MS (${P.TIMEOUTS.LEADER_STALE_MS}) leaves too little room above the client's ${ceiling}ms heartbeat ceiling`
  );
});

// ---------------------------------------------------------------------------
// The shared validators, which now run on both relays
// ---------------------------------------------------------------------------

test("playback time: rejects everything a player cannot be given", () => {
  assert.equal(P.validPlaybackTime(0), 0);
  assert.equal(P.validPlaybackTime("421.25"), 421.25);
  assert.equal(P.validPlaybackTime(-1), null, "negative");
  assert.equal(P.validPlaybackTime("Infinity"), null, "parseFloat('Infinity') is a number, and isNaN says it is fine");
  assert.equal(P.validPlaybackTime(Infinity), null);
  assert.equal(P.validPlaybackTime(NaN), null);
  assert.equal(P.validPlaybackTime("nonsense"), null);
  assert.equal(P.validPlaybackTime(null), null);
  assert.equal(P.validPlaybackTime({}), null);
  // The half that was missing: isFinite(1e308) is true and 1e308 is not negative, so it
  // passed every guard, became the room's authoritative position, and went out to everyone.
  assert.equal(P.validPlaybackTime(1e308), null, "an absurd position is not a position");
  assert.equal(P.validPlaybackTime(P.MAX_PLAYBACK_TIME + 1), null);
  assert.equal(P.validPlaybackTime(P.MAX_PLAYBACK_TIME), P.MAX_PLAYBACK_TIME);
});

test("playback rate: only rates a real player will accept", () => {
  assert.equal(P.validPlaybackRate(1), 1);
  assert.equal(P.validPlaybackRate(2), 2);
  assert.equal(P.validPlaybackRate(undefined), 1, "absent means normal speed");
  assert.equal(P.validPlaybackRate(0.05), null);
  assert.equal(P.validPlaybackRate(17), null);
  assert.equal(P.validPlaybackRate(Infinity), null);
  assert.equal(P.validPlaybackRate(-1), null);
});

test("call links: an allowlist, not a free text field", () => {
  assert.equal(P.validateCallUrl("https://zoom.us/j/123"), "https://zoom.us/j/123");
  assert.equal(P.validateCallUrl("https://acme.zoom.us/j/123"), "https://acme.zoom.us/j/123", "subdomains of an allowed host");
  assert.equal(P.validateCallUrl("zoommtg://zoom.us/join?confno=1"), "zoommtg://zoom.us/join?confno=1");
  assert.equal(P.validateCallUrl("https://evil.example/j/123"), "");
  assert.equal(P.validateCallUrl("https://notzoom.us/j/1"), "", "a host that merely ends in the wrong place");
  assert.equal(P.validateCallUrl("http://zoom.us/j/123"), "", "plain http is not carried");
  assert.equal(P.validateCallUrl("javascript:alert(1)"), "");
  assert.equal(P.validateCallUrl("data:text/html,<script>"), "");
  assert.equal(P.validateCallUrl(""), "");
  assert.equal(P.validateCallUrl(null), "");
  assert.equal(P.validateCallUrl("https://zoom.us/" + "a".repeat(5000)).length <= P.LIMITS.MAX_CALL_URL_LENGTH, true);
});

test("video urls: only somewhere a tab can actually be sent", () => {
  assert.equal(P.validateUrl("https://youtube.com/watch?v=x"), "https://youtube.com/watch?v=x");
  assert.equal(P.validateUrl("http://localhost:8080/v"), "http://localhost:8080/v");
  assert.equal(P.validateUrl("javascript:alert(1)"), "", "survives new URL() and would run in whatever origin is open");
  assert.equal(P.validateUrl("data:text/html,<script>alert(1)</script>"), "");
  assert.equal(P.validateUrl("file:///etc/passwd"), "");
  assert.equal(P.validateUrl(42), "");
  assert.equal(P.validateUrl("https://x/" + "a".repeat(9000)).length <= P.LIMITS.MAX_VIDEO_URL_LENGTH, true);
});

test("room keys: only a shape a relay could have issued", () => {
  assert.equal(P.isIssuableRoomKey("ABC234"), true);
  assert.equal(P.isIssuableRoomKey("FILM-CLUB"), true);
  // Five characters is not a generated code, but it IS a legal custom name, and a room
  // may be keyed by either. The check is "could a relay have issued this", not "is this a
  // generated code": rooms named by their party are the whole point of custom names.
  assert.equal(P.isIssuableRoomKey("ABC23"), true, "short, but a valid custom name");
  assert.equal(P.isIssuableRoomKey("ABC"), false, "below the custom-name floor as well");
  assert.equal(P.ROOM_CODE_REGEX.test("ABCI23"), false, "I is not in the generated alphabet, because it is read aloud as 1");
  assert.equal(P.isIssuableRoomKey("../../etc"), false);
  assert.equal(P.isIssuableRoomKey("ABC 23"), false, "a space is not in either shape");
  assert.equal(P.isIssuableRoomKey("a".repeat(4096)), false, "a client must not be able to key a room by any string it likes");
  assert.equal(P.isIssuableRoomKey(null), false);
  assert.equal(P.isIssuableRoomKey({}), false);
});

test("escaping: survives values that are not strings at all", () => {
  assert.equal(P.escapeHtml("<script>"), "&lt;script&gt;");
  assert.equal(P.escapeHtml("a\"b'c&d"), "a&quot;b&#39;c&amp;d");
  // It used to be called on the result of a validation that can return a non-string, and
  // String.prototype.replace on undefined throws, which on the Node relay is a 500 rather
  // than a page.
  assert.equal(P.escapeHtml(undefined), "undefined");
  assert.equal(P.escapeHtml(7), "7");
});

test("sanitize: caps length and refuses anything that is not text", () => {
  assert.equal(P.sanitize("  hello  ", 30), "hello");
  assert.equal(P.sanitize("x".repeat(100), 30).length, 30);
  assert.equal(P.sanitize(null, 30), "");
  assert.equal(P.sanitize({ toString: () => "evil" }, 30), "", "an object that stringifies is still not a string");
});

test("ad flag: every message except the three that prove nothing clears it", () => {
  // The rule that stops a lost "my break ended" freezing a room forever. A ping is
  // excluded on purpose: it says the party is still there, not that anyone is watching,
  // and counting it would unfreeze the clock during the very break the freeze exists for.
  assert.equal(P.provesWatching(P.MESSAGE_TYPES.SYNC), true);
  assert.equal(P.provesWatching(P.MESSAGE_TYPES.HEARTBEAT), true);
  assert.equal(P.provesWatching(P.MESSAGE_TYPES.CHAT), true);
  assert.equal(P.provesWatching(P.MESSAGE_TYPES.PING), false);
  assert.equal(P.provesWatching(P.MESSAGE_TYPES.AD_STATE), false);
  assert.equal(P.provesWatching(P.MESSAGE_TYPES.PRESENCE), false);
  assert.equal(P.provesWatching(null), false);
});

test("room mode: anything that is not the locked mode is the open one", () => {
  assert.equal(P.normalizeRoomMode("host"), "host");
  assert.equal(P.normalizeRoomMode("everyone"), "everyone");
  assert.equal(P.normalizeRoomMode("HOST"), "everyone", "not a mode we issue");
  assert.equal(P.normalizeRoomMode(undefined), "everyone");
  assert.equal(P.normalizeRoomMode({}), "everyone");
});

// ---------------------------------------------------------------------------
// Room codes
// ---------------------------------------------------------------------------

test("room codes: the right shape, and never one that is already taken", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const code = P.generateRoomCode((c) => seen.has(c));
    assert.match(code, P.ROOM_CODE_REGEX);
    assert.equal(seen.has(code), false, "generateRoomCode handed out a code the caller said was taken");
    seen.add(code);
  }
});

test("room codes: every position uses the whole alphabet, so the space is the size it looks", () => {
  // A generator that folds a byte into an alphabet that does not divide 256 makes the
  // first characters likelier than the last, which quietly shrinks the keyspace. Weak
  // as a randomness test on purpose: it is here to catch a broken generator, not to
  // certify entropy, and it must not fail on an unlucky night.
  const perPosition = Array.from({ length: P.ROOM_CODE_LENGTH }, () => new Set());
  for (let i = 0; i < 3000; i++) {
    const code = P.generateRoomCode(() => false);
    for (let pos = 0; pos < P.ROOM_CODE_LENGTH; pos++) perPosition[pos].add(code[pos]);
  }
  for (let pos = 0; pos < P.ROOM_CODE_LENGTH; pos++) {
    assert.equal(perPosition[pos].size, P.ROOM_CODE_CHARS.length, `position ${pos} never produced some of the alphabet`);
  }
});

test("user ids: the shape the wire expects, from the same source", () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const id = P.generateUserId();
    assert.equal(id.length, P.USER_ID_LENGTH);
    assert.match(id, /^[a-z0-9]+$/);
    seen.add(id);
  }
  // Collisions are not merely untidy here: a member map is keyed by this, so a second
  // member with the same id silently replaces the first.
  assert.ok(seen.size > 1990, "user ids collided far more often than chance allows");
});

// ---------------------------------------------------------------------------
// The windowed limiter behind every per-address budget
// ---------------------------------------------------------------------------

test("limiter: lets a budget through, refuses the rest, and forgets on the next window", () => {
  const limiter = new P.WindowedLimiter(50, 3);
  assert.equal(limiter.check("a"), true);
  assert.equal(limiter.check("a"), true);
  assert.equal(limiter.check("a"), true);
  assert.equal(limiter.check("a"), false, "past the budget");
  assert.equal(limiter.check("b"), true, "one address's flood is not another's problem");
});

test("limiter: prunes itself, because a map keyed by every address ever seen is a leak", async () => {
  const limiter = new P.WindowedLimiter(10, 5);
  for (let i = 0; i < 200; i++) limiter.check(`ip-${i}`);
  assert.equal(limiter.hits.size, 200);
  await new Promise((r) => setTimeout(r, 30));
  limiter.cleanup();
  assert.equal(limiter.hits.size, 0, "expired windows are still being held");
});
