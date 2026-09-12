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

function loadBackground(file) {
  const sockets = [];
  const timers = [];
  const storage = {};
  const registrations = [];
  const injections = [];
  let origins = [];
  const listener = () => ({ addListener(fn) { this.fn = fn; } });
  const chrome = {
    storage: { local: {
      get(_keys, cb) { cb({ ...storage }); },
      set(data) { Object.assign(storage, data); },
    } },
    runtime: { onConnect: listener(), onStartup: listener(), onInstalled: listener() },
    tabs: { onRemoved: listener(), query(_query, cb) { cb([]); } },
    permissions: { onAdded: listener(), onRemoved: listener(), async getAll() { return { origins }; } },
    scripting: { async getRegisteredContentScripts() { return []; } },
  };
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.onopen(); }
    message(msg) { this.onmessage({ data: JSON.stringify(msg) }); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 2; }
    finishClose() { this.readyState = 3; this.onclose({ code: 1006 }); }
  }
  const scope = {};
  const context = vm.createContext({
    self: scope, window: scope, chrome, WebSocket: Socket, URL, URLSearchParams,
    browser: {
      permissions: chrome.permissions,
      contentScripts: { async register(script) {
        registrations.push(script);
        return { async unregister() { registrations.splice(registrations.indexOf(script), 1); } };
      } },
      tabs: { async executeScript(tabId, details) { injections.push({ tabId, ...details }); } },
    },
    console: { log() {}, error() {} },
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {},
  });
  const run = (name) => vm.runInContext(readFileSync(join(extensionDir, name), "utf8"), context, { filename: name });
  context.importScripts = (...files) => files.forEach(run);
  run("config.js");
  run("relay.js");
  run(file);
  function port(name, tabId) {
    const messages = [];
    const p = { name, sender: tabId === undefined ? {} : { tab: { id: tabId } },
      onMessage: listener(), onDisconnect: listener(), postMessage(msg) { messages.push(msg); } };
    chrome.runtime.onConnect.fn(p);
    return { messages, send(msg) { p.onMessage.fn(msg); } };
  }
  const content = port("content", 1);
  const popup = port("popup");
  popup.send({ type: "connect" });
  sockets[0].open();
  popup.send({ type: "create-room", tabId: 1, videoUrl: "https://video.example/film" });
  sockets[0].message({ type: "room-created", roomCode: "ABCDEF", userId: "host", hostToken: "proof", mode: "everyone" });
  return { sockets, timers, storage, content, popup, port, registrations, injections,
    grant(sites) { origins = sites; return chrome.permissions.onAdded.fn(); } };
}

for (const file of ["background.js", "background-firefox.js"]) {
  test(`${file}: forwards only the party tab's keepalive`, () => {
    const bg = loadBackground(file);
    const socket = bg.sockets[0];
    bg.content.send({ type: "ping" });
    assert.equal(socket.sent.at(-1).type, "ping");
    const before = socket.sent.length;
    bg.port("content", 2).send({ type: "ping" });
    assert.equal(socket.sent.length, before);
  });

  test(`${file}: forwards presence and pinned call updates`, () => {
    const bg = loadBackground(file);
    for (const type of ["presence", "call-url"]) {
      bg.sockets[0].message({ type, userId: "guest", callUrl: "https://meet.google.com/abc" });
      assert.equal(bg.content.messages.at(-1).type, type);
    }
  });

  test(`${file}: a retired socket cannot change the current room`, () => {
    const bg = loadBackground(file);
    bg.popup.send({ type: "set-server-url", url: "wss://private.example" });
    bg.sockets[1].open();
    const before = bg.content.messages.length;
    bg.sockets[0].open();
    bg.sockets[0].message({ type: "room-created", roomCode: "STALE1", userId: "old" });
    assert.equal(bg.content.messages.length, before);
    assert.equal(bg.storage.currentRoom, "ABCDEF");
    bg.sockets[0].finishClose();
    bg.content.send({ type: "sync", currentTime: 10, playing: true });
    assert.equal(bg.sockets[1].sent.at(-1).type, "sync");
  });

  test(`${file}: clearing an override reconnects to the default`, () => {
    const bg = loadBackground(file);
    bg.popup.send({ type: "set-server-url", url: "wss://private.example" });
    bg.sockets[1].open();
    bg.popup.send({ type: "set-server-url", url: "" });
    assert.equal(bg.sockets.length, 3);
    assert.equal(bg.sockets[2].url, config.SERVER_URL);
    assert.equal(bg.storage.serverUrl, null);
  });

  test(`${file}: changed room authority survives background restarts`, () => {
    const bg = loadBackground(file);
    bg.sockets[0].message({ type: "mode-changed", mode: "host" });
    bg.sockets[0].message({ type: "host-transferred", isHost: false });
    bg.sockets[0].message({ type: "heartbeat-role", isLeader: true });
    assert.equal(bg.storage.cachedMode, "host");
    assert.equal(bg.storage.cachedIsHost, false);
    assert.equal(bg.storage.isHeartbeatLeader, true);
  });

  test(`${file}: a relay's non-object packet is ignored`, () => {
    const bg = loadBackground(file);
    assert.doesNotThrow(() => bg.sockets[0].message(null));
    assert.doesNotThrow(() => bg.content.send({ type: "join-room", roomCode: 12 }));
  });

  test(`${file}: leaving cancels a join queued while disconnected`, () => {
    const bg = loadBackground(file);
    bg.sockets[0].finishClose();
    bg.popup.send({ type: "join-room", roomCode: "NEW123", tabId: 1 });
    bg.popup.send({ type: "leave-room" });
    const socket = bg.sockets.at(-1);
    socket.open();
    for (const timer of bg.timers.splice(0)) timer();
    assert.equal(socket.sent.some((msg) => msg.type === "join-room"), false);
  });
}

test("Firefox: optional access registers future visits and injects the current tab", async () => {
  const bg = loadBackground("background-firefox.js");
  await bg.grant(["https://video.example/*"]);
  assert.equal(bg.registrations.length, 1);
  assert.deepEqual(Array.from(bg.registrations[0].matches), ["https://video.example/*"]);
  bg.popup.send({ type: "site-granted", tabId: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(bg.injections.map((i) => i.file), Array.from(config.INJECT_FILES));
  assert.ok(bg.injections.every((i) => i.tabId === 2));
  assert.equal(bg.popup.messages.at(-1).ok, true);
  await bg.grant([]);
  assert.equal(bg.registrations.length, 0);
});

test("join hints: only the destination consumes consent and malformed time expires", () => {
  const content = readFileSync(join(extensionDir, "content.js"), "utf8");
  const normalizer = content.slice(content.indexOf("  function normalizeUrl("), content.indexOf("  function requestResync("));
  const check = content.slice(content.indexOf("  function checkPendingJoin("), content.indexOf("  // A backgrounded tab"));
  const now = Date.now();
  for (const [destination, timestamp, consumes, joins] of [
    ["https://video.example/film", now, true, true],
    ["https://video.example/other", now, false, false],
    ["https://different.example/film", now, false, false],
    ["https://video.example/film", undefined, true, false],
    ["https://video.example/film", now + 60000, true, false],
    ["https://video.example/film", now - 121000, true, false],
  ]) {
    let removed = false;
    const sent = [];
    const context = vm.createContext({
      URL, Date, location: { href: "https://video.example/film" },
      window: { __wtConfig: config }, inRoom: false,
      chrome: { storage: { local: {
        get(_keys, cb) { cb({ pendingJoin: { roomCode: "ABCDEF", url: destination + "?wt_room=ABCDEF", timestamp, consented: true } }); },
        remove() { removed = true; },
      } } },
      sendMsg(msg) { sent.push(msg); }, showNotification() {}, setTimeout() {},
      showActionCard() { assert.fail("a consented hint needs no new prompt"); },
    });
    vm.runInContext(normalizer + check + "checkPendingJoin();", context);
    assert.equal(removed, consumes, destination);
    assert.equal(sent.some((msg) => msg.type === "join-room"), joins, destination);
  }
});

test("join consent: a page-script click cannot approve an invite", () => {
  const source = readFileSync(join(extensionDir, "content.js"), "utf8");
  const action = source.slice(source.indexOf("  function showActionCard("), source.indexOf("  function dismissActionCard("));
  const elements = [];
  let approved = false;
  const context = vm.createContext({
    document: {
      body: { appendChild() {} },
      createElement(tag) {
        const node = { tag, style: {}, appendChild() {}, addEventListener(_type, fn) { this.click = fn; } };
        elements.push(node);
        return node;
      },
    },
    dismissActionCard() {},
    approve() { approved = true; },
  });
  vm.runInContext(action + 'showActionCard("wt-join-consent", "Join", "Invite", "Join", approve);', context);
  const button = elements.find((el) => el.tag === "button");
  button.click({ isTrusted: false });
  assert.equal(approved, false);
  button.click({ isTrusted: true });
  assert.equal(approved, true);
});

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
  for (const bad of ["wss://[", "wss://example.com:99999", "wss://example.com/#", "wss://example.com/#fragment", "wss://user:secret@example.com"]) {
    assert.equal(config.isValidServerUrl(bad), false, bad);
  }
  assert.equal(config.isValidServerUrl("ws://localhost:3000"), true);
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
  relay.hydrate({ movedServerUrl: config.SERVER_URLS[0] });
  assert.equal(
    relay.candidates().length,
    before,
    "a moved URL equal to a built-in is the same backend, not an extra one"
  );
  assert.equal(new Set(relay.candidates()).size, relay.candidates().length, "no duplicates at all");
});

test("relay: what we learned last session is restored", () => {
  const relay = new RelayPicker();
  relay.hydrate({ serverUrl: "wss://chosen.example", movedServerUrl: "wss://moved.example" });
  assert.equal(relay.current(), "wss://chosen.example");
  assert.equal(relay.candidates().length, 1);
  relay.setOverride(null);
  assert.equal(relay.candidates().includes("wss://moved.example"), true);
  // Junk in storage must not poison the picker.
  const other = new RelayPicker();
  other.hydrate({ serverUrl: "ws://bad", movedServerUrl: 42 });
  assert.equal(other.current(), config.SERVER_URLS[0]);
});

test("relay: a private override never fails over or migrates to a public relay", () => {
  const relay = new RelayPicker();
  relay.setOverride("wss://private.example");
  for (let i = 0; i < 8; i++) relay.onFailure();
  assert.equal(relay.current(), "wss://private.example");
  assert.equal(relay.acceptMove("wss://other.example"), false);
  assert.equal(relay.current(), "wss://private.example");
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

// ---------- offsets belong to a video, not to a browser ----------
//
// The regression these pin: a locked-in offset used to be one number in storage, applied
// to every room and every video until somebody found the control and cleared it. Lock in
// twelve seconds on a long rip tonight, and tomorrow an unrelated film is silently twelve
// seconds out with nothing on screen to explain it.

test("offset key: the same film reached different ways is one key", () => {
  const base = config.offsetKeyFor("https://www.youtube.com/watch?v=abc123");
  assert.equal(config.offsetKeyFor("https://www.youtube.com/watch?v=abc123&t=42s"), base, "a timestamp is where you are, not what you are watching");
  assert.equal(config.offsetKeyFor("https://www.youtube.com/watch?v=abc123&wt_room=ABCDEF"), base, "our own join hint");
  assert.equal(config.offsetKeyFor("https://www.youtube.com/watch?v=abc123#t=90"), base, "a hash");
  assert.equal(config.offsetKeyFor("https://www.youtube.com/watch?v=abc123&list=PL9&index=4"), base, "playlist context");
  assert.equal(config.offsetKeyFor("https://www.youtube.com/watch?v=abc123&utm_source=x"), base, "campaign tagging");
});

test("offset key: a different film is a different key", () => {
  const a = config.offsetKeyFor("https://www.youtube.com/watch?v=abc123");
  assert.notEqual(config.offsetKeyFor("https://www.youtube.com/watch?v=zzz999"), a);
  assert.notEqual(config.offsetKeyFor("https://www.netflix.com/watch/80100172"), a);
  assert.notEqual(config.offsetKeyFor("https://www.youtube.com/watch"), a);
});

test("offset key: anything that is not an ordinary web page has no key", () => {
  assert.equal(config.offsetKeyFor("javascript:alert(1)"), "");
  assert.equal(config.offsetKeyFor("file:///film.mkv"), "");
  assert.equal(config.offsetKeyFor("not a url"), "");
  assert.equal(config.offsetKeyFor(""), "");
  assert.equal(config.offsetKeyFor(null), "");
});

test("offset store: an unknown video has no offset", () => {
  const key = config.offsetKeyFor("https://www.youtube.com/watch?v=abc123");
  const store = config.writeOffset({}, key, 12, 1000);
  assert.equal(config.readOffset(store, key), 12);
  assert.equal(config.readOffset(store, config.offsetKeyFor("https://www.youtube.com/watch?v=other")), 0,
    "the whole point: a different film starts from nothing");
  assert.equal(config.readOffset(store, ""), 0);
  assert.equal(config.readOffset(null, key), 0);
  assert.equal(config.readOffset({ [key]: "twelve" }, key), 0, "a malformed entry is no entry");
});

test("offset store: zero clears rather than recording a zero", () => {
  const key = config.offsetKeyFor("https://www.youtube.com/watch?v=abc123");
  let store = config.writeOffset({}, key, 12, 1000);
  store = config.writeOffset(store, key, 0, 2000);
  assert.equal(Object.keys(store).length, 0);
});

test("offset store: writing never mutates what it was given", () => {
  const key = config.offsetKeyFor("https://www.youtube.com/watch?v=abc123");
  const before = {};
  const after = config.writeOffset(before, key, 5, 1000);
  assert.equal(Object.keys(before).length, 0);
  assert.equal(config.readOffset(after, key), 5);
});

test("offset store: clamped to the same range as the manual control", () => {
  const key = config.offsetKeyFor("https://www.youtube.com/watch?v=abc123");
  assert.equal(config.readOffset(config.writeOffset({}, key, 9999, 1), key), 600);
  assert.equal(config.readOffset(config.writeOffset({}, key, -9999, 1), key), -600);
  assert.equal(config.readOffset(config.writeOffset({}, key, Number.NaN, 1), key), 0);
});

test("offset store: it is bounded, and the oldest entry is the one that goes", () => {
  let store = {};
  const limit = config.OFFSET_STORE_LIMIT;
  for (let i = 0; i < limit + 5; i++) {
    store = config.writeOffset(store, `site.example/v${i}`, i + 1, i + 1);
  }
  assert.equal(Object.keys(store).length, limit);
  assert.equal(config.readOffset(store, "site.example/v0"), 0, "the least recently written is gone");
  assert.equal(config.readOffset(store, `site.example/v${limit + 4}`), limit + 5, "the newest is kept");
});

test("offset store: a legacy bare number is readable and upgraded on write", () => {
  const key = "site.example/v1";
  assert.equal(config.readOffset({ [key]: 8 }, key), 8, "read what an older build wrote");
  const store = config.writeOffset({ [key]: 8 }, "site.example/v2", 3, 500);
  assert.equal(config.readOffset(store, key), 8, "and keep it");
  assert.equal(typeof store[key], "object", "in the shape the current build writes");
});
