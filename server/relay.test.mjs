// Tests for extension/config.js and extension/relay.js.
//
// Note what these do differently from client-logic.test.mjs: they load and exercise the
// REAL production files, rather than re-implementing their logic here. That matters. A
// re-implementation is a second copy that can drift from the thing it claims to describe,
// and a test that passes against a stale copy is worse than no test. These two modules are
// deliberately pure (no DOM, no chrome.*), precisely so they can be loaded and checked as
// they actually ship.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "extension");

/** Load the real config.js and relay.js into a fresh scope, exactly as a browser would. */
function loadExtensionGlobals() {
  const scope = {};
  // URL and URLSearchParams are browser globals these files legitimately rely on; a bare
  // vm context has neither, and without them isSafeNavigateUrl would fail closed for
  // every input and this suite would pass while proving nothing.
  const context = vm.createContext({ self: scope, window: scope, console, URL, URLSearchParams });
  for (const file of ["config.js", "relay.js"]) {
    const src = readFileSync(join(extensionDir, file), "utf8");
    vm.runInContext(src, context, { filename: file });
  }
  return scope;
}

const { __wtConfig: config, __wtRelay: relayModule } = loadExtensionGlobals();

// ---------- config: the shared safety rules ----------

test("config: a navigate target must be an ordinary web page", () => {
  assert.equal(config.isSafeNavigateUrl("https://youtube.com/watch?v=x"), true);
  assert.equal(config.isSafeNavigateUrl("http://example.com/video"), true);
  // The one that mattered: `javascript:` parses cleanly through new URL(), and assigning
  // it to location.href runs script in whatever origin the viewer currently has open.
  assert.equal(config.isSafeNavigateUrl("javascript:alert(1)"), false);
  assert.equal(config.isSafeNavigateUrl("javascript:fetch('//evil')//"), false);
  assert.equal(config.isSafeNavigateUrl("data:text/html,<h1>hi"), false);
  assert.equal(config.isSafeNavigateUrl("file:///etc/passwd"), false);
  assert.equal(config.isSafeNavigateUrl("chrome://settings"), false);
  assert.equal(config.isSafeNavigateUrl("chrome-extension://abc/page.html"), false);
  assert.equal(config.isSafeNavigateUrl("about:blank"), false);
  assert.equal(config.isSafeNavigateUrl(""), false);
  assert.equal(config.isSafeNavigateUrl(null), false);
  assert.equal(config.isSafeNavigateUrl("not a url at all"), false);
});

test("config: only codes the server could have issued are joinable", () => {
  assert.equal(config.isJoinableCode("ABCDEF"), true, "a generated code");
  assert.equal(config.isJoinableCode("abcdef"), true, "case is normalised");
  assert.equal(config.isJoinableCode("movie-night"), true, "a custom room name");
  // The payload that used to reach an inline onclick on the join page.
  assert.equal(config.isJoinableCode("X');alert(1)//"), false);
  assert.equal(config.isJoinableCode("AB"), false, "too short");
  assert.equal(config.isJoinableCode("A".repeat(64)), false, "too long");
  assert.equal(config.isJoinableCode("<script>"), false);
  assert.equal(config.isJoinableCode(42), false);
  assert.equal(config.isJoinableCode(null), false);
});

test("config: a relay must be wss, never plaintext", () => {
  assert.equal(config.isValidServerUrl("wss://relay.example.com"), true);
  // Room codes, chat and the address of everything you watch cross this socket.
  assert.equal(config.isValidServerUrl("ws://relay.example.com"), false);
  assert.equal(config.isValidServerUrl("https://relay.example.com"), false);
  assert.equal(config.isValidServerUrl(""), false);
  assert.equal(config.isValidServerUrl(undefined), false);
});

test("config: the server URL is defined in exactly one place", () => {
  assert.ok(Array.isArray(config.SERVER_URLS) && config.SERVER_URLS.length > 0);
  assert.equal(config.SERVER_URL, config.SERVER_URLS[0], "the primary is the head of the list, not a second copy");
  assert.equal(config.HTTP_ORIGIN, config.SERVER_URL.replace(/^wss:/, "https:"), "derived, not hand-maintained");
});

// ---------- relay: choosing a backend, and moving to a new one ----------

const { RelayPicker } = relayModule;

test("relay: falls back to the built-in list when nothing else is known", () => {
  const relay = new RelayPicker();
  assert.equal(relay.current(), config.SERVER_URLS[0]);
});

test("relay: what the user chose in Settings outranks everything", () => {
  const relay = new RelayPicker();
  relay.acceptMove("wss://moved.example");
  relay.setOverride("wss://mine.example");
  assert.equal(relay.current(), "wss://mine.example");
  // Clearing it falls back rather than stranding them on a relay that does not work.
  relay.setOverride(null);
  assert.equal(relay.current(), "wss://moved.example");
});

test("relay: a bad override is refused rather than stored", () => {
  const relay = new RelayPicker();
  assert.equal(relay.setOverride("ws://plaintext.example"), null);
  assert.equal(relay.current(), config.SERVER_URLS[0]);
});

// The migration path, and the reason any of this exists: the server can be redeployed in
// seconds but the extension takes days (store review, then auto-update). So the OLD server
// is what redirects everyone to the new one.
test("relay: a server can hand its clients to a replacement", () => {
  const relay = new RelayPicker();
  assert.equal(relay.acceptMove("wss://oracle.example.com"), true);
  assert.equal(relay.current(), "wss://oracle.example.com");
});

test("relay: a move is refused unless it is real, new, and encrypted", () => {
  const relay = new RelayPicker();
  assert.equal(relay.acceptMove("ws://plaintext.example"), false, "never downgrade to cleartext");
  assert.equal(relay.acceptMove("not-a-url"), false);
  assert.equal(relay.acceptMove(""), false);
  assert.equal(relay.acceptMove(config.SERVER_URLS[0]), false, "a server pointing at where we already are must not cause a reconnect loop");
  relay.acceptMove("wss://new.example");
  assert.equal(relay.acceptMove("wss://new.example"), false, "repeating the same move changes nothing");
});

test("relay: a dead backend is skipped instead of retried forever", () => {
  const relay = new RelayPicker();
  relay.acceptMove("wss://second.example"); // now two candidates
  const first = relay.current();
  assert.equal(relay.onFailure(), false, "one failure is a blip, not a verdict");
  assert.equal(relay.onFailure(), true, "the second says this relay is not answering");
  assert.notEqual(relay.current(), first, "so try somewhere else");
});

test("relay: with only one candidate it keeps retrying rather than giving up", () => {
  // Written against a picker with exactly one place to go, rather than against however many
  // relays happen to be built in today: the behaviour under test is "do not give up when
  // there is no alternative", and that must not become untested the moment a second relay
  // is added to the list.
  const relay = new RelayPicker();
  relay.setOverride("wss://only.example");
  const single = { ...config, SERVER_URLS: [] };
  assert.equal(relay.candidates().filter((u) => u === "wss://only.example").length, 1);

  const solo = new RelayPicker();
  solo.candidates = () => ["wss://only.example"];
  solo.onFailure();
  assert.equal(solo.onFailure(), false, "nowhere else to go, so keep trying this one");
  void single;
});

test("relay: the built-in list is tried in order, primary first", () => {
  const relay = new RelayPicker();
  assert.ok(config.SERVER_URLS.length >= 1);
  assert.equal(relay.current(), config.SERVER_URLS[0], "a fresh install reaches for the primary");
  // Enough failures and it walks to the next one rather than hammering a relay that is down.
  if (config.SERVER_URLS.length > 1) {
    relay.onFailure();
    assert.equal(relay.onFailure(), true, "two failures is a verdict, not a blip");
    assert.equal(relay.current(), config.SERVER_URLS[1], "so try the fallback");
  }
});

test("relay: connecting clears the failure count", () => {
  const relay = new RelayPicker();
  relay.acceptMove("wss://second.example");
  relay.onFailure();
  relay.onConnected();
  assert.equal(relay.onFailure(), false, "the earlier failure was forgiven by a success");
});

test("relay: candidates are deduplicated", () => {
  const relay = new RelayPicker();
  const before = relay.candidates().length;
  relay.setOverride(config.SERVER_URLS[0]);
  assert.equal(
    relay.candidates().length,
    before,
    "an override equal to a built-in is the same backend, not an extra one"
  );
  assert.equal(new Set(relay.candidates()).size, relay.candidates().length, "no duplicates at all");
});

test("relay: what we learned last session is restored", () => {
  const relay = new RelayPicker();
  relay.hydrate({ serverUrl: "wss://chosen.example", movedServerUrl: "wss://moved.example" });
  assert.equal(relay.current(), "wss://chosen.example");
  assert.equal(relay.candidates().includes("wss://moved.example"), true);
  // Junk in storage must not poison the picker.
  const other = new RelayPicker();
  other.hydrate({ serverUrl: "ws://bad", movedServerUrl: 42 });
  assert.equal(other.current(), config.SERVER_URLS[0]);
});


// ---------- timelines that stop lining up ----------
// Some platforms stitch adverts into the stream itself, and when the pods are personalised
// one viewer's break runs longer than another's. From then on the same currentTime means a
// different frame for each of them. Nothing local can see it: the duration never changes
// and no marker appears. What it looks like from here is a sudden step in the gap that
// never closes, and ordinary drift correction reacts to it by seeking somebody backwards
// into adverts they already sat through.

const CLEAN = {
  buffering: false,
  paused: false,
  sinceLocalSeekMs: 999999,
  sinceAttachMs: 999999,
  navigating: false,
  sinceAskedMs: 999999,
};

test("divergence: a large unexplained step is treated as a different cut", () => {
  assert.equal(config.looksLikeTimelineDivergence(30, CLEAN), true);
  assert.equal(config.looksLikeTimelineDivergence(-30, CLEAN), true, "it works in both directions");
});

test("divergence: ordinary drift is left to drift correction", () => {
  assert.equal(config.looksLikeTimelineDivergence(2, CLEAN), false);
  assert.equal(config.looksLikeTimelineDivergence(0, CLEAN), false);
});

// Every one of these has a simpler explanation than "different cuts", and acting on the
// wrong one silently desynchronises somebody, which is worse than the gap itself.
test("divergence: anything with a simpler explanation is refused", () => {
  assert.equal(config.looksLikeTimelineDivergence(30, { ...CLEAN, buffering: true }), false,
    "falling behind on a stall closes on its own");
  assert.equal(config.looksLikeTimelineDivergence(30, { ...CLEAN, paused: true }), false,
    "a paused player drifts for the dullest possible reason");
  assert.equal(config.looksLikeTimelineDivergence(30, { ...CLEAN, sinceLocalSeekMs: 1000 }), false,
    "they just moved the playhead themselves, and meant to");
  assert.equal(config.looksLikeTimelineDivergence(30, { ...CLEAN, sinceAttachMs: 2000 }), false,
    "a freshly bound player is still settling");
  assert.equal(config.looksLikeTimelineDivergence(30, { ...CLEAN, navigating: true }), false,
    "positions are meaningless mid-redirect");
  assert.equal(config.looksLikeTimelineDivergence(30, { ...CLEAN, sinceAskedMs: 5000 }), false,
    "being wrong occasionally is survivable, nagging is not");
});

test("divergence: junk in, false out", () => {
  assert.equal(config.looksLikeTimelineDivergence(Infinity, CLEAN), false);
  assert.equal(config.looksLikeTimelineDivergence(NaN, CLEAN), false);
  assert.equal(config.looksLikeTimelineDivergence("30", CLEAN), false);
});

// The offset has to leave the viewer exactly where they are, reinterpreting the room's
// timeline around them rather than dragging them through their own adverts.
test("divergence: absorbing a gap leaves the viewer where they stand", () => {
  // Behind the room by 30s: our copy is 30s SHORTER, so it runs 30s behind the room's clock.
  assert.equal(config.offsetAbsorbing(0, 30), -30);
  assert.equal(config.offsetAbsorbing(0, -30), 30);
  // It composes, so a second ad break adds to the first rather than replacing it.
  assert.equal(config.offsetAbsorbing(-30, 30), -60);
  // Rounded to the half second, matching the manual control, so the two cannot disagree.
  assert.equal(config.offsetAbsorbing(0, 5.3), -5.5);
  assert.equal(config.offsetAbsorbing(12, 5.3), 6.5);
});

test("divergence: absorbing then applying leaves zero gap", () => {
  // drift = (roomPosition + offset) - myPosition. Absorb it and the next reading is zero.
  const roomPosition = 1000;
  const myPosition = 1030; // our cut is 30s longer by here
  const offsetBefore = 0;
  const drift = roomPosition + offsetBefore - myPosition;
  const offsetAfter = config.offsetAbsorbing(offsetBefore, drift);
  assert.equal(roomPosition + offsetAfter - myPosition, 0, "the viewer is left exactly where they were");
});
