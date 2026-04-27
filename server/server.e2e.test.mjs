// E2E tests for Watch Together server — node:test runner (vitest-free).
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
before(async () => {
  serverProcess = fork(join(__dirname, "server.js"), [], {
    env: { ...process.env, PORT: String(PORT), MAX_CONNECTIONS_PER_IP: "50", RATE_LIMIT_MAX: "500" },
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
// 1. CHAT DUPLICATION FIX — server must NOT echo chat back to sender
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

test("navigate: host can navigate, broadcast goes to others not sender", async () => {
  const h = await host({ videoUrl: "https://youtube.com/watch?v=v1" });
  const g = await guest(h.code);
  send(h.ws, { type: "navigate", url: "https://youtube.com/watch?v=v2" });
  const m = await waitFor(g.ws, "navigate");
  assert.equal(m.url, "https://youtube.com/watch?v=v2");
  assert.equal(m.fromUser, "Host");
  await assertNoMessage(h.ws, "navigate", 200);
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
// 4. REGRESSION GUARD — existing behaviors I touched still work
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
