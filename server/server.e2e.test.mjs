// E2E tests for Watch Together server - node:test runner (vitest-free).
// Run with: node --test server.e2e.test.mjs
//
// Covers the behaviors added in the April 2026 sync/UX hardening pass:
//   - Sender-side chat duplication is fixed (server excludes sender)
//   - Every outbound sync/heartbeat/chat carries serverTime for clock-offset
//   - room-joined / room-created carry serverTime + videoUrl
//   - "navigate" event: host gating, URL validation, no-echo, no-op on same URL
//   - isLive flag is preserved on sync + heartbeat broadcasts
//   - Existing critical paths still pass (regression net)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 4571; // distinct from vitest port to allow concurrent runs

let serverProcess;

// ---------- helpers ----------
function createClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.msgs = [];
    ws.on("message", (d) => ws.msgs.push(JSON.parse(d.toString())));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEST_LEADER_STALE_MS = 600;

// Everyone gets a heartbeat-role the moment the room settles. Those are not what a
// watchdog test is looking for, so clear them before starting the clock.
function drain(ws, type) {
  ws.msgs = ws.msgs.filter((m) => m.type !== type);
}

function waitFor(ws, type, ms = 2000) {
  const idx = ws.msgs.findIndex((m) => m.type === type);
  if (idx >= 0) return Promise.resolve(ws.msgs.splice(idx, 1)[0]);
  return new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      const i = ws.msgs.findIndex((m) => m.type === type);
      if (i >= 0) { clearInterval(iv); clearTimeout(t); resolve(ws.msgs.splice(i, 1)[0]); }
    }, 10);
    const t = setTimeout(() => { clearInterval(iv); reject(new Error(`Timeout waiting for ${type}`)); }, ms);
  });
}

// Assert the sender does NOT receive a particular message type within `ms`.
async function assertNoMessage(ws, type, ms = 250) {
  await sleep(ms);
  const found = ws.msgs.find((m) => m.type === type);
  assert.equal(found, undefined, `Expected no "${type}" message, but got: ${JSON.stringify(found)}`);
}

async function host({ name = "Host", mode = "everyone", videoUrl = "" } = {}) {
  const ws = await createClient();
  ws.send(JSON.stringify({ type: "create-room", userName: name, mode, videoUrl }));
  const msg = await waitFor(ws, "room-created");
  return { ws, code: msg.roomCode, msg };
}

async function guest(code, name = "Guest") {
  const ws = await createClient();
  ws.send(JSON.stringify({ type: "join-room", roomCode: code, userName: name }));
  const msg = await waitFor(ws, "room-joined");
  return { ws, msg };
}

function send(ws, payload) { ws.send(JSON.stringify(payload)); }
function closeAll(...clients) { clients.forEach((c) => (c.ws || c).close()); }

// ---------- lifecycle ----------
const TEST_GRACE_MS = 300;
before(async () => {
  serverProcess = fork(join(__dirname, "server.js"), [], {
    env: {
      ...process.env,
      PORT: String(PORT),
      MAX_CONNECTIONS_PER_IP: "50",
      RATE_LIMIT_MAX: "500",
      // Short grace so tests can verify both within-grace rejoin and
      // post-grace expiry without sleeping a real minute.
      EMPTY_ROOM_GRACE_MS: String(TEST_GRACE_MS),
      // Same idea for the sync-leader watchdog: prove the handoff without sitting
      // through fifteen real seconds of silence.
      LEADER_STALE_MS: String(TEST_LEADER_STALE_MS),
      LEADER_SWEEP_MS: "150",
      // A host who reloads must keep their locked room; a host who leaves must not
      // leave everyone locked out. Same rule, just not worth a real minute in a test.
      HOST_ABSENCE_GRACE_MS: "400",
    },
    silent: true,
  });
  // Wait for server to be reachable
  for (let i = 0; i < 40; i++) {
    try {
      await new Promise((res, rej) => http.get(`http://localhost:${PORT}/health`, (r) => { r.resume(); res(); }).on("error", rej));
      return;
    } catch { await sleep(50); }
  }
  throw new Error("Server failed to start");
});

after(() => { if (serverProcess) serverProcess.kill("SIGTERM"); });

// ====================================================================
// 1. CHAT DUPLICATION FIX - server must NOT echo chat back to sender
// ====================================================================

test("chat: sender does not receive own chat broadcast", async () => {
  const h = await host();
  const g = await guest(h.code);
  send(h.ws, { type: "chat", message: "hello world" });
  // Recipient sees it
  const received = await waitFor(g.ws, "chat");
  assert.equal(received.message, "hello world");
  // Sender does NOT
  await assertNoMessage(h.ws, "chat", 200);
  closeAll(h, g);
});

test("chat: includes serverTime for clock-offset on receiver", async () => {
  const h = await host();
  const g = await guest(h.code);
  send(h.ws, { type: "chat", message: "ping" });
  const m = await waitFor(g.ws, "chat");
  assert.equal(typeof m.serverTime, "number", "chat must carry serverTime");
  assert.ok(Math.abs(m.serverTime - Date.now()) < 5000, "serverTime should be near current time");
  closeAll(h, g);
});

// ====================================================================
// 2. SERVER-TIME STAMPING ON SYNC + HEARTBEAT
// ====================================================================

test("sync broadcast includes serverTime + isLive flags", async () => {
  const h = await host();
  const g = await guest(h.code);
  send(h.ws, { type: "sync", action: "play", playing: true, currentTime: 42, playbackRate: 1, isLive: true });
  const m = await waitFor(g.ws, "sync");
  assert.equal(typeof m.serverTime, "number", "sync must carry serverTime");
  assert.equal(m.isLive, true, "isLive flag must propagate");
  assert.equal(m.currentTime, 42);
  assert.equal(m.action, "play");
  closeAll(h, g);
});

test("heartbeat broadcast includes serverTime + isLive flags", async () => {
  const h = await host();
  const g = await guest(h.code);
  // Host is the heartbeat leader (created first)
  send(h.ws, { type: "heartbeat", playing: true, currentTime: 100, playbackRate: 1, isLive: false });
  const m = await waitFor(g.ws, "heartbeat");
  assert.equal(typeof m.serverTime, "number");
  assert.equal(m.isLive, false);
  closeAll(h, g);
});

test("room-joined response carries serverTime + videoUrl", async () => {
  const h = await host({ videoUrl: "https://www.youtube.com/watch?v=abc" });
  const g = await guest(h.code);
  assert.equal(typeof g.msg.serverTime, "number", "room-joined must carry serverTime");
  assert.equal(g.msg.videoUrl, "https://www.youtube.com/watch?v=abc");
  closeAll(h, g);
});

test("room-created response carries serverTime", async () => {
  const h = await host();
  assert.equal(typeof h.msg.serverTime, "number");
  closeAll(h);
});

// ====================================================================
// 3. NAVIGATE EVENT
// ====================================================================

test("navigate: broadcast reaches everyone, including the sender", async () => {
  // The sender gets its own navigate echoed back on purpose. It is how the content script
  // learns the room's settled url and cancels a redirect a racing navigate had queued, so
  // two people switching apps at once converge instead of stranding one of them.
  const h = await host({ videoUrl: "https://youtube.com/watch?v=v1" });
  const g = await guest(h.code);
  send(h.ws, { type: "navigate", url: "https://youtube.com/watch?v=v2" });
  const m = await waitFor(g.ws, "navigate");
  assert.equal(m.url, "https://youtube.com/watch?v=v2");
  assert.equal(m.fromUser, "Host");
  const own = await waitFor(h.ws, "navigate");
  assert.equal(own.url, "https://youtube.com/watch?v=v2");
  closeAll(h, g);
});

test("navigate: simultaneous conflicting switches converge on one url for everyone", async () => {
  // Both members switch app at the same instant to different videos. Whatever order the
  // server settles them in, the last url must reach both of them last, so the room ends up
  // agreeing rather than split. The old exclude-the-sender behaviour left one member on a
  // url the room had already moved off.
  const h = await host({ videoUrl: "https://youtube.com/watch?v=v1" });
  const g = await guest(h.code);
  send(h.ws, { type: "navigate", url: "https://youtube.com/watch?v=hostPick" });
  send(g.ws, { type: "navigate", url: "https://youtube.com/watch?v=guestPick" });
  // Collect every navigate each side sees; the final one both land on must match.
  const settle = async (ws) => {
    let last = null;
    for (let i = 0; i < 2; i++) {
      try { last = (await waitFor(ws, "navigate", 500)).url; } catch { break; }
    }
    return last;
  };
  const [hLast, gLast] = await Promise.all([settle(h.ws), settle(g.ws)]);
  assert.ok(hLast, "host saw at least one navigate");
  assert.equal(hLast, gLast, `both members must end on the same url (host ${hLast} vs guest ${gLast})`);
  closeAll(h, g);
});

test("navigate: same URL is a no-op (no broadcast)", async () => {
  const h = await host({ videoUrl: "https://youtube.com/watch?v=v1" });
  const g = await guest(h.code);
  // Both should have no navigate yet
  send(h.ws, { type: "navigate", url: "https://youtube.com/watch?v=v1" });
  await assertNoMessage(g.ws, "navigate", 200);
  closeAll(h, g);
});

test("navigate: invalid (non-http) URL is rejected silently", async () => {
  const h = await host();
  const g = await guest(h.code);
  send(h.ws, { type: "navigate", url: "javascript:alert(1)" });
  await assertNoMessage(g.ws, "navigate", 200);
  send(h.ws, { type: "navigate", url: "" });
  await assertNoMessage(g.ws, "navigate", 200);
  closeAll(h, g);
});

test("navigate: in host mode, non-host cannot navigate", async () => {
  const h = await host({ mode: "host", videoUrl: "https://youtube.com/watch?v=v1" });
  const g = await guest(h.code);
  send(g.ws, { type: "navigate", url: "https://youtube.com/watch?v=v2" });
  // Host should not receive a navigate from guest
  await assertNoMessage(h.ws, "navigate", 250);
  closeAll(h, g);
});

test("navigate: in everyone mode, any member can navigate", async () => {
  const h = await host({ mode: "everyone", videoUrl: "https://youtube.com/watch?v=v1" });
  const g = await guest(h.code);
  send(g.ws, { type: "navigate", url: "https://youtube.com/watch?v=v2" });
  const m = await waitFor(h.ws, "navigate");
  assert.equal(m.url, "https://youtube.com/watch?v=v2");
  assert.equal(m.fromUser, "Guest");
  closeAll(h, g);
});

test("navigate: resets room playbackState on switch", async () => {
  const h = await host({ videoUrl: "https://youtube.com/watch?v=v1" });
  // Set some playback state on the original video
  send(h.ws, { type: "sync", action: "play", playing: true, currentTime: 500, playbackRate: 1 });
  await sleep(50);
  // Switch videos
  send(h.ws, { type: "navigate", url: "https://youtube.com/watch?v=v2" });
  await sleep(50);
  // New joiner should get fresh playback state, not 500s
  const g = await guest(h.code);
  assert.equal(g.msg.playbackState.currentTime, 0, "new video should reset currentTime");
  assert.equal(g.msg.playbackState.playing, false);
  assert.equal(g.msg.videoUrl, "https://youtube.com/watch?v=v2", "videoUrl should reflect navigation");
  closeAll(h, g);
});

// ====================================================================
// 4. REGRESSION GUARD - existing behaviors I touched still work
// ====================================================================

test("regression: sync still excludes sender", async () => {
  const h = await host();
  const g = await guest(h.code);
  send(h.ws, { type: "sync", action: "play", playing: true, currentTime: 10, playbackRate: 1 });
  await waitFor(g.ws, "sync");
  await assertNoMessage(h.ws, "sync", 200);
  closeAll(h, g);
});

test("regression: heartbeat from non-leader is dropped", async () => {
  const h = await host();
  const g = await guest(h.code);
  // Guest is not the leader (host was first)
  send(g.ws, { type: "heartbeat", playing: true, currentTime: 999, playbackRate: 1 });
  await assertNoMessage(h.ws, "heartbeat", 200);
  closeAll(h, g);
});

test("regression: leave-room still notifies others + cleans up", async () => {
  const h = await host();
  const g = await guest(h.code);
  send(g.ws, { type: "leave-room" });
  const m = await waitFor(h.ws, "member-left");
  assert.equal(m.userName, "Guest");
  assert.equal(m.memberCount, 1);
  closeAll(h, g);
});

test("regression: host transfer + mode reset on host disconnect", async () => {
  const h = await host({ mode: "host" });
  const g = await guest(h.code);
  h.ws.close();
  // Guest becomes host, mode forced to everyone
  const transferred = await waitFor(g.ws, "host-transferred");
  assert.equal(transferred.isHost, true);
  const modeMsg = await waitFor(g.ws, "mode-changed");
  assert.equal(modeMsg.mode, "everyone");
  closeAll(g);
});

test("regression: rate limit still blocks runaway clients", async () => {
  const h = await host();
  // Spam more than the configured limit (500 in this test env). Send 600.
  for (let i = 0; i < 600; i++) {
    send(h.ws, { type: "sync", action: "play", playing: true, currentTime: i, playbackRate: 1 });
  }
  // We expect at least one error message back
  await sleep(150);
  const errs = h.ws.msgs.filter((m) => m.type === "error" && /rate/i.test(m.message || ""));
  assert.ok(errs.length > 0, "expected rate-limit error");
  closeAll(h);
});

// ====================================================================
// 5. EMPTY-ROOM GRACE PERIOD
// ====================================================================

test("grace: solo leaver can rejoin within grace window", async () => {
  const h = await host({ name: "Solo" });
  send(h.ws, { type: "leave-room" });
  await sleep(50); // less than TEST_GRACE_MS (300)
  // Same code should still be valid
  const g = await guest(h.code, "Solo");
  assert.equal(g.msg.roomCode, h.code);
  closeAll(h, g);
});

test("grace: room is gone after grace expires", async () => {
  const h = await host({ name: "Solo" });
  const code = h.code;
  send(h.ws, { type: "leave-room" });
  await sleep(TEST_GRACE_MS + 100); // past grace window
  // Trying to join same code now must fail
  const ws = await createClient();
  ws.send(JSON.stringify({ type: "join-room", roomCode: code, userName: "Late" }));
  const err = await waitFor(ws, "error");
  assert.match(err.message, /not found/i);
  closeAll(h, { ws });
});

test("grace: solo disconnect (no explicit leave) also has grace", async () => {
  const h = await host({ name: "Solo" });
  const code = h.code;
  h.ws.close();
  await sleep(50); // less than grace
  const g = await guest(code, "Reconnect");
  assert.equal(g.msg.roomCode, code);
  closeAll(g);
});

test("grace: stranger can join an empty room within grace (room still discoverable)", async () => {
  const h = await host({ name: "Solo", videoUrl: "https://youtube.com/watch?v=v1" });
  const code = h.code;
  send(h.ws, { type: "leave-room" });
  await sleep(50);
  const g = await guest(code, "Stranger");
  assert.equal(g.msg.roomCode, code);
  // Original videoUrl preserved across the empty period
  assert.equal(g.msg.videoUrl, "https://youtube.com/watch?v=v1");
  closeAll(h, g);
});

test("grace: rejoining cancels the deletion timer (room survives past grace)", async () => {
  const h = await host({ name: "Solo" });
  const code = h.code;
  send(h.ws, { type: "leave-room" });
  await sleep(50);
  const g = await guest(code, "Back");
  // Now wait past the original grace window - the timer should have been canceled
  await sleep(TEST_GRACE_MS + 100);
  // Should still be in room: a sync should still work without error
  send(g.ws, { type: "sync", action: "play", playing: true, currentTime: 5, playbackRate: 1 });
  await sleep(100);
  // Room must still exist - verify by joining a third client
  const g2 = await guest(code, "Third");
  assert.equal(g2.msg.roomCode, code);
  closeAll(h, g, g2);
});

test("grace: multi-user room - one leaves, no grace timer needed (room non-empty)", async () => {
  const h = await host();
  const g1 = await guest(h.code, "G1");
  send(g1.ws, { type: "leave-room" });
  await waitFor(h.ws, "member-left");
  // Room is still occupied by host - should be immediately joinable, no grace involved
  const g2 = await guest(h.code, "G2");
  assert.equal(g2.msg.roomCode, h.code);
  closeAll(h, g1, g2);
});

// ====================================================================
// 6. VOICE - server is a pure relay; verify gating + relay semantics
// ====================================================================

test("voice-state: broadcasts to room with active member ids", async () => {
  const h = await host({ name: "Speaker" });
  const g = await guest(h.code, "Listener");
  send(h.ws, { type: "voice-state", active: true });
  const m = await waitFor(g.ws, "voice-state");
  assert.equal(m.userId, h.msg.userId);
  assert.equal(m.active, true);
  assert.deepEqual(m.activeUserIds, [h.msg.userId]);
  closeAll(h, g);
});

test("voice-state: turning off updates activeUserIds", async () => {
  const h = await host({ name: "Speaker" });
  const g = await guest(h.code, "Listener");
  send(h.ws, { type: "voice-state", active: true });
  await waitFor(g.ws, "voice-state");
  send(h.ws, { type: "voice-state", active: false });
  const off = await waitFor(g.ws, "voice-state");
  assert.equal(off.active, false);
  assert.deepEqual(off.activeUserIds, []);
  closeAll(h, g);
});

test("voice-state: broadcast on disconnect when speaker was active", async () => {
  const h = await host({ name: "Speaker" });
  const g = await guest(h.code, "Listener");
  send(h.ws, { type: "voice-state", active: true });
  await waitFor(g.ws, "voice-state");
  h.ws.close();
  // Listener should receive both member-left and a voice-state(active=false)
  await waitFor(g.ws, "member-left");
  const off = await waitFor(g.ws, "voice-state");
  assert.equal(off.active, false);
  closeAll(g);
});

test("voice-signal: relay reaches only the addressed peer", async () => {
  const h = await host({ name: "A" });
  const g1 = await guest(h.code, "B");
  const g2 = await guest(h.code, "C");
  // h sends to g1 only
  send(h.ws, {
    type: "voice-signal",
    toUserId: g1.msg.userId,
    signal: { kind: "offer", sdp: { type: "offer", sdp: "v=0\r\n" } },
  });
  const got = await waitFor(g1.ws, "voice-signal");
  assert.equal(got.fromUserId, h.msg.userId);
  assert.equal(got.signal.kind, "offer");
  // g2 must NOT receive
  await assertNoMessage(g2.ws, "voice-signal", 200);
  closeAll(h, g1, g2);
});

test("voice-signal: rejects bad target (not in room)", async () => {
  const h = await host();
  const g = await guest(h.code);
  send(h.ws, {
    type: "voice-signal",
    toUserId: "does-not-exist",
    signal: { kind: "ice", candidate: { candidate: "x" } },
  });
  // Nobody should get a signal
  await assertNoMessage(g.ws, "voice-signal", 200);
  closeAll(h, g);
});

test("voice-signal: rejects oversize payload (>8KB)", async () => {
  const h = await host();
  const g = await guest(h.code);
  // 10KB of garbage in the sdp field
  const huge = { kind: "offer", sdp: { type: "offer", sdp: "x".repeat(10000) } };
  send(h.ws, { type: "voice-signal", toUserId: g.msg.userId, signal: huge });
  await assertNoMessage(g.ws, "voice-signal", 200);
  closeAll(h, g);
});

// ====================================================================
// 7. CHAT-TYPING + CC-STATE - pure relays, exclude sender
// ====================================================================

test("chat-typing: relays to other members, not to sender", async () => {
  const h = await host({ name: "A" });
  const g = await guest(h.code, "B");
  send(h.ws, { type: "chat-typing", isTyping: true });
  const m = await waitFor(g.ws, "chat-typing");
  assert.equal(m.userName, "A");
  assert.equal(m.isTyping, true);
  await assertNoMessage(h.ws, "chat-typing", 150);
  closeAll(h, g);
});

test("chat-typing: requires being in a room", async () => {
  const ws = await createClient();
  send(ws, { type: "chat-typing", isTyping: true });
  // Should silently noop - not crash, not error
  await sleep(150);
  assert.equal(ws.msgs.length, 0);
  closeAll({ ws });
});

test("cc-state: relays to other members, not to sender", async () => {
  const h = await host({ name: "A" });
  const g = await guest(h.code, "B");
  send(h.ws, { type: "cc-state", active: true });
  const m = await waitFor(g.ws, "cc-state");
  assert.equal(m.userName, "A");
  assert.equal(m.active, true);
  await assertNoMessage(h.ws, "cc-state", 150);
  closeAll(h, g);
});

// ====================================================================
// 8. CUSTOM (PERSISTENT) ROOM NAMES
// ====================================================================

test("custom-name: creates a room with the requested name (uppercase canonical)", async () => {
  const ws = await createClient();
  send(ws, { type: "create-room", userName: "A", customName: "yash-and-anshul" });
  const m = await waitFor(ws, "room-created");
  assert.equal(m.roomCode, "YASH-AND-ANSHUL");
  assert.equal(m.persistent, true);
  closeAll({ ws });
});

test("custom-name: case-insensitive join (typing in any case finds it)", async () => {
  const a = await createClient();
  send(a, { type: "create-room", userName: "A", customName: "MyRoom123" });
  await waitFor(a, "room-created");
  const b = await createClient();
  // Note: server uppercases roomCode on join, so any case works
  send(b, { type: "join-room", roomCode: "myroom123", userName: "B" });
  const joined = await waitFor(b, "room-joined");
  assert.equal(joined.roomCode, "MYROOM123");
  assert.equal(joined.persistent, true);
  closeAll({ ws: a }, { ws: b });
});

test("custom-name: rejects collision", async () => {
  const a = await createClient();
  send(a, { type: "create-room", userName: "A", customName: "duplicate-test" });
  await waitFor(a, "room-created");
  const b = await createClient();
  send(b, { type: "create-room", userName: "B", customName: "duplicate-test" });
  const err = await waitFor(b, "error");
  assert.match(err.message, /taken/i);
  closeAll({ ws: a }, { ws: b });
});

test("custom-name: rejects bad format (special chars, too short, too long)", async () => {
  const ws = await createClient();
  for (const bad of ["ab", "this-is-way-too-long-for-a-room-name-ok", "with spaces", "with/slash", "with.dot"]) {
    send(ws, { type: "create-room", userName: "A", customName: bad });
    const err = await waitFor(ws, "error");
    assert.match(err.message, /letters|numbers|hyphens/i, `expected validation error for "${bad}"`);
  }
  closeAll({ ws });
});

test("custom-name: random rooms are NOT persistent", async () => {
  const ws = await createClient();
  send(ws, { type: "create-room", userName: "A" });
  const m = await waitFor(ws, "room-created");
  assert.equal(m.persistent, false);
  closeAll({ ws });
});

// ====================================================================
// REQUEST-STATE - authoritative playback state on demand.
// Backs session resume (reloaded tab), post-ad catch-up, manual resync.
// ====================================================================

test("request-state: returns the room's current playback state to the asker", async () => {
  const h = await host();
  const g = await guest(h.code);
  // Host moves the room to a known position.
  send(h.ws, { type: "sync", action: "seek", playing: true, currentTime: 137.5, playbackRate: 1.5 });
  await waitFor(g.ws, "sync");

  send(g.ws, { type: "request-state" });
  const m = await waitFor(g.ws, "sync");
  assert.equal(m.action, "resync");
  assert.equal(m.currentTime, 137.5);
  assert.equal(m.playbackRate, 1.5);
  assert.equal(m.playing, true);
  assert.equal(typeof m.serverTime, "number", "resync must carry serverTime for clock offset");
  assert.equal(typeof m.timestamp, "number", "resync must carry timestamp so the client can extrapolate");
  closeAll(h, g);
});

test("request-state: is read-only, an asker cannot rewind the room", async () => {
  const h = await host();
  const g = await guest(h.code);
  send(h.ws, { type: "sync", action: "seek", playing: true, currentTime: 200, playbackRate: 1 });
  await waitFor(g.ws, "sync");

  // A stale client asking where the room is must not move it.
  send(g.ws, { type: "request-state" });
  await waitFor(g.ws, "sync");
  // Host sees no sync broadcast as a side effect of the guest's question.
  await assertNoMessage(h.ws, "sync", 200);

  // And the room is still where the host put it.
  send(h.ws, { type: "request-state" });
  const m = await waitFor(h.ws, "sync");
  assert.equal(m.currentTime, 200);
  closeAll(h, g);
});

// ====================================================================
// ROOM REBUILD - the server holds rooms in memory, so a restart (a free-tier
// idle spin-down is routine) wipes them. An auto-rejoin rebuilds the room from
// the client's last known position instead of stranding the party.
// ====================================================================

test("rebuild: rejoining a vanished room with recreateIfMissing restores it and its position", async () => {
  const ws = await createClient();
  send(ws, {
    type: "join-room",
    roomCode: "GHOST1",
    userName: "Returner",
    recreateIfMissing: true,
    resumeState: { playing: true, currentTime: 421.25, playbackRate: 1 },
  });
  const m = await waitFor(ws, "room-joined");
  assert.equal(m.roomCode, "GHOST1");
  assert.equal(m.isHost, true, "first one back steers the rebuilt room");
  assert.equal(m.playbackState.currentTime, 421.25, "rebuilt room resumes where the party actually was");
  assert.equal(m.playbackState.playing, true);
  closeAll({ ws });
});

test("rebuild: a plain join to an unknown room still fails cleanly", async () => {
  const ws = await createClient();
  send(ws, { type: "join-room", roomCode: "NOSUCH", userName: "Typo" });
  const m = await waitFor(ws, "error");
  assert.match(m.message, /not found/i, "a human typing a bad code must not silently create a room");
  await assertNoMessage(ws, "room-joined", 200);
  closeAll({ ws });
});

test("rebuild: a garbage resumeState cannot poison the rebuilt room", async () => {
  const ws = await createClient();
  send(ws, {
    type: "join-room",
    roomCode: "GHOST2",
    userName: "Returner",
    recreateIfMissing: true,
    resumeState: { playing: true, currentTime: -50, playbackRate: 99 },
  });
  const m = await waitFor(ws, "room-joined");
  assert.equal(m.playbackState.currentTime, 0, "negative time is clamped");
  assert.equal(m.playbackState.playbackRate, 1, "out-of-range rate falls back to 1x");
  closeAll({ ws });
});

test("rebuild: others can join the rebuilt room and land in sync", async () => {
  const a = await createClient();
  send(a, {
    type: "join-room",
    roomCode: "GHOST3",
    userName: "First",
    recreateIfMissing: true,
    resumeState: { playing: false, currentTime: 90, playbackRate: 1 },
  });
  await waitFor(a, "room-joined");

  const g = await guest("GHOST3", "Second");
  assert.equal(g.msg.playbackState.currentTime, 90, "a late joiner lands where the rebuilt room is");
  closeAll({ ws: a }, g);
});

test("rebuild: a room code that could never have been issued is refused", async () => {
  const ws = await createClient();
  send(ws, {
    type: "join-room",
    roomCode: "not a real code!!",
    userName: "Attacker",
    recreateIfMissing: true,
    resumeState: { playing: true, currentTime: 5, playbackRate: 1 },
  });
  const m = await waitFor(ws, "error");
  assert.match(m.message, /not found/i);
  closeAll({ ws });
});

test("rebuild: an infinite resume time cannot be seeded into the room", async () => {
  const ws = await createClient();
  send(ws, {
    type: "join-room",
    roomCode: "GHOST4",
    userName: "Returner",
    recreateIfMissing: true,
    resumeState: { playing: true, currentTime: "Infinity", playbackRate: 1 },
  });
  const m = await waitFor(ws, "room-joined");
  assert.equal(m.playbackState.currentTime, 0, "Infinity is not a position, it is a broken client");
  closeAll({ ws });
});

// Rebuilding a room and being its host are two different claims. Anyone who knows a code
// can ask for a rebuild - that is the whole point, it is how a party survives the free
// tier idling down - but honouring an unproven "mode: host" let a stranger wait for a room
// to go quiet, rebuild it as locked, and own everyone's playback when the real members
// came back. So a rebuild only restores host-only when the asker can produce the token
// this server issued to the room's creator.
test("rebuild: a host-only room comes back host-only when the real host asks", async () => {
  const creator = await createClient();
  send(creator, { type: "create-room", userName: "Host", mode: "host", customName: "GHOSTHOST" });
  const created = await waitFor(creator, "room-created");
  assert.equal(typeof created.hostToken, "string", "the creator is handed a token to come back with");
  closeAll({ ws: creator });

  const ws = await createClient();
  send(ws, {
    type: "join-room",
    roomCode: "GHOSTHOST",
    userName: "Returner",
    recreateIfMissing: true,
    mode: "host",
    hostToken: created.hostToken,
    resumeState: { playing: false, currentTime: 10, playbackRate: 1 },
  });
  const m = await waitFor(ws, "room-joined");
  assert.equal(m.mode, "host", "a restart must not quietly unlock a locked room");
  assert.equal(m.isHost, true, "the real host comes back as the host");
  closeAll({ ws });
});

test("rebuild: a stranger cannot claim host by rebuilding a room they know the code for", async () => {
  const ws = await createClient();
  send(ws, {
    type: "join-room",
    roomCode: "GHOST5",
    userName: "Stranger",
    recreateIfMissing: true,
    mode: "host",
    resumeState: { playing: false, currentTime: 10, playbackRate: 1 },
  });
  const m = await waitFor(ws, "room-joined");
  assert.equal(m.mode, "everyone", "no token, no lock: a rebuild must not hand control to whoever raced for it");
  closeAll({ ws });
});

test("rebuild: a forged host token is refused", async () => {
  const ws = await createClient();
  send(ws, {
    type: "join-room",
    roomCode: "GHOST6",
    userName: "Forger",
    recreateIfMissing: true,
    mode: "host",
    hostToken: "f".repeat(64),
    resumeState: { playing: false, currentTime: 10, playbackRate: 1 },
  });
  const m = await waitFor(ws, "room-joined");
  assert.equal(m.mode, "everyone", "a token we did not issue proves nothing");
  closeAll({ ws });
});

// Reloading the party tab is not leaving the party. Every reconnect gets a fresh
// server-side user id, so without a token the host came back as a guest in their own room
// and a host-only room fell open to everyone the first time they refreshed.
test("host: reloading the tab does not cost you your own room", async () => {
  const creator = await createClient();
  send(creator, { type: "create-room", userName: "Host", mode: "host" });
  const created = await waitFor(creator, "room-created");
  const guestWs = await createClient();
  send(guestWs, { type: "join-room", roomCode: created.roomCode, userName: "Guest" });
  await waitFor(guestWs, "room-joined");

  // The host's tab reloads: the old socket dies, a new one rejoins with the token.
  closeAll({ ws: creator });
  await sleep(50);
  const back = await createClient();
  send(back, {
    type: "join-room",
    roomCode: created.roomCode,
    userName: "Host",
    hostToken: created.hostToken,
  });
  const rejoined = await waitFor(back, "room-joined");
  assert.equal(rejoined.isHost, true, "the host is still the host after a reload");

  // And the guest still cannot drive a host-only room.
  send(guestWs, { type: "sync", action: "play", playing: true, currentTime: 5, playbackRate: 1 });
  const err = await waitFor(guestWs, "error");
  assert.match(err.message, /host/i, "host-only stays host-only across the reload");
  closeAll({ ws: back }, { ws: guestWs });
});

test("sync: Infinity is not a position and must never reach the room", async () => {
  const h = await host();
  const g = await guest(h.code, "Guest");
  await waitFor(h.ws, "member-joined");
  send(h.ws, { type: "sync", action: "seek", playing: true, currentTime: "Infinity", playbackRate: 1 });
  send(h.ws, { type: "sync", action: "seek", playing: true, currentTime: 42, playbackRate: 1 });
  const got = await waitFor(g.ws, "sync");
  assert.equal(got.currentTime, 42, "the Infinity must have been dropped, not relayed");
  closeAll(h, g);
});


// The sync leader is whoever the server picked to broadcast position. If that person hits
// an ad (or their tab freezes, or their laptop sleeps) they stop heartbeating, and without
// this watchdog the room silently loses drift correction for as long as they stay quiet.
test("watchdog: a silent sync leader is handed off to someone who can actually beat", async () => {
  const h = await host();
  const g = await guest(h.code, "Guest");
  await waitFor(h.ws, "member-joined");
  await sleep(50);
  drain(h.ws, "heartbeat-role");
  drain(g.ws, "heartbeat-role");

  // The watchdog only polices a room that is actually PLAYING: a paused room's leader
  // stops beating on purpose, because there is no position to correct. Start playback so
  // the silence that follows is genuinely a leader who has stopped doing their job.
  send(h.ws, { type: "sync", action: "play", playing: true, currentTime: 5, playbackRate: 1 });
  await sleep(30);

  // The host is leader on creation. Say nothing and let the watchdog notice.
  const demoted = await waitFor(h.ws, "heartbeat-role", 4000);
  assert.equal(demoted.isLeader, false, "a leader that never beats must not keep the job");

  const promoted = await waitFor(g.ws, "heartbeat-role", 4000);
  assert.equal(promoted.isLeader, true, "the job has to land on someone still in the room");

  closeAll(h, g);
});

// Host-only mode is a promise: nobody but the host moves the film. The heartbeat path used
// to have no host check at all, which did not matter while the leader was almost always the
// host. It started mattering the moment the leader role learned to step over anybody in an
// ad break: the host hits a routine advert, a guest inherits the role, and that guest's
// self-reported position starts driving the host's own video.
test("host mode: a guest cannot drive playback even after inheriting the leader role", async () => {
  let h, g;
  try {
    h = await host({ mode: "host" });
    g = await guest(h.code, "Guest");
    await waitFor(h.ws, "member-joined");
    await sleep(50);

    // The host hits an ad, which is precisely when the role would move.
    send(h.ws, { type: "ad-state", active: true });
    await sleep(150);
    drain(h.ws, "heartbeat");

    // The guest, leader or not, tries to drive the room.
    send(g.ws, { type: "heartbeat", playing: true, currentTime: 9999, playbackRate: 1 });
    await sleep(300);

    drain(h.ws, "sync");
    send(h.ws, { type: "request-state" });
    const state = await waitFor(h.ws, "sync");
    assert.notEqual(state.currentTime, 9999, "a guest must never become the room's position authority in host mode");
  } finally {
    if (h) closeAll(h);
    if (g) closeAll(g);
  }
});

test("host mode: the host keeps the leader role rather than handing it to a guest", async () => {
  let h, g;
  try {
    h = await host({ mode: "host" });
    g = await guest(h.code, "Guest");
    await waitFor(h.ws, "member-joined");
    await sleep(80);
    drain(g.ws, "heartbeat-role");

    // Even with the host in an ad break, the guest must not be told they are leading: in a
    // host-only room every heartbeat they sent would be rejected anyway, which reads as a
    // room that has quietly stopped syncing.
    send(h.ws, { type: "ad-state", active: true });
    await sleep(300);
    const roles = g.ws.msgs.filter((m) => m.type === "heartbeat-role");
    assert.ok(!roles.some((r) => r.isLeader), "a guest is never the leader of a host-only room");
  } finally {
    if (h) closeAll(h);
    if (g) closeAll(g);
  }
});

// Watching together and talking together are the same activity. Making somebody re-paste
// the call link into chat every time a friend arrives late is exactly the kind of small
// friction that makes a product feel unfinished, so the room carries it.
test("call link: the host pins one and everybody gets it, including late arrivals", async () => {
  let h, g, late;
  try {
    h = await host();
    g = await guest(h.code, "Guest");
    await waitFor(h.ws, "member-joined");

    send(h.ws, { type: "set-call-url", url: "https://meet.google.com/abc-defg-hij" });
    const seen = await waitFor(g.ws, "call-url");
    assert.equal(seen.callUrl, "https://meet.google.com/abc-defg-hij");

    // Somebody joining an hour later gets it with their room state, not by asking.
    late = await guest(h.code, "Latecomer");
    assert.equal(late.msg.callUrl, "https://meet.google.com/abc-defg-hij", "the room carries the call link");
  } finally {
    if (h) closeAll(h);
    if (g) closeAll(g);
    if (late) closeAll(late);
  }
});

test("call link: only the host may pin one", async () => {
  let h, g;
  try {
    h = await host();
    g = await guest(h.code, "Guest");
    await waitFor(h.ws, "member-joined");

    send(g.ws, { type: "set-call-url", url: "https://zoom.us/j/999" });
    await sleep(250);
    const gotOne = h.ws.msgs.some((m) => m.type === "call-url");
    assert.equal(gotOne, false, "a guest cannot put a link in front of the whole room");
  } finally {
    if (h) closeAll(h);
    if (g) closeAll(g);
  }
});

// The link becomes a button everyone in the room is invited to press, so a free-text URL
// field would be a tidy way to get a room full of people to click on anything at all.
test("call link: only real meeting platforms are accepted", async () => {
  let h;
  try {
    h = await host();

    for (const bad of [
      "https://evil.example/j/1",
      "javascript:alert(1)",
      "https://zoom.us.evil.example/j/1",
      "http://zoom.us/j/1",
    ]) {
      drain(h.ws, "error");
      drain(h.ws, "call-url");
      send(h.ws, { type: "set-call-url", url: bad });
      const err = await waitFor(h.ws, "error");
      assert.match(err.message, /link/i, `${bad} must be refused`);
    }

    for (const good of [
      "https://zoom.us/j/123456789",
      "https://us02web.zoom.us/j/1?pwd=x",
      "zoommtg://zoom.us/join?confno=1",
      "https://meet.google.com/abc-defg-hij",
      "https://teams.microsoft.com/l/meetup-join/x",
      "https://discord.gg/abcdef",
    ]) {
      drain(h.ws, "call-url");
      send(h.ws, { type: "set-call-url", url: good });
      const ok = await waitFor(h.ws, "call-url");
      assert.equal(ok.callUrl, good, `${good} should be accepted`);
    }
  } finally {
    if (h) closeAll(h);
  }
});

// presence supersedes the narrower "ad-state" message. Inbound, both are accepted: a client
// updating mid-session must never be misread as "watching" when it said it was in a break.
test("presence: the older ad-state spelling is still understood", async () => {
  let h, g;
  try {
    h = await host();
    g = await guest(h.code, "Guest");
    await waitFor(h.ws, "member-joined");

    send(g.ws, { type: "ad-state", active: true });
    const seen = await waitFor(h.ws, "presence");
    assert.equal(seen.state, "ad", "the old spelling still means the same thing");
    assert.equal(seen.watchingCount, 1);
  } finally {
    if (h) closeAll(h);
    if (g) closeAll(g);
  }
});

// Buffering is not an ad break. The film really is playing for everyone else, so the room's
// clock must keep running; what changes is that a member whose own playback has stalled
// stops being a candidate to drive everybody else's position.
test("presence: a buffering member does not stop the room, but does lose the leader role", async () => {
  let h, g;
  try {
    h = await host();
    g = await guest(h.code, "Guest");
    await waitFor(h.ws, "member-joined");
    send(h.ws, { type: "sync", action: "play", playing: true, currentTime: 20, playbackRate: 1 });
    await sleep(80);
    for (const c of [h, g]) drain(c.ws, "heartbeat-role");

    // The host is leader on creation; their connection stalls.
    send(h.ws, { type: "presence", state: "buffering" });
    const promoted = await waitFor(g.ws, "heartbeat-role", 3000);
    assert.equal(promoted.isLeader, true, "somebody who is actually playing takes over");

    await sleep(600);
    drain(g.ws, "sync");
    send(g.ws, { type: "request-state" });
    const state = await waitFor(g.ws, "sync");
    const elapsed = (state.serverTime - state.timestamp) / 1000;
    assert.ok(elapsed > 0.3, "the film is still running for everyone who can see it");
  } finally {
    if (h) closeAll(h);
    if (g) closeAll(g);
  }
});

// Rooms dying halfway through a film is the worst thing this service can do, and the two
// causes are both silences: the host spinning down after a quiet spell, and a room ageing
// out because nothing touched it. A paused party legitimately sends no playback traffic at
// all, so it has to say "we are still here" some other way.
test("keepalive: a ping keeps the room alive without touching anything else", async () => {
  let h, g;
  try {
    h = await host();
    g = await guest(h.code, "Guest");
    await waitFor(h.ws, "member-joined");
    send(h.ws, { type: "sync", action: "pause", playing: false, currentTime: 300, playbackRate: 1 });
    await waitFor(g.ws, "sync");
    await sleep(60);

    drain(g.ws, "sync");
    drain(g.ws, "presence");
    send(h.ws, { type: "ping" });
    await sleep(250);

    // Says nothing to anybody: it is not a playback event.
    assert.equal(g.ws.msgs.some((m) => m.type === "sync"), false, "a keepalive is not a sync");
    assert.equal(g.ws.msgs.some((m) => m.type === "presence"), false, "and not a presence change");

    // And the room is still perfectly usable afterwards.
    drain(g.ws, "sync");
    send(h.ws, { type: "sync", action: "play", playing: true, currentTime: 301, playbackRate: 1 });
    const still = await waitFor(g.ws, "sync");
    assert.equal(still.currentTime, 301, "the room is alive and still relaying");
  } finally {
    if (h) closeAll(h);
    if (g) closeAll(g);
  }
});

// A keepalive says "we are still here", not "I am watching the film". Treating it as the
// latter would unfreeze the room's clock during the very ad break the freeze exists for.
test("keepalive: a ping during an ad break does not end the break", async () => {
  let h, g;
  try {
    h = await host();
    g = await guest(h.code, "Guest");
    await waitFor(h.ws, "member-joined");
    send(h.ws, { type: "sync", action: "play", playing: true, currentTime: 500, playbackRate: 1 });
    await sleep(60);
    send(h.ws, { type: "presence", state: "ad" });
    send(g.ws, { type: "presence", state: "ad" });
    await sleep(150);

    // Both are mid-break; the keepalive still fires, as it does every minute.
    send(h.ws, { type: "ping" });
    send(g.ws, { type: "ping" });
    await sleep(900);

    drain(h.ws, "sync");
    send(h.ws, { type: "request-state" });
    const held = await waitFor(h.ws, "sync");
    const elapsed = (held.serverTime - held.timestamp) / 1000;
    assert.ok(elapsed < 0.5, `the break must still be holding the clock, got ${elapsed.toFixed(2)}s`);
  } finally {
    if (h) closeAll(h);
    if (g) closeAll(g);
  }
});

// ============================================================
// Four people in a room
// ============================================================
// Almost everything here was originally reasoned about, and tested, with two people. Two
// is the case where "the others" is a single other, so a rule like "hold the clock when
// everyone is in an ad" and a rule like "hold it when the one other person is" are
// indistinguishable. They are very different with four, and a watch party is usually four.

/**
 * A room of `n` people: one host and n-1 guests, all joined and settled.
 *
 * Note the finally-block discipline at every call site. An assertion that throws used to
 * leave four sockets open, and since the server caps connections per address, a single
 * genuine failure exhausted the cap and made every subsequent test time out. Thirteen
 * red tests, one real bug. Always close.
 */
async function party(n, opts = {}) {
  const h = await host(opts);
  const guests = [];
  for (let i = 1; i < n; i++) {
    guests.push(await guest(h.code, `Guest${i}`));
    await waitFor(h.ws, "member-joined");
  }
  await sleep(80);
  const all = [h, ...guests];
  for (const c of all) { drain(c.ws, "member-joined"); drain(c.ws, "heartbeat-role"); }
  return { host: h, guests, all, code: h.code };
}

test("four people: one person's play reaches all three others", async () => {
  let room;
  try {
    room = await party(4);
    send(room.guests[1].ws, { type: "sync", action: "play", playing: true, currentTime: 42, playbackRate: 1 });

    // Everyone except the sender, and nobody is left out.
    const others = [room.host, room.guests[0], room.guests[2]];
    const seen = await Promise.all(others.map((c) => waitFor(c.ws, "sync")));
    for (const m of seen) {
      assert.equal(m.currentTime, 42);
      assert.equal(m.playing, true);
      assert.equal(m.fromUser, "Guest2", "everyone can see who did it");
    }
  } finally {
    if (room) closeAll(...room.all);
  }
});

test("four people: one ad does not hold the film for the other three", async () => {
  let room;
  try {
    room = await party(4);
    send(room.host.ws, { type: "sync", action: "play", playing: true, currentTime: 300, playbackRate: 1 });
    await sleep(80);

    send(room.guests[0].ws, { type: "ad-state", active: true });
    const notice = await waitFor(room.host.ws, "presence");
    assert.equal(notice.state, "ad");
    assert.equal(notice.watchingCount, 3, "three of the four are still watching the film");
    assert.equal(notice.memberCount, 4);

    await sleep(700);
    drain(room.host.ws, "sync");
    send(room.host.ws, { type: "request-state" });
    const state = await waitFor(room.host.ws, "sync");
    const elapsed = (state.serverTime - state.timestamp) / 1000;
    assert.ok(elapsed > 0.4, "three people are watching, so the film really is advancing");
  } finally {
    if (room) closeAll(...room.all);
  }
});

test("four people: the clock holds only when the LAST of them hits an ad", async () => {
  let room;
  try {
    room = await party(4);
    send(room.host.ws, { type: "sync", action: "play", playing: true, currentTime: 500, playbackRate: 1 });
    await sleep(80);

    // Three of the four go into a break. The room must keep running for the fourth.
    send(room.host.ws, { type: "ad-state", active: true });
    send(room.guests[0].ws, { type: "ad-state", active: true });
    send(room.guests[1].ws, { type: "ad-state", active: true });
    await sleep(250);

    drain(room.guests[2].ws, "sync");
    send(room.guests[2].ws, { type: "request-state" });
    const running = await waitFor(room.guests[2].ws, "sync");
    const runningElapsed = (running.serverTime - running.timestamp) / 1000;
    assert.ok(runningElapsed > 0.1, "one person is still watching, so the film is still moving");

    // Now the fourth hits it too, and only now does the room go dark.
    send(room.guests[2].ws, { type: "ad-state", active: true });
    await sleep(150);
    await sleep(900);

    drain(room.guests[2].ws, "sync");
    send(room.guests[2].ws, { type: "request-state" });
    const held = await waitFor(room.guests[2].ws, "sync");
    const heldElapsed = (held.serverTime - held.timestamp) / 1000;
    assert.ok(heldElapsed < 0.5, `with all four in a break the clock must hold, got ${heldElapsed.toFixed(2)}s`);
  } finally {
    if (room) closeAll(...room.all);
  }
});

test("four people: the first one back out of a break starts the film again", async () => {
  let room;
  try {
    room = await party(4);
    send(room.host.ws, { type: "sync", action: "play", playing: true, currentTime: 800, playbackRate: 1 });
    await sleep(80);
    for (const c of room.all) send(c.ws, { type: "ad-state", active: true });
    await sleep(200);
    await sleep(900);

    // One person's ad finishes. The room is watching again, from where it stopped.
    send(room.guests[1].ws, { type: "ad-state", active: false });
    await sleep(150);

    drain(room.guests[1].ws, "sync");
    send(room.guests[1].ws, { type: "request-state" });
    const back = await waitFor(room.guests[1].ws, "sync");
    assert.ok(back.currentTime < 800 + 0.8, `must not skip the break, got ${back.currentTime.toFixed(2)}s`);
    await sleep(500);
    drain(room.guests[1].ws, "sync");
    send(room.guests[1].ws, { type: "request-state" });
    const later = await waitFor(room.guests[1].ws, "sync");
    const elapsed = (later.serverTime - later.timestamp) / 1000;
    assert.ok(elapsed > 0.2, "and the clock is genuinely running again, not still held");
  } finally {
    if (room) closeAll(...room.all);
  }
});

test("four people: the leader role walks past everyone in an ad", async () => {
  let room;
  try {
    room = await party(4);
    for (const c of room.all) drain(c.ws, "heartbeat-role");

    // The host leads on creation. Send them into a break: the role has to move to the
    // next person who is actually watching the film.
    send(room.host.ws, { type: "ad-state", active: true });
    const firstHop = await waitFor(room.guests[0].ws, "heartbeat-role", 3000);
    assert.equal(firstHop.isLeader, true, "the role moves off the person in a break");

    // Now that one hits a break too. It must step over them as well, not stop there.
    for (const c of room.all) drain(c.ws, "heartbeat-role");
    send(room.guests[0].ws, { type: "ad-state", active: true });
    const secondHop = await waitFor(room.guests[1].ws, "heartbeat-role", 3000);
    assert.equal(secondHop.isLeader, true, "and keeps walking until it finds a watcher");

    // The two in breaks must know they are not driving the room.
    const demoted = await waitFor(room.guests[0].ws, "heartbeat-role", 3000);
    assert.equal(demoted.isLeader, false);
  } finally {
    if (room) closeAll(...room.all);
  }
});

test("four people: everyone hears everyone, with no duplicates", async () => {
  let room;
  try {
    room = await party(4);
    const heard = [];
    room.host.ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "chat") heard.push(m.message);
    });

    send(room.guests[0].ws, { type: "chat", message: "one" });
    send(room.guests[1].ws, { type: "chat", message: "two" });
    send(room.guests[2].ws, { type: "chat", message: "three" });
    await sleep(400);

    assert.deepEqual(heard.sort(), ["one", "three", "two"], "each line arrives exactly once");
  } finally {
    if (room) closeAll(...room.all);
  }
});

test("four people: a member leaving is seen by the remaining three with the right count", async () => {
  let room;
  try {
    room = await party(4);
    closeAll(room.guests[2]);
    const left = await waitFor(room.host.ws, "member-left");
    assert.equal(left.memberCount, 3, "the count reflects who is actually still there");
  } finally {
    if (room) closeAll(room.host, room.guests[0], room.guests[1]);
  }
});

// Ads are per-viewer: your pre-roll is not your friend's. One person sitting a break out
// must not stop the room, and the room must not run on without them when EVERYBODY is
// sitting one out, which is exactly what a platform mid-roll causes because every viewer
// is at the same timestamp of the same title.
test("ad break: one viewer's ad does not stop the film for everyone else", async () => {
  let h, g;
  try {
    h = await host();
    g = await guest(h.code, "Guest");
    await waitFor(h.ws, "member-joined");

    send(h.ws, { type: "sync", action: "play", playing: true, currentTime: 100, playbackRate: 1 });
    await waitFor(g.ws, "sync");

    // The guest hits an ad. The host keeps watching.
    send(g.ws, { type: "ad-state", active: true });
    const notice = await waitFor(h.ws, "presence");
    assert.equal(notice.state, "ad", "the room is told who stepped out, and why");
    assert.equal(notice.active, true, "and the older field still reads correctly");
    assert.equal(notice.watchingCount, 1, "one person is still watching the film");

    await sleep(600);
    drain(h.ws, "sync");
    send(h.ws, { type: "request-state" });
    const state = await waitFor(h.ws, "sync");
    // The host never stopped watching, so time really did pass for the film.
    assert.ok(state.currentTime >= 100, "the room kept its position");
    assert.equal(state.playing, true);
  } finally {
    if (h) closeAll(h);
    if (g) closeAll(g);
  }
});

// This is the one that matters. Without the clock freeze the room believes the film
// advanced through the entire ad break, and everyone gets hard-seeked that far past the
// scene they were about to watch: in sync with each other, and a minute into the future.
test("ad break: the room does not run on while every member is in one", async () => {
  let h, g;
  try {
    h = await host();
    g = await guest(h.code, "Guest");
    await waitFor(h.ws, "member-joined");

    send(h.ws, { type: "sync", action: "play", playing: true, currentTime: 100, playbackRate: 1 });
    await waitFor(g.ws, "sync");
    await sleep(50);

    // A mid-roll: both viewers hit it at the same timestamp.
    send(h.ws, { type: "ad-state", active: true });
    send(g.ws, { type: "ad-state", active: true });
    await sleep(100);

    // Sit through the break.
    const AD_MS = 1500;
    await sleep(AD_MS);

    drain(h.ws, "sync");
    send(h.ws, { type: "request-state" });
    const held = await waitFor(h.ws, "sync");

    // The position a client lands on is currentTime plus however long the server says has
    // passed since it was recorded. While the room is held, that elapsed span must be ~0.
    const elapsedThatWouldBeApplied = (held.serverTime - held.timestamp) / 1000;
    assert.ok(
      elapsedThatWouldBeApplied < 0.5,
      `a held room must not hand out ${elapsedThatWouldBeApplied.toFixed(2)}s of elapsed time it did not watch`
    );
    assert.ok(
      held.currentTime < 100 + 0.7,
      `the film must still be at about 100s, not ${held.currentTime.toFixed(2)}s`
    );
  } finally {
    if (h) closeAll(h);
    if (g) closeAll(g);
  }
});

test("ad break: the clock starts again from where it stopped, not from before the break", async () => {
  let h, g;
  try {
    h = await host();
    g = await guest(h.code, "Guest");
    await waitFor(h.ws, "member-joined");

    send(h.ws, { type: "sync", action: "play", playing: true, currentTime: 200, playbackRate: 1 });
    await waitFor(g.ws, "sync");
    await sleep(50);
    send(h.ws, { type: "ad-state", active: true });
    send(g.ws, { type: "ad-state", active: true });
    await sleep(1200);

    // The host's ad finishes first.
    send(h.ws, { type: "ad-state", active: false });
    await sleep(100);

    drain(h.ws, "sync");
    send(h.ws, { type: "request-state" });
    const back = await waitFor(h.ws, "sync");
    assert.ok(
      back.currentTime < 200 + 0.7,
      `resuming must not skip the ad break's worth of film, got ${back.currentTime.toFixed(2)}s`
    );
    const elapsed = (back.serverTime - back.timestamp) / 1000;
    assert.ok(elapsed < 0.5, "and the clock restarts from now, not from before the break");
  } finally {
    if (h) closeAll(h);
    if (g) closeAll(g);
  }
});

// The leader is the only member broadcasting position, and a member in an ad deliberately
// stops broadcasting. Handing them the job means the room silently loses drift correction.
test("ad break: the sync leader is never somebody sitting one out", async () => {
  let h, g;
  try {
    h = await host();
    g = await guest(h.code, "Guest");
    await waitFor(h.ws, "member-joined");
    await sleep(50);
    drain(h.ws, "heartbeat-role");
    drain(g.ws, "heartbeat-role");

    // The host is leader on creation. Send them into an ad.
    send(h.ws, { type: "ad-state", active: true });

    const demoted = await waitFor(h.ws, "heartbeat-role", 3000);
    assert.equal(demoted.isLeader, false, "someone watching an advert cannot drive the room");
    const promoted = await waitFor(g.ws, "heartbeat-role", 3000);
    assert.equal(promoted.isLeader, true, "the job goes to whoever is still watching the film");
  } finally {
    if (h) closeAll(h);
    if (g) closeAll(g);
  }
});

test("ad break: a room entirely in ads does not churn its leader", async () => {
  let h, g;
  try {
    h = await host();
    g = await guest(h.code, "Guest");
    await waitFor(h.ws, "member-joined");
    send(h.ws, { type: "sync", action: "play", playing: true, currentTime: 10, playbackRate: 1 });
    await sleep(50);
    send(h.ws, { type: "ad-state", active: true });
    send(g.ws, { type: "ad-state", active: true });
    await sleep(100);
    drain(h.ws, "heartbeat-role");
    drain(g.ws, "heartbeat-role");

    let churned = false;
    try {
      await waitFor(h.ws, "heartbeat-role", 1500);
      churned = true;
    } catch { /* nothing arrived, which is the point */ }
    assert.equal(churned, false, "nobody can beat during a break, so handing the role around achieves nothing");
  } finally {
    if (h) closeAll(h);
    if (g) closeAll(g);
  }
});

test("ad break: a member who leaves mid-break does not strand the clock", async () => {
  let h, g;
  try {
    h = await host();
    g = await guest(h.code, "Guest");
    await waitFor(h.ws, "member-joined");
    send(h.ws, { type: "sync", action: "play", playing: true, currentTime: 50, playbackRate: 1 });
    await sleep(50);

    // The guest is in an ad; the host is the only one watching, and then leaves.
    send(g.ws, { type: "ad-state", active: true });
    await sleep(100);
    closeAll(h);
    await sleep(200);

    // The room is now entirely in ads, so it must hold rather than run on.
    await sleep(900);
    drain(g.ws, "sync");
    send(g.ws, { type: "request-state" });
    const state = await waitFor(g.ws, "sync");
    const elapsed = (state.serverTime - state.timestamp) / 1000;
    assert.ok(elapsed < 0.5, "with nobody watching, the clock holds");
  } finally {
    if (h) closeAll(h);
    if (g) closeAll(g);
  }
});

// The heartbeat is the whole running cost of this service, and a paused room has nothing
// to say. The leader going quiet there is the optimisation working, so the watchdog must
// not read it as a frozen tab and start handing the job around.
test("watchdog: a paused room does not churn its leader for being quiet", async () => {
  const h = await host();
  const g = await guest(h.code, "Guest");
  await waitFor(h.ws, "member-joined");
  await sleep(50);
  // Explicitly paused, then silence for well past the staleness window.
  send(h.ws, { type: "sync", action: "pause", playing: false, currentTime: 42, playbackRate: 1 });
  await sleep(50);
  drain(h.ws, "heartbeat-role");
  drain(g.ws, "heartbeat-role");

  let churned = false;
  try {
    await waitFor(h.ws, "heartbeat-role", 1500);
    churned = true;
  } catch { /* nothing arrived, which is the point */ }
  assert.equal(churned, false, "a paused room has no drift to correct and needs no new leader");
  closeAll(h, g);
});

test("watchdog: a leader that keeps beating keeps the job", async () => {
  const h = await host();
  const g = await guest(h.code, "Guest");
  await waitFor(h.ws, "member-joined");
  await sleep(50);
  drain(h.ws, "heartbeat-role");

  // Beat faster than the staleness window for well past one sweep.
  const beat = setInterval(() => {
    send(h.ws, { type: "heartbeat", playing: true, currentTime: 12, playbackRate: 1 });
  }, TEST_LEADER_STALE_MS / 3);
  await sleep(TEST_LEADER_STALE_MS * 3);
  clearInterval(beat);

  await assertNoMessage(h.ws, "heartbeat-role", 100);
  closeAll(h, g);
});
