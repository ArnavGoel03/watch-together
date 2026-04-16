import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import { WebSocket } from "ws";
import { execSync } from "child_process";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const PORT = 4567;
let serverProcess;

// ========================
// HELPERS — optimized for speed
// ========================

function createClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.msgs = [];
    ws.on("message", (d) => ws.msgs.push(JSON.parse(d)));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function wait(ws, type, ms = 2000) {
  const found = ws.msgs.find((m) => m.type === type);
  if (found) { ws.msgs.splice(ws.msgs.indexOf(found), 1); return Promise.resolve(found); }
  return new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      const m = ws.msgs.find((x) => x.type === type);
      if (m) { ws.msgs.splice(ws.msgs.indexOf(m), 1); clearInterval(iv); clearTimeout(t); resolve(m); }
    }, 10);
    const t = setTimeout(() => { clearInterval(iv); reject(new Error(`Timeout: ${type}`)); }, ms);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${path}`, (res) => {
      let d = ""; res.on("data", (c) => d += c);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    }).on("error", reject);
  });
}

async function host(name = "Host", mode = "everyone", videoUrl = "") {
  const ws = await createClient();
  ws.send(JSON.stringify({ type: "create-room", userName: name, mode, videoUrl }));
  const msg = await wait(ws, "room-created");
  return { ws, code: msg.roomCode, msg };
}

async function guest(code, name = "Guest") {
  const ws = await createClient();
  ws.send(JSON.stringify({ type: "join-room", roomCode: code, userName: name }));
  const msg = await wait(ws, "room-joined");
  return { ws, msg };
}

function sync(ws, action, time, playing = true, rate = 1) {
  ws.send(JSON.stringify({ type: "sync", action, playing, currentTime: time, playbackRate: rate }));
}

function close(...clients) { clients.forEach((c) => (c.ws || c).close()); }

// ========================
// SETUP
// ========================

beforeAll(async () => {
  const { fork } = await import("child_process");
  serverProcess = fork("./server.js", [], {
    env: { ...process.env, PORT: String(PORT), MAX_CONNECTIONS_PER_IP: "50", RATE_LIMIT_MAX: "200" },
    silent: true,
  });
  await sleep(800);
});

afterAll(() => { if (serverProcess) serverProcess.kill("SIGTERM"); });

// ========================
// 1. SYNTAX & STATIC CHECKS
// ========================

describe("Static checks", () => {
  const extDir = join(__dirname, "..", "extension");
  const getJsFiles = (dir) => {
    const files = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() && e.name !== "node_modules" && e.name !== "icons") files.push(...getJsFiles(p));
      else if (e.name.endsWith(".js")) files.push(p);
    }
    return files;
  };

  it("all JS files have valid syntax", () => {
    const errors = [];
    for (const f of [...getJsFiles(extDir), join(__dirname, "server.js")]) {
      try { execSync(`node -c "${f}" 2>&1`); } catch (e) { errors.push(f); }
    }
    expect(errors).toEqual([]);
  });

  it("manifest.json is valid MV3", () => {
    const m = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf-8"));
    expect(m.manifest_version).toBe(3);
    expect(m.content_scripts.length).toBeGreaterThanOrEqual(2);
    expect(m.content_scripts[0].run_at).toBe("document_start");
  });

  it("no hardcoded localhost in extension (except config)", () => {
    for (const f of getJsFiles(extDir)) {
      const c = readFileSync(f, "utf-8");
      if (f.includes("background") && c.includes("DEFAULT_SERVER_URL")) continue;
      const lines = c.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("localhost") && !lines[i].trim().startsWith("//")) {
          throw new Error(`${f}:${i + 1} has localhost`);
        }
      }
    }
  });
});

// ========================
// 2. HTTP
// ========================

describe("HTTP", () => {
  it("health endpoint", async () => {
    const r = await httpGet("/health");
    const b = JSON.parse(r.body);
    expect(b.status).toBe("ok");
    expect(b).toHaveProperty("uptime");
  });

  it("/room/ does not leak data", async () => {
    const b = JSON.parse((await httpGet("/room/FAKE")).body);
    expect(b.exists).toBe(false);
    expect(b).not.toHaveProperty("videoUrl");
  });

  it("join with video URL → 302 redirect", async () => {
    const url = encodeURIComponent("https://youtube.com/watch?v=x");
    const r = await new Promise((res) =>
      http.get(`http://localhost:${PORT}/join/A?url=${url}`, (h) => res({ status: h.statusCode, loc: h.headers.location }))
    );
    expect(r.status).toBe(302);
    expect(r.loc).toContain("wt_room=A");
  });

  it("join without video → fallback page with security headers", async () => {
    const r = await httpGet("/join/X");
    expect(r.status).toBe(200);
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.body).toContain("Watch Together");
  });

  it("blocks javascript: URLs", async () => {
    const r = await httpGet(`/join/X?url=${encodeURIComponent("javascript:alert(1)")}`);
    expect(r.status).toBe(200);
  });
});

// ========================
// 3. ROOMS
// ========================

describe("Rooms", () => {
  it("creates with 6-char alphanumeric code", async () => {
    const h = await host();
    expect(h.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(h.msg.isHost).toBe(true);
    close(h);
  });

  it("join gets members + playback state", async () => {
    const h = await host();
    const g = await guest(h.code);
    expect(g.msg.members).toHaveLength(2);
    expect(g.msg.playbackState).toBeDefined();
    expect(g.msg.isHost).toBe(false);
    close(h, g);
  });

  it("nonexistent room → error", async () => {
    const ws = await createClient();
    ws.send(JSON.stringify({ type: "join-room", roomCode: "ZZZZZZ", userName: "X" }));
    const e = await wait(ws, "error");
    expect(e.message).toContain("not found");
    ws.close();
  });

  it("leave notifies host", async () => {
    const h = await host();
    const g = await guest(h.code);
    g.ws.send(JSON.stringify({ type: "leave-room" }));
    const m = await wait(h.ws, "member-left");
    expect(m.memberCount).toBe(1);
    close(h, g);
  });

  it("disconnect notifies host", async () => {
    const h = await host();
    const g = await guest(h.code);
    g.ws.close();
    const m = await wait(h.ws, "member-left");
    expect(m.memberCount).toBe(1);
    close(h);
  });

  it("rejoin works", async () => {
    const h = await host();
    const g = await guest(h.code);
    g.ws.send(JSON.stringify({ type: "leave-room" }));
    await wait(h.ws, "member-left");
    g.ws.send(JSON.stringify({ type: "join-room", roomCode: h.code, userName: "G" }));
    const r = await wait(g.ws, "room-joined");
    expect(r.roomCode).toBe(h.code);
    close(h, g);
  });

  it("video URL stored → redirect works", async () => {
    const h = await host("H", "everyone", "https://youtube.com/watch?v=abc");
    const r = await new Promise((res) =>
      http.get(`http://localhost:${PORT}/join/${h.code}`, (x) => res(x.statusCode))
    );
    expect(r).toBe(302);
    close(h);
  });
});

// ========================
// 4. SYNC
// ========================

describe("Sync", () => {
  it("play syncs", async () => {
    const h = await host(); const g = await guest(h.code); await sleep(30);
    sync(h.ws, "play", 42.5);
    const s = await wait(g.ws, "sync");
    expect(s.currentTime).toBe(42.5);
    expect(s.playing).toBe(true);
    expect(s.fromUser).toBe("Host");
    close(h, g);
  });

  it("pause syncs", async () => {
    const h = await host(); const g = await guest(h.code); await sleep(30);
    sync(h.ws, "pause", 100, false);
    const s = await wait(g.ws, "sync");
    expect(s.playing).toBe(false);
    close(h, g);
  });

  it("seek syncs", async () => {
    const h = await host(); const g = await guest(h.code); await sleep(30);
    sync(h.ws, "seek", 600);
    const s = await wait(g.ws, "sync");
    expect(s.currentTime).toBe(600);
    close(h, g);
  });

  it("rate change syncs", async () => {
    const h = await host(); const g = await guest(h.code); await sleep(30);
    sync(h.ws, "ratechange", 50, true, 2);
    const s = await wait(g.ws, "sync");
    expect(s.playbackRate).toBe(2);
    close(h, g);
  });

  it("no echo to sender", async () => {
    const h = await host(); const g = await guest(h.code); await sleep(30);
    h.ws.msgs = [];
    sync(h.ws, "play", 10);
    await sleep(100);
    expect(h.ws.msgs.find((m) => m.type === "sync")).toBeUndefined();
    close(h, g);
  });

  it("guest can sync (everyone mode)", async () => {
    const h = await host(); const g = await guest(h.code); await sleep(30);
    sync(g.ws, "pause", 200, false);
    const s = await wait(h.ws, "sync");
    expect(s.currentTime).toBe(200);
    close(h, g);
  });

  it("late joiner gets current state", async () => {
    const h = await host();
    sync(h.ws, "play", 330, true, 1.5);
    await sleep(50);
    const g = await guest(h.code);
    expect(g.msg.playbackState.currentTime).toBe(330);
    expect(g.msg.playbackState.playbackRate).toBe(1.5);
    close(h, g);
  });

  it("includes timestamp", async () => {
    const h = await host(); const g = await guest(h.code); await sleep(30);
    const before = Date.now();
    sync(h.ws, "play", 100);
    const s = await wait(g.ws, "sync");
    expect(s.timestamp).toBeGreaterThanOrEqual(before);
    close(h, g);
  });

  it("rejects negative time", async () => {
    const h = await host(); const g = await guest(h.code); await sleep(30);
    g.ws.msgs = [];
    sync(h.ws, "play", -5);
    await sleep(80);
    expect(g.ws.msgs.find((m) => m.type === "sync")).toBeUndefined();
    close(h, g);
  });

  it("rejects absurd rate", async () => {
    const h = await host(); const g = await guest(h.code); await sleep(30);
    g.ws.msgs = [];
    sync(h.ws, "play", 10, true, 999);
    await sleep(80);
    expect(g.ws.msgs.find((m) => m.type === "sync")).toBeUndefined();
    close(h, g);
  });

  it("rejects NaN time", async () => {
    const h = await host(); const g = await guest(h.code); await sleep(30);
    g.ws.msgs = [];
    h.ws.send(JSON.stringify({ type: "sync", action: "play", playing: true, currentTime: "abc", playbackRate: 1 }));
    await sleep(80);
    expect(g.ws.msgs.find((m) => m.type === "sync")).toBeUndefined();
    close(h, g);
  });
});

// ========================
// 5. STRESS
// ========================

describe("Stress", () => {
  it("50 rapid syncs delivered", { timeout: 10000 }, async () => {
    const h = await host(); const g = await guest(h.code); await sleep(50);
    g.ws.msgs = [];
    for (let i = 0; i < 50; i++) {
      sync(h.ws, "seek", i * 10);
      if (i % 10 === 9) await sleep(20);
    }
    await sleep(2000);
    const syncs = g.ws.msgs.filter((m) => m.type === "sync");
    expect(syncs.length).toBe(50);
    close(h, g);
  });

  it("alternating play/pause from 2 users", async () => {
    const h = await host(); const g = await guest(h.code); await sleep(50);
    h.ws.msgs = []; g.ws.msgs = [];
    for (let i = 0; i < 20; i++) {
      const s = i % 2 === 0 ? h.ws : g.ws;
      sync(s, i % 2 === 0 ? "play" : "pause", i * 5, i % 2 === 0);
      await sleep(10);
    }
    await sleep(500);
    expect(h.ws.msgs.filter((m) => m.type === "sync").length).toBe(10);
    expect(g.ws.msgs.filter((m) => m.type === "sync").length).toBe(10);
    close(h, g);
  });

  it("10 users sync simultaneously", { timeout: 10000 }, async () => {
    const h = await host();
    const gs = [];
    for (let i = 0; i < 9; i++) gs.push(await guest(h.code, `U${i}`));
    await sleep(100);

    const all = [h, ...gs];
    all.forEach((c) => c.ws.msgs = []);
    all.forEach((c, i) => sync(c.ws, "seek", (i + 1) * 100));
    await sleep(1000);

    for (const c of all) {
      expect(c.ws.msgs.filter((m) => m.type === "sync").length).toBe(9);
    }
    close(...all);
  });

  it("rapid join/leave cycle", { timeout: 10000 }, async () => {
    const h = await host();
    for (let i = 0; i < 10; i++) {
      const g = await guest(h.code, `R${i}`);
      g.ws.send(JSON.stringify({ type: "leave-room" }));
      g.ws.close();
      await sleep(20);
    }
    expect(JSON.parse((await httpGet(`/room/${h.code}`)).body).exists).toBe(true);
    close(h);
  });

  it("10 simultaneous room creations", { timeout: 10000 }, async () => {
    const rooms = await Promise.all(Array.from({ length: 10 }, (_, i) => host(`C${i}`)));
    expect(new Set(rooms.map((r) => r.code)).size).toBe(10);
    close(...rooms);
  });
});

// ========================
// 6. HOST MODE
// ========================

describe("Host mode", () => {
  it("creates in host mode", async () => {
    const h = await host("H", "host");
    expect(h.msg.mode).toBe("host");
    close(h);
  });

  it("blocks guest sync", async () => {
    const h = await host("H", "host"); const g = await guest(h.code); await sleep(30);
    sync(g.ws, "play", 50);
    const e = await wait(g.ws, "error");
    expect(e.message).toContain("host");
    close(h, g);
  });

  it("allows host sync", async () => {
    const h = await host("H", "host"); const g = await guest(h.code); await sleep(30);
    sync(h.ws, "play", 75);
    const s = await wait(g.ws, "sync");
    expect(s.currentTime).toBe(75);
    close(h, g);
  });

  it("toggle host → everyone → host", async () => {
    const h = await host("H", "host"); const g = await guest(h.code); await sleep(30);

    h.ws.send(JSON.stringify({ type: "set-mode", mode: "everyone" }));
    expect((await wait(g.ws, "mode-changed")).mode).toBe("everyone");

    sync(g.ws, "pause", 60, false);
    expect((await wait(h.ws, "sync")).currentTime).toBe(60);

    h.ws.send(JSON.stringify({ type: "set-mode", mode: "host" }));
    expect((await wait(g.ws, "mode-changed")).mode).toBe("host");

    sync(g.ws, "play", 70);
    expect((await wait(g.ws, "error")).message).toContain("host");
    close(h, g);
  });

  it("guest cannot change mode", async () => {
    const h = await host("H", "host"); const g = await guest(h.code); await sleep(30);
    g.ws.send(JSON.stringify({ type: "set-mode", mode: "everyone" }));
    await sleep(100);
    sync(g.ws, "play", 10);
    expect((await wait(g.ws, "error")).message).toContain("host");
    close(h, g);
  });
});

// ========================
// 7. HEARTBEAT
// ========================

describe("Heartbeat", () => {
  it("assigns leader on create", async () => {
    const h = await host();
    const r = await wait(h.ws, "heartbeat-role");
    expect(r.isLeader).toBe(true);
    close(h);
  });

  it("only leader heartbeats broadcast", async () => {
    const h = await host(); const g = await guest(h.code); await sleep(50);
    h.ws.msgs = []; g.ws.msgs = [];

    g.ws.send(JSON.stringify({ type: "heartbeat", playing: true, currentTime: 999, playbackRate: 1 }));
    await sleep(100);
    expect(h.ws.msgs.find((m) => m.type === "heartbeat")).toBeUndefined();

    h.ws.send(JSON.stringify({ type: "heartbeat", playing: true, currentTime: 50, playbackRate: 1 }));
    expect((await wait(g.ws, "heartbeat")).currentTime).toBe(50);
    close(h, g);
  });

  it("reassigns leader on host leave", async () => {
    const h = await host();
    const g1 = await guest(h.code, "G1");
    const g2 = await guest(h.code, "G2");
    await sleep(50);
    g1.ws.msgs = []; g2.ws.msgs = [];

    h.ws.send(JSON.stringify({ type: "leave-room" }));
    await sleep(200);

    const leaders = [...g1.ws.msgs, ...g2.ws.msgs].filter((m) => m.type === "heartbeat-role" && m.isLeader);
    expect(leaders.length).toBeGreaterThanOrEqual(1);
    close(h, g1, g2);
  });
});

// ========================
// 8. CHAT
// ========================

describe("Chat", () => {
  it("broadcasts to all", async () => {
    const h = await host(); const g = await guest(h.code); await sleep(30);
    g.ws.send(JSON.stringify({ type: "chat", message: "Hi!" }));
    const c = await wait(h.ws, "chat");
    expect(c.message).toBe("Hi!");
    expect(c.userName).toBe("Guest");
    close(h, g);
  });

  it("truncates to 500 chars", async () => {
    const h = await host();
    h.ws.send(JSON.stringify({ type: "chat", message: "A".repeat(1000) }));
    const c = await wait(h.ws, "chat");
    expect(c.message.length).toBeLessThanOrEqual(500);
    close(h);
  });

  it("rejects empty", async () => {
    const h = await host(); h.ws.msgs = [];
    h.ws.send(JSON.stringify({ type: "chat", message: "" }));
    h.ws.send(JSON.stringify({ type: "chat", message: "   " }));
    await sleep(100);
    expect(h.ws.msgs.filter((m) => m.type === "chat")).toHaveLength(0);
    close(h);
  });
});

// ========================
// 9. SECURITY
// ========================

describe("Security", () => {
  it("rate limits", async () => {
    const h = await host(); h.ws.msgs = [];
    for (let i = 0; i < 250; i++) h.ws.send(JSON.stringify({ type: "chat", message: `${i}` }));
    await sleep(300);
    expect(h.ws.msgs.filter((m) => m.type === "error").length).toBeGreaterThan(0);
    close(h);
  });

  it("survives bad input", async () => {
    const ws = await createClient();
    ws.send("not json"); ws.send("null"); ws.send("");
    ws.send(JSON.stringify({ foo: "bar" }));
    ws.send(JSON.stringify({ type: 999 }));
    await sleep(50);
    ws.send(JSON.stringify({ type: "create-room", userName: "OK" }));
    const m = await wait(ws, "room-created");
    expect(m.roomCode).toBeDefined();
    ws.close();
  });

  it("/room/ hides videoUrl", async () => {
    const h = await host("H", "everyone", "https://secret.com/vid");
    const b = JSON.parse((await httpGet(`/room/${h.code}`)).body);
    expect(b).not.toHaveProperty("videoUrl");
    close(h);
  });
});

// ========================
// 10. END-TO-END
// ========================

describe("End-to-end", () => {
  it("full session: create → join → sync → chat → mode → leave", { timeout: 10000 }, async () => {
    const h = await host("Alice", "everyone", "https://youtube.com/watch?v=test");
    const g = await guest(h.code, "Bob");

    // Sync play
    sync(h.ws, "play", 60);
    expect((await wait(g.ws, "sync")).currentTime).toBe(60);

    // Sync seek from guest
    sync(g.ws, "seek", 300);
    expect((await wait(h.ws, "sync")).currentTime).toBe(300);

    // Chat
    h.ws.send(JSON.stringify({ type: "chat", message: "Great!" }));
    expect((await wait(g.ws, "chat")).message).toBe("Great!");

    // Switch to host mode
    h.ws.send(JSON.stringify({ type: "set-mode", mode: "host" }));
    expect((await wait(g.ws, "mode-changed")).mode).toBe("host");

    // Guest blocked
    sync(g.ws, "pause", 310, false);
    expect((await wait(g.ws, "error")).message).toContain("host");

    // Host pause works
    sync(h.ws, "pause", 305, false);
    expect((await wait(g.ws, "sync")).playing).toBe(false);

    // Leave
    g.ws.send(JSON.stringify({ type: "leave-room" }));
    expect((await wait(h.ws, "member-left")).memberCount).toBe(1);
    close(h, g);
  });

  it("late joiner catches up", { timeout: 10000 }, async () => {
    const h = await host("Streamer");
    sync(h.ws, "play", 0); await sleep(20);
    sync(h.ws, "seek", 300); await sleep(20);
    sync(h.ws, "ratechange", 300, true, 1.5); await sleep(20);
    sync(h.ws, "seek", 600, true, 1.5);
    await sleep(50);

    const g = await guest(h.code, "Late");
    expect(g.msg.playbackState.currentTime).toBe(600);
    expect(g.msg.playbackState.playbackRate).toBe(1.5);
    close(h, g);
  });

  it("room survives guest churn", { timeout: 10000 }, async () => {
    const h = await host();
    sync(h.ws, "play", 500); await sleep(50);

    let g = await guest(h.code);
    g.ws.close(); await sleep(50);

    g = await guest(h.code, "New");
    expect(g.msg.playbackState.currentTime).toBe(500);
    close(h, g);
  });
});
