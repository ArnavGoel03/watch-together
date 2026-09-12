import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(new URL("../server/package.json", import.meta.url));
const { WebSocket } = require("ws");
const root = fileURLToPath(new URL(".", import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("local Worker: health, malformed invite, and two-member playback", { timeout: 25000 }, async (t) => {
  const port = await freePort();
  const directory = await mkdtemp(join(tmpdir(), "watch-worker-smoke-"));
  const clients = [];
  let output = "";
  let exited = false;
  let spawnError;
  const child = spawn(process.execPath, [
    join(root, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local",
    "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0",
    "--persist-to", directory, "--var", "HOST_TOKEN_SECRET:integration-test-only",
  ], {
    cwd: root,
    detached: process.platform !== "win32",
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.once("error", (error) => { spawnError = error; });
  child.once("exit", () => { exited = true; });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { output = (output + chunk).slice(-12000); });
  }
  // Wrangler owns a workerd descendant. Terminate only this isolated process group,
  // including on timeout, so a failed smoke never leaves a local relay running.
  const stop = (signal) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  t.after(async () => {
    for (const client of clients) client.ws.terminate();
    stop("SIGTERM");
    for (let attempt = 0; !exited && attempt < 20; attempt++) await delay(50);
    stop("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    console.log("Starting local Wrangler runtime (15-second startup budget)");
    const deadline = Date.now() + 15000;
    let health;
    while (Date.now() < deadline) {
      t.signal.throwIfAborted();
      if (spawnError) throw spawnError;
      if (exited) throw new Error("Wrangler exited before becoming ready");
      try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(700) });
        if (response.ok) { health = await response.json(); break; }
      } catch { /* Startup may not have bound its socket yet. */ }
      await delay(100, undefined, { signal: t.signal });
    }
    assert.equal(health?.status, "ok", "Worker must become healthy within 15 seconds");
    assert.equal(health.runtime, "cloudflare-workers");
    const malformed = await fetch(`${base}/join/%E0%A4%A`, { signal: AbortSignal.timeout(1500) });
    assert.equal(malformed.status, 404);
    console.log("Health and malformed invite verified");

    function connect() {
      const client = { ws: new WebSocket(base.replace("http:", "ws:"), { handshakeTimeout: 2000 }), messages: [], error: null };
      clients.push(client);
      client.ws.on("message", (data) => {
        try { client.messages.push(JSON.parse(data.toString())); } catch (error) { client.error = error; }
      });
      client.ws.on("error", (error) => { client.error = error; });
      return client;
    }
    async function waitFor(client, type) {
      const until = Date.now() + 2000;
      while (Date.now() < until) {
        if (client.error) throw client.error;
        if (type === "open" && client.ws.readyState === WebSocket.OPEN) return;
        const index = client.messages.findIndex((message) => message.type === type);
        if (index >= 0) return client.messages.splice(index, 1)[0];
        await delay(20, undefined, { signal: t.signal });
      }
      throw new Error(`Timed out waiting for ${type}`);
    }
    const host = connect();
    const guest = connect();
    await Promise.all([waitFor(host, "open"), waitFor(guest, "open")]);
    host.ws.send(JSON.stringify({ type: "create-room", userName: "Host", videoUrl: "https://example.com/video" }));
    const created = await waitFor(host, "room-created");
    assert.match(created.hostToken, /^[0-9a-f]{64}$/);
    guest.ws.send(JSON.stringify({ type: "join-room", roomCode: created.roomCode, userName: "Guest" }));
    const joined = await waitFor(guest, "room-joined");
    assert.equal(joined.roomCode, created.roomCode);
    assert.equal(joined.members.length, 2);
    host.ws.send(JSON.stringify({ type: "sync", playing: true, currentTime: 42, playbackRate: 1 }));
    const sync = await waitFor(guest, "sync");
    assert.equal(sync.playing, true);
    assert.equal(sync.currentTime, 42);
    assert.equal(sync.playbackRate, 1);
    console.log("Two WebSockets created/joined a room and relayed playback");
  } catch (error) {
    console.error(output);
    throw error;
  }
});
