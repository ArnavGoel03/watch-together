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

test("rebuild: a host-only room comes back host-only, not a free-for-all", async () => {
  const ws = await createClient();
  send(ws, {
    type: "join-room",
    roomCode: "GHOST5",
    userName: "Returner",
    recreateIfMissing: true,
    mode: "host",
    resumeState: { playing: false, currentTime: 10, playbackRate: 1 },
  });
  const m = await waitFor(ws, "room-joined");
  assert.equal(m.mode, "host", "a restart must not quietly unlock a locked room");
  closeAll({ ws });
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

  // The host is leader on creation. Say nothing and let the watchdog notice.
  const demoted = await waitFor(h.ws, "heartbeat-role", 4000);
  assert.equal(demoted.isLeader, false, "a leader that never beats must not keep the job");

  const promoted = await waitFor(g.ws, "heartbeat-role", 4000);
  assert.equal(promoted.isLeader, true, "the job has to land on someone still in the room");

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
