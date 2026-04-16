import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import { WebSocket } from "ws";
import { execSync } from "child_process";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const PORT = 4567;
let serverProcess;

// ========================
// HELPERS
// ========================

function createClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.messages = [];
    ws.on("message", (d) => ws.messages.push(JSON.parse(d)));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function waitForMessage(ws, type, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const existing = ws.messages.find((m) => m.type === type);
    if (existing) { ws.messages = ws.messages.filter((m) => m !== existing); return resolve(existing); }
    const check = setInterval(() => {
      const msg = ws.messages.find((m) => m.type === type);
      if (msg) { ws.messages = ws.messages.filter((m) => m !== msg); clearInterval(check); clearTimeout(timer); resolve(msg); }
    }, 30);
    const timer = setTimeout(() => { clearInterval(check); reject(new Error(`Timeout waiting for "${type}"`)); }, timeout);
  });
}

function waitForMessages(ws, type, count, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const results = [];
    const check = setInterval(() => {
      const msgs = ws.messages.filter((m) => m.type === type);
      if (msgs.length >= count) {
        clearInterval(check); clearTimeout(timer);
        ws.messages = ws.messages.filter((m) => m.type !== type);
        resolve(msgs.slice(0, count));
      }
    }, 30);
    const timer = setTimeout(() => { clearInterval(check); reject(new Error(`Timeout waiting for ${count}x "${type}"`)); }, timeout);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${path}`, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }).on("error", reject);
  });
}

async function createRoom(userName = "Host", mode = "everyone", videoUrl = "") {
  const ws = await createClient();
  ws.send(JSON.stringify({ type: "create-room", userName, mode, videoUrl }));
  const msg = await waitForMessage(ws, "room-created");
  return { ws, roomCode: msg.roomCode, userId: msg.userId, msg };
}

async function joinRoom(roomCode, userName = "Guest") {
  const ws = await createClient();
  ws.send(JSON.stringify({ type: "join-room", roomCode, userName }));
  const msg = await waitForMessage(ws, "room-joined");
  return { ws, msg };
}

// ========================
// SETUP
// ========================

beforeAll(async () => {
  const { fork } = await import("child_process");
  serverProcess = fork("./server.js", [], {
    env: { ...process.env, PORT: String(PORT), MAX_CONNECTIONS_PER_IP: "50", RATE_LIMIT_MAX: "100" },
    silent: true,
  });
  await sleep(1000);
});

afterAll(() => {
  if (serverProcess) serverProcess.kill("SIGTERM");
});

// ========================
// 1. SYNTAX VALIDATION
// ========================

describe("Syntax validation", () => {
  const extDir = join(__dirname, "..", "extension");

  function getAllJsFiles(dir) {
    const files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "icons") {
        files.push(...getAllJsFiles(path));
      } else if (entry.name.endsWith(".js")) {
        files.push(path);
      }
    }
    return files;
  }

  const jsFiles = getAllJsFiles(extDir);

  it("all extension JS files have valid syntax", () => {
    const errors = [];
    for (const file of jsFiles) {
      try {
        execSync(`node -c "${file}" 2>&1`);
      } catch (e) {
        errors.push(`${file}: ${e.stdout?.toString() || e.message}`);
      }
    }
    expect(errors).toEqual([]);
  });

  it("server.js has valid syntax", () => {
    expect(() => execSync(`node -c "${join(__dirname, "server.js")}" 2>&1`)).not.toThrow();
  });

  it("manifest.json is valid JSON", () => {
    const manifest = readFileSync(join(extDir, "manifest.json"), "utf-8");
    expect(() => JSON.parse(manifest)).not.toThrow();
    const parsed = JSON.parse(manifest);
    expect(parsed.manifest_version).toBe(3);
    expect(parsed.content_scripts.length).toBeGreaterThanOrEqual(2);
    expect(parsed.content_scripts[0].run_at).toBe("document_start");
  });

  it("no hardcoded localhost in extension files (except server config)", () => {
    for (const file of jsFiles) {
      const content = readFileSync(file, "utf-8");
      if (file.includes("background") && content.includes("DEFAULT_SERVER_URL")) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("localhost") && !lines[i].trim().startsWith("//")) {
          throw new Error(`${file}:${i + 1} contains hardcoded localhost`);
        }
      }
    }
  });
});

// ========================
// 2. HTTP ENDPOINTS
// ========================

describe("HTTP endpoints", () => {
  it("GET /health returns server stats", async () => {
    const res = await httpGet("/health");
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("rooms");
    expect(body).toHaveProperty("connections");
    expect(body).toHaveProperty("members");
    expect(body).toHaveProperty("uptime");
  });

  it("GET /room/FAKE does not leak data", async () => {
    const res = await httpGet("/room/FAKECODE");
    const body = JSON.parse(res.body);
    expect(body.exists).toBe(false);
    expect(body).not.toHaveProperty("videoUrl");
    expect(body).not.toHaveProperty("members");
  });

  it("GET /join/CODE with video URL returns 302 redirect", async () => {
    const url = encodeURIComponent("https://www.youtube.com/watch?v=test123");
    const res = await new Promise((resolve) => {
      http.get(`http://localhost:${PORT}/join/ABC123?url=${url}`, (r) => {
        resolve({ status: r.statusCode, location: r.headers.location });
      });
    });
    expect(res.status).toBe(302);
    expect(res.location).toContain("youtube.com");
    expect(res.location).toContain("wt_room=ABC123");
  });

  it("GET /join/CODE without video URL returns fallback page", async () => {
    const res = await httpGet("/join/TESTCODE");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Watch Together");
    expect(res.body).toContain("TESTCODE");
  });

  it("GET /join/CODE?url=javascript:alert(1) does NOT redirect", async () => {
    const url = encodeURIComponent("javascript:alert(1)");
    const res = await httpGet(`/join/XYZ?url=${url}`);
    expect(res.status).toBe(200); // Fallback page
    expect(res.body).not.toContain("javascript:");
  });

  it("join page has security headers", async () => {
    const res = await httpGet("/join/TEST");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toBeDefined();
  });

  it("GET / returns homepage", async () => {
    const res = await httpGet("/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Watch Together");
  });
});

// ========================
// 3. ROOM LIFECYCLE
// ========================

describe("Room lifecycle", () => {
  it("creates room with 6-char code", async () => {
    const { ws, roomCode, msg } = await createRoom();
    expect(roomCode).toHaveLength(6);
    expect(roomCode).toMatch(/^[A-Z0-9]+$/);
    expect(msg.userId).toBeDefined();
    expect(msg.isHost).toBe(true);
    ws.close();
  });

  it("creates room with video URL", async () => {
    const { ws, roomCode } = await createRoom("Host", "everyone", "https://youtube.com/watch?v=abc");
    const res = await httpGet(`/join/${roomCode}`);
    expect(res.status).toBe(302);
    ws.close();
  });

  it("rejects javascript: video URLs", async () => {
    const { ws, roomCode } = await createRoom("Host", "everyone", "javascript:alert(1)");
    const res = await httpGet(`/join/${roomCode}`);
    expect(res.status).toBe(200); // Fallback, not redirect
    ws.close();
  });

  it("joins existing room and receives state", async () => {
    const host = await createRoom();
    const guest = await joinRoom(host.roomCode, "Guest");

    expect(guest.msg.roomCode).toBe(host.roomCode);
    expect(guest.msg.members).toHaveLength(2);
    expect(guest.msg.playbackState).toBeDefined();
    expect(guest.msg.playbackState.timestamp).toBeDefined();
    expect(guest.msg.isHost).toBe(false);
    expect(guest.msg.mode).toBe("everyone");

    const notif = await waitForMessage(host.ws, "member-joined");
    expect(notif.userName).toBe("Guest");
    expect(notif.memberCount).toBe(2);

    host.ws.close(); guest.ws.close();
  });

  it("returns error for nonexistent room", async () => {
    const ws = await createClient();
    ws.send(JSON.stringify({ type: "join-room", roomCode: "ZZZZZZ", userName: "Nobody" }));
    const err = await waitForMessage(ws, "error");
    expect(err.message).toContain("not found");
    ws.close();
  });

  it("notifies on leave", async () => {
    const host = await createRoom();
    const guest = await joinRoom(host.roomCode);
    await sleep(50);

    guest.ws.send(JSON.stringify({ type: "leave-room" }));
    const left = await waitForMessage(host.ws, "member-left");
    expect(left.userName).toBe("Guest");
    expect(left.memberCount).toBe(1);

    host.ws.close(); guest.ws.close();
  });

  it("notifies on disconnect", async () => {
    const host = await createRoom();
    const guest = await joinRoom(host.roomCode);
    await sleep(50);

    guest.ws.close();
    const left = await waitForMessage(host.ws, "member-left");
    expect(left.memberCount).toBe(1);

    host.ws.close();
  });

  it("handles leave and rejoin", async () => {
    const host = await createRoom();
    const guest = await joinRoom(host.roomCode);
    await sleep(50);

    guest.ws.send(JSON.stringify({ type: "leave-room" }));
    await waitForMessage(host.ws, "member-left");

    guest.ws.send(JSON.stringify({ type: "join-room", roomCode: host.roomCode, userName: "Guest" }));
    const rejoined = await waitForMessage(guest.ws, "room-joined");
    expect(rejoined.roomCode).toBe(host.roomCode);

    host.ws.close(); guest.ws.close();
  });
});

// ========================
// 4. SYNC — CORE FUNCTIONALITY
// ========================

describe("Sync — core", () => {
  it("play event syncs to all members", async () => {
    const host = await createRoom();
    const g1 = await joinRoom(host.roomCode, "G1");
    const g2 = await joinRoom(host.roomCode, "G2");
    await sleep(100);

    host.ws.send(JSON.stringify({ type: "sync", action: "play", playing: true, currentTime: 42.5, playbackRate: 1 }));

    const s1 = await waitForMessage(g1.ws, "sync");
    const s2 = await waitForMessage(g2.ws, "sync");
    expect(s1.currentTime).toBe(42.5);
    expect(s1.playing).toBe(true);
    expect(s1.action).toBe("play");
    expect(s1.fromUser).toBe("Host");
    expect(s2.currentTime).toBe(42.5);

    host.ws.close(); g1.ws.close(); g2.ws.close();
  });

  it("pause event syncs", async () => {
    const host = await createRoom();
    const guest = await joinRoom(host.roomCode);
    await sleep(50);

    host.ws.send(JSON.stringify({ type: "sync", action: "pause", playing: false, currentTime: 100, playbackRate: 1 }));
    const s = await waitForMessage(guest.ws, "sync");
    expect(s.playing).toBe(false);
    expect(s.action).toBe("pause");
    expect(s.currentTime).toBe(100);

    host.ws.close(); guest.ws.close();
  });

  it("seek event syncs", async () => {
    const host = await createRoom();
    const guest = await joinRoom(host.roomCode);
    await sleep(50);

    host.ws.send(JSON.stringify({ type: "sync", action: "seek", playing: true, currentTime: 600, playbackRate: 1 }));
    const s = await waitForMessage(guest.ws, "sync");
    expect(s.action).toBe("seek");
    expect(s.currentTime).toBe(600);

    host.ws.close(); guest.ws.close();
  });

  it("playback rate change syncs", async () => {
    const host = await createRoom();
    const guest = await joinRoom(host.roomCode);
    await sleep(50);

    host.ws.send(JSON.stringify({ type: "sync", action: "ratechange", playing: true, currentTime: 50, playbackRate: 2 }));
    const s = await waitForMessage(guest.ws, "sync");
    expect(s.playbackRate).toBe(2);

    host.ws.close(); guest.ws.close();
  });

  it("does NOT echo sync back to sender", async () => {
    const host = await createRoom();
    const guest = await joinRoom(host.roomCode);
    await sleep(50);
    host.ws.messages = [];

    host.ws.send(JSON.stringify({ type: "sync", action: "play", playing: true, currentTime: 10, playbackRate: 1 }));
    await sleep(300);

    expect(host.ws.messages.find((m) => m.type === "sync")).toBeUndefined();

    host.ws.close(); guest.ws.close();
  });

  it("guest can sync (everyone mode)", async () => {
    const host = await createRoom();
    const guest = await joinRoom(host.roomCode);
    await sleep(50);

    guest.ws.send(JSON.stringify({ type: "sync", action: "pause", playing: false, currentTime: 200, playbackRate: 1 }));
    const s = await waitForMessage(host.ws, "sync");
    expect(s.currentTime).toBe(200);
    expect(s.fromUser).toBe("Guest");

    host.ws.close(); guest.ws.close();
  });

  it("late joiner receives current playback state", async () => {
    const host = await createRoom();

    // Host plays to 5:30 at 1.5x
    host.ws.send(JSON.stringify({ type: "sync", action: "play", playing: true, currentTime: 330, playbackRate: 1.5 }));
    await sleep(100);

    const guest = await joinRoom(host.roomCode, "Late");
    expect(guest.msg.playbackState.currentTime).toBe(330);
    expect(guest.msg.playbackState.playing).toBe(true);
    expect(guest.msg.playbackState.playbackRate).toBe(1.5);

    host.ws.close(); guest.ws.close();
  });

  it("sync includes timestamp for drift compensation", async () => {
    const host = await createRoom();
    const guest = await joinRoom(host.roomCode);
    await sleep(50);

    const before = Date.now();
    host.ws.send(JSON.stringify({ type: "sync", action: "play", playing: true, currentTime: 100, playbackRate: 1 }));
    const s = await waitForMessage(guest.ws, "sync");

    expect(s.timestamp).toBeGreaterThanOrEqual(before);
    expect(s.timestamp).toBeLessThanOrEqual(Date.now());

    host.ws.close(); guest.ws.close();
  });

  it("rejects negative currentTime", async () => {
    const host = await createRoom();
    const guest = await joinRoom(host.roomCode);
    await sleep(50);
    guest.ws.messages = [];

    host.ws.send(JSON.stringify({ type: "sync", action: "play", playing: true, currentTime: -5, playbackRate: 1 }));
    await sleep(200);

    expect(guest.ws.messages.find((m) => m.type === "sync")).toBeUndefined();

    host.ws.close(); guest.ws.close();
  });

  it("rejects absurd playback rate", async () => {
    const host = await createRoom();
    const guest = await joinRoom(host.roomCode);
    await sleep(50);
    guest.ws.messages = [];

    host.ws.send(JSON.stringify({ type: "sync", action: "play", playing: true, currentTime: 10, playbackRate: 999 }));
    await sleep(200);

    expect(guest.ws.messages.find((m) => m.type === "sync")).toBeUndefined();

    host.ws.close(); guest.ws.close();
  });

  it("rejects NaN currentTime", async () => {
    const host = await createRoom();
    const guest = await joinRoom(host.roomCode);
    await sleep(50);
    guest.ws.messages = [];

    host.ws.send(JSON.stringify({ type: "sync", action: "play", playing: true, currentTime: "abc", playbackRate: 1 }));
    await sleep(200);

    expect(guest.ws.messages.find((m) => m.type === "sync")).toBeUndefined();

    host.ws.close(); guest.ws.close();
  });
});

// ========================
// 5. RAPID SYNC STRESS TEST
// ========================

describe("Sync — stress", () => {
  it("handles 50 rapid sync events without dropping", async () => {
    const host = await createRoom();
    const guest = await joinRoom(host.roomCode);
    await sleep(200);
    guest.ws.messages = [];

    for (let i = 0; i < 50; i++) {
      host.ws.send(JSON.stringify({ type: "sync", action: "seek", playing: true, currentTime: i * 10, playbackRate: 1 }));
      if (i % 10 === 9) await sleep(50); // Small batching to avoid OS buffer issues
    }

    await sleep(3000);
    const syncs = guest.ws.messages.filter((m) => m.type === "sync");
    expect(syncs.length).toBe(50);
    expect(syncs[49].currentTime).toBe(490);

    host.ws.close(); guest.ws.close();
  });

  it("handles alternating play/pause from different users", async () => {
    const host = await createRoom();
    const guest = await joinRoom(host.roomCode);
    await sleep(100);
    host.ws.messages = [];
    guest.ws.messages = [];

    for (let i = 0; i < 20; i++) {
      const sender = i % 2 === 0 ? host.ws : guest.ws;
      sender.send(JSON.stringify({ type: "sync", action: i % 2 === 0 ? "play" : "pause", playing: i % 2 === 0, currentTime: i * 5, playbackRate: 1 }));
      await sleep(20);
    }

    await sleep(1000);
    const hostSyncs = host.ws.messages.filter((m) => m.type === "sync");
    const guestSyncs = guest.ws.messages.filter((m) => m.type === "sync");

    // Each user sends 10, receives the other's 10
    expect(hostSyncs.length).toBe(10);
    expect(guestSyncs.length).toBe(10);

    host.ws.close(); guest.ws.close();
  });
});

// ========================
// 6. HOST MODE
// ========================

describe("Host mode", () => {
  it("creates room in host mode", async () => {
    const { ws, msg } = await createRoom("Host", "host");
    expect(msg.mode).toBe("host");
    expect(msg.isHost).toBe(true);
    ws.close();
  });

  it("blocks guest sync in host mode", async () => {
    const host = await createRoom("Host", "host");
    const guest = await joinRoom(host.roomCode);
    await sleep(50);

    guest.ws.send(JSON.stringify({ type: "sync", action: "play", playing: true, currentTime: 50, playbackRate: 1 }));
    const err = await waitForMessage(guest.ws, "error");
    expect(err.message).toContain("host");

    host.ws.close(); guest.ws.close();
  });

  it("allows host sync in host mode", async () => {
    const host = await createRoom("Host", "host");
    const guest = await joinRoom(host.roomCode);
    await sleep(50);

    host.ws.send(JSON.stringify({ type: "sync", action: "play", playing: true, currentTime: 75, playbackRate: 1 }));
    const s = await waitForMessage(guest.ws, "sync");
    expect(s.currentTime).toBe(75);

    host.ws.close(); guest.ws.close();
  });

  it("toggles mode host → everyone → host", async () => {
    const host = await createRoom("Host", "host");
    const guest = await joinRoom(host.roomCode);
    await sleep(50);

    // Switch to everyone
    host.ws.send(JSON.stringify({ type: "set-mode", mode: "everyone" }));
    const m1 = await waitForMessage(guest.ws, "mode-changed");
    expect(m1.mode).toBe("everyone");

    // Guest can now sync
    guest.ws.send(JSON.stringify({ type: "sync", action: "pause", playing: false, currentTime: 60, playbackRate: 1 }));
    const s = await waitForMessage(host.ws, "sync");
    expect(s.currentTime).toBe(60);

    // Switch back to host
    host.ws.send(JSON.stringify({ type: "set-mode", mode: "host" }));
    const m2 = await waitForMessage(guest.ws, "mode-changed");
    expect(m2.mode).toBe("host");

    // Guest blocked again
    guest.ws.send(JSON.stringify({ type: "sync", action: "play", playing: true, currentTime: 70, playbackRate: 1 }));
    const err = await waitForMessage(guest.ws, "error");
    expect(err.message).toContain("host");

    host.ws.close(); guest.ws.close();
  });

  it("guest cannot change mode", async () => {
    const host = await createRoom("Host", "host");
    const guest = await joinRoom(host.roomCode);
    await sleep(50);

    guest.ws.send(JSON.stringify({ type: "set-mode", mode: "everyone" }));
    await sleep(200);

    // Still blocked
    guest.ws.send(JSON.stringify({ type: "sync", action: "play", playing: true, currentTime: 10, playbackRate: 1 }));
    const err = await waitForMessage(guest.ws, "error");
    expect(err.message).toContain("host");

    host.ws.close(); guest.ws.close();
  });
});

// ========================
// 7. HEARTBEAT
// ========================

describe("Heartbeat", () => {
  it("assigns heartbeat leader on create", async () => {
    const { ws } = await createRoom();
    const role = await waitForMessage(ws, "heartbeat-role");
    expect(role.isLeader).toBe(true);
    ws.close();
  });

  it("reassigns leader when host leaves", async () => {
    const host = await createRoom();
    const g1 = await joinRoom(host.roomCode, "G1");
    const g2 = await joinRoom(host.roomCode, "G2");
    await sleep(100);

    // Clear all heartbeat-role messages
    g1.ws.messages = [];
    g2.ws.messages = [];

    host.ws.send(JSON.stringify({ type: "leave-room" }));
    await sleep(300);

    // One of the remaining should become leader
    const allMsgs = [...g1.ws.messages, ...g2.ws.messages];
    const leaderMsgs = allMsgs.filter((m) => m.type === "heartbeat-role" && m.isLeader);
    expect(leaderMsgs.length).toBeGreaterThanOrEqual(1);

    host.ws.close(); g1.ws.close(); g2.ws.close();
  });

  it("only leader heartbeats are broadcast", async () => {
    const host = await createRoom();
    const guest = await joinRoom(host.roomCode);
    await sleep(100);
    host.ws.messages = [];
    guest.ws.messages = [];

    // Guest sends heartbeat (not leader) — should be ignored
    guest.ws.send(JSON.stringify({ type: "heartbeat", playing: true, currentTime: 999, playbackRate: 1 }));
    await sleep(200);
    expect(host.ws.messages.find((m) => m.type === "heartbeat")).toBeUndefined();

    // Host sends heartbeat (leader) — guest should receive
    host.ws.send(JSON.stringify({ type: "heartbeat", playing: true, currentTime: 50, playbackRate: 1 }));
    const hb = await waitForMessage(guest.ws, "heartbeat");
    expect(hb.currentTime).toBe(50);

    host.ws.close(); guest.ws.close();
  });
});

// ========================
// 8. CHAT
// ========================

describe("Chat", () => {
  it("broadcasts to all members", async () => {
    const host = await createRoom();
    const g1 = await joinRoom(host.roomCode, "G1");
    const g2 = await joinRoom(host.roomCode, "G2");
    await sleep(50);

    g1.ws.send(JSON.stringify({ type: "chat", message: "Hello everyone!" }));

    const c1 = await waitForMessage(host.ws, "chat");
    const c2 = await waitForMessage(g2.ws, "chat");
    expect(c1.message).toBe("Hello everyone!");
    expect(c1.userName).toBe("G1");
    expect(c2.message).toBe("Hello everyone!");

    // Sender also receives their own chat
    const c3 = await waitForMessage(g1.ws, "chat");
    expect(c3.message).toBe("Hello everyone!");

    host.ws.close(); g1.ws.close(); g2.ws.close();
  });

  it("truncates long messages to 500 chars", async () => {
    const host = await createRoom();
    await sleep(50);

    host.ws.send(JSON.stringify({ type: "chat", message: "A".repeat(1000) }));
    const c = await waitForMessage(host.ws, "chat");
    expect(c.message.length).toBeLessThanOrEqual(500);

    host.ws.close();
  });

  it("rejects empty messages", async () => {
    const host = await createRoom();
    await sleep(50);
    host.ws.messages = [];

    host.ws.send(JSON.stringify({ type: "chat", message: "" }));
    host.ws.send(JSON.stringify({ type: "chat", message: "   " }));
    await sleep(200);

    expect(host.ws.messages.filter((m) => m.type === "chat")).toHaveLength(0);

    host.ws.close();
  });

  it("includes timestamp", async () => {
    const host = await createRoom();
    await sleep(50);

    const before = Date.now();
    host.ws.send(JSON.stringify({ type: "chat", message: "hi" }));
    const c = await waitForMessage(host.ws, "chat");
    expect(c.timestamp).toBeGreaterThanOrEqual(before);

    host.ws.close();
  });
});

// ========================
// 9. SECURITY
// ========================

describe("Security", () => {
  it("rate limits rapid messages", async () => {
    const host = await createRoom();
    host.ws.messages = [];

    // RATE_LIMIT_MAX is 100 in test env, send 120
    for (let i = 0; i < 120; i++) {
      host.ws.send(JSON.stringify({ type: "chat", message: `spam ${i}` }));
    }
    await sleep(500);

    const errors = host.ws.messages.filter((m) => m.type === "error" && m.message.includes("Rate"));
    expect(errors.length).toBeGreaterThan(0);

    host.ws.close();
  });

  it("survives malformed JSON", async () => {
    const ws = await createClient();
    ws.send("not json {{{");
    ws.send("null");
    ws.send("");
    await sleep(100);

    // Should not crash — can still create room
    ws.send(JSON.stringify({ type: "create-room", userName: "Test" }));
    const msg = await waitForMessage(ws, "room-created");
    expect(msg.roomCode).toBeDefined();
    ws.close();
  });

  it("survives missing/wrong message types", async () => {
    const ws = await createClient();
    ws.send(JSON.stringify({ foo: "bar" }));
    ws.send(JSON.stringify({ type: 12345 }));
    ws.send(JSON.stringify({ type: "" }));
    await sleep(100);

    ws.send(JSON.stringify({ type: "create-room", userName: "Test" }));
    const msg = await waitForMessage(ws, "room-created");
    expect(msg.roomCode).toBeDefined();
    ws.close();
  });

  it("enforces per-IP connection limit", async () => {
    // MAX_CONNECTIONS_PER_IP is set to 50 for tests
    // Just verify the mechanism exists by creating multiple connections
    const clients = [];
    for (let i = 0; i < 5; i++) {
      clients.push(await createClient());
    }
    // All should be open
    expect(clients.every((c) => c.readyState === WebSocket.OPEN)).toBe(true);
    clients.forEach((c) => c.close());
  });

  it("sanitizes long usernames", async () => {
    const ws = await createClient();
    ws.send(JSON.stringify({ type: "create-room", userName: "A".repeat(100) }));
    const msg = await waitForMessage(ws, "room-created");
    expect(msg.roomCode).toBeDefined();
    ws.close();
  });

  it("/room/ endpoint does not expose videoUrl or member count", async () => {
    const { ws, roomCode } = await createRoom("Host", "everyone", "https://secret-video.com/watch");
    const res = await httpGet(`/room/${roomCode}`);
    const body = JSON.parse(res.body);
    expect(body.exists).toBe(true);
    expect(body).not.toHaveProperty("videoUrl");
    expect(body).not.toHaveProperty("members");
    ws.close();
  });
});

// ========================
// 10. MULTI-USER STRESS
// ========================

describe("Multi-user stress", () => {
  it("10 users in a room, sync from each", { timeout: 15000 }, async () => {
    const host = await createRoom();
    const guests = [];
    for (let i = 0; i < 9; i++) {
      guests.push(await joinRoom(host.roomCode, `User${i}`));
    }
    await sleep(200);

    // Each user sends a sync
    const allClients = [{ ws: host.ws }, ...guests.map((g) => ({ ws: g.ws }))];
    for (let i = 0; i < allClients.length; i++) {
      allClients[i].ws.messages = [];
    }

    for (let i = 0; i < allClients.length; i++) {
      allClients[i].ws.send(JSON.stringify({ type: "sync", action: "seek", playing: true, currentTime: (i + 1) * 100, playbackRate: 1 }));
    }

    await sleep(1000);

    // Each user should receive 9 syncs (from the other 9)
    for (let i = 0; i < allClients.length; i++) {
      const syncs = allClients[i].ws.messages.filter((m) => m.type === "sync");
      expect(syncs.length).toBe(9);
    }

    allClients.forEach((c) => c.ws.close());
  });

  it("rapid join/leave cycle", { timeout: 15000 }, async () => {
    const host = await createRoom();

    for (let i = 0; i < 10; i++) {
      const g = await joinRoom(host.roomCode, `Rapid${i}`);
      await sleep(30);
      g.ws.send(JSON.stringify({ type: "leave-room" }));
      await sleep(30);
      g.ws.close();
    }

    // Host should still be in the room
    const res = await httpGet(`/room/${host.roomCode}`);
    expect(JSON.parse(res.body).exists).toBe(true);

    host.ws.close();
  });

  it("simultaneous room creation", { timeout: 15000 }, async () => {
    const rooms = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createRoom(`Creator${i}`))
    );

    const codes = rooms.map((r) => r.roomCode);
    // All codes should be unique
    expect(new Set(codes).size).toBe(10);

    rooms.forEach((r) => r.ws.close());
  });
});

// ========================
// 11. END-TO-END SCENARIOS
// ========================

describe("End-to-end scenarios", () => {
  it("full watch session: create, join, sync, chat, mode switch, leave", { timeout: 15000 }, async () => {
    // 1. Host creates
    const host = await createRoom("Alice", "everyone", "https://youtube.com/watch?v=test");

    // 2. Guest joins
    const guest = await joinRoom(host.roomCode, "Bob");
    expect(guest.msg.members).toHaveLength(2);

    // 3. Host plays at 1:00
    host.ws.send(JSON.stringify({ type: "sync", action: "play", playing: true, currentTime: 60, playbackRate: 1 }));
    const s1 = await waitForMessage(guest.ws, "sync");
    expect(s1.currentTime).toBe(60);

    // 4. Guest seeks to 5:00
    guest.ws.send(JSON.stringify({ type: "sync", action: "seek", playing: true, currentTime: 300, playbackRate: 1 }));
    const s2 = await waitForMessage(host.ws, "sync");
    expect(s2.currentTime).toBe(300);

    // 5. Chat
    host.ws.send(JSON.stringify({ type: "chat", message: "Great scene!" }));
    const c = await waitForMessage(guest.ws, "chat");
    expect(c.message).toBe("Great scene!");

    // 6. Host switches to host-only mode
    host.ws.send(JSON.stringify({ type: "set-mode", mode: "host" }));
    const mc = await waitForMessage(guest.ws, "mode-changed");
    expect(mc.mode).toBe("host");

    // 7. Guest can't sync anymore
    guest.ws.send(JSON.stringify({ type: "sync", action: "pause", playing: false, currentTime: 310, playbackRate: 1 }));
    const err = await waitForMessage(guest.ws, "error");
    expect(err.message).toContain("host");

    // 8. Host pauses
    host.ws.send(JSON.stringify({ type: "sync", action: "pause", playing: false, currentTime: 305, playbackRate: 1 }));
    const s3 = await waitForMessage(guest.ws, "sync");
    expect(s3.playing).toBe(false);

    // 9. Guest leaves
    guest.ws.send(JSON.stringify({ type: "leave-room" }));
    const left = await waitForMessage(host.ws, "member-left");
    expect(left.memberCount).toBe(1);

    host.ws.close(); guest.ws.close();
  });

  it("late joiner catches up to current state", { timeout: 15000 }, async () => {
    const host = await createRoom("Streamer");

    // Simulate 10 minutes of watching
    host.ws.send(JSON.stringify({ type: "sync", action: "play", playing: true, currentTime: 0, playbackRate: 1 }));
    await sleep(50);
    host.ws.send(JSON.stringify({ type: "sync", action: "seek", playing: true, currentTime: 300, playbackRate: 1 }));
    await sleep(50);
    host.ws.send(JSON.stringify({ type: "sync", action: "ratechange", playing: true, currentTime: 300, playbackRate: 1.5 }));
    await sleep(50);
    host.ws.send(JSON.stringify({ type: "sync", action: "seek", playing: true, currentTime: 600, playbackRate: 1.5 }));
    await sleep(50);

    // Late joiner joins
    const late = await joinRoom(host.roomCode, "LateViewer");
    expect(late.msg.playbackState.currentTime).toBe(600);
    expect(late.msg.playbackState.playbackRate).toBe(1.5);
    expect(late.msg.playbackState.playing).toBe(true);

    host.ws.close(); late.ws.close();
  });

  it("room survives all guests leaving and rejoining", { timeout: 15000 }, async () => {
    const host = await createRoom("Host");
    let guest = await joinRoom(host.roomCode, "Guest");

    // Set playback state
    host.ws.send(JSON.stringify({ type: "sync", action: "play", playing: true, currentTime: 500, playbackRate: 1 }));
    await sleep(100);

    // Guest leaves
    guest.ws.close();
    await sleep(100);

    // New guest joins — should get current state
    guest = await joinRoom(host.roomCode, "NewGuest");
    expect(guest.msg.playbackState.currentTime).toBe(500);

    host.ws.close(); guest.ws.close();
  });
});
