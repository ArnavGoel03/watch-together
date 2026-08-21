// Tests for the Cloudflare port itself.
//
// This file exists because `npm test` in this package used to run the NODE server's test
// suite. It passed, every time, while executing zero lines of worker.js, so the Durable
// Object watchdog, the hibernation rehydration and the navigate changes were all reported
// as covered when nothing had ever run them.
//
// These are unit tests against the real class with a fake Durable Object state. They do
// not replace an end-to-end run against `wrangler dev` (see npm run test:integration),
// but they do exercise the logic that was previously untested, including the two failures
// that only appear after a hibernation wake and cannot be reached from the outside at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomHubDO, mintHostToken, isValidHostToken } from "./src/worker.js";

const SECRET = "test-secret-value";

// A stand-in for the Durable Object platform: storage that survives across "wakes", an
// alarm slot, and a list of live websockets.
function makeState(initial = new Map()) {
  const store = new Map(initial);
  let alarm = null;
  const sockets = [];
  return {
    sockets,
    storage: {
      async list({ prefix }) {
        const out = new Map();
        for (const [k, v] of store) if (k.startsWith(prefix)) out.set(k, v);
        return out;
      },
      async put(k, v) { store.set(k, JSON.parse(JSON.stringify(v))); },
      async get(k) { return store.get(k); },
      async delete(k) { store.delete(k); },
      async getAlarm() { return alarm; },
      async setAlarm(t) { alarm = t; },
    },
    getWebSockets() { return sockets; },
    _store: store,
  };
}

function fakeSocket(meta, readyState = 1) {
  const sent = [];
  return {
    readyState,
    sent,
    send(data) { sent.push(JSON.parse(data)); },
    close() { this.readyState = 3; },
    deserializeAttachment() { return meta; },
    serializeAttachment(next) { Object.assign(meta, next); },
  };
}

test("host token: a token this worker issued verifies, a forged one does not", async () => {
  const token = await mintHostToken(SECRET, "ABCDEF");
  assert.equal(typeof token, "string");
  assert.equal(token.length, 64);
  assert.equal(await isValidHostToken(SECRET, "ABCDEF", token), true);
  assert.equal(await isValidHostToken(SECRET, "ABCDEF", "f".repeat(64)), false, "a forged token proves nothing");
  assert.equal(await isValidHostToken(SECRET, "GHIJKL", token), false, "a token is bound to one room");
  assert.equal(await isValidHostToken(SECRET, "ABCDEF", token.slice(0, 63)), false);
  assert.equal(await isValidHostToken("", "ABCDEF", token), false, "no secret means no host reclaim, ever");
});

// The watchdog exists for a leader that has frozen. A frozen leader keeps the room quiet,
// quiet lets the Durable Object hibernate, and _boot used to stamp lastHeartbeatAt to the
// current time on every wake. The clock was therefore always freshly zeroed by the time
// the alarm looked at it, and the handoff could never fire in the one case it is for.
test("hibernation: the heartbeat clock survives a wake instead of being reset", async () => {
  const longAgo = Date.now() - 120000;
  const state = makeState(new Map([[
    "room:ABCDEF",
    { code: "ABCDEF", hostId: "u1", mode: "everyone", createdAt: longAgo, lastActivity: longAgo, lastHeartbeatAt: longAgo, playbackState: { playing: false, currentTime: 0, playbackRate: 1, lastUpdate: longAgo } },
  ]]));
  const hub = new RoomHubDO(state, { HOST_TOKEN_SECRET: SECRET });
  await hub.bootPromise;
  const room = hub.rooms.get("ABCDEF");
  assert.ok(room, "the room came back from storage");
  assert.equal(room.lastHeartbeatAt, longAgo, "a wake must not pretend the leader just beat");
});

test("hibernation: a room with no recorded beat still gets a usable clock", async () => {
  const state = makeState(new Map([[
    "room:ABCDEF",
    { code: "ABCDEF", hostId: "u1", mode: "everyone", createdAt: Date.now(), lastActivity: Date.now(), playbackState: { playing: false, currentTime: 0, playbackRate: 1, lastUpdate: Date.now() } },
  ]]));
  const hub = new RoomHubDO(state, { HOST_TOKEN_SECRET: SECRET });
  await hub.bootPromise;
  assert.equal(typeof hub.rooms.get("ABCDEF").lastHeartbeatAt, "number");
});

// A setTimeout cannot outlive hibernation. A room mid-grace therefore woke up with no
// timer and nothing that would ever set one, so it stayed in storage forever counting
// against the room cap.
test("hibernation: an empty room re-arms its grace timer on the way back", async () => {
  const state = makeState(new Map([[
    "room:ABCDEF",
    { code: "ABCDEF", hostId: "u1", mode: "everyone", createdAt: Date.now(), lastActivity: Date.now(), playbackState: { playing: false, currentTime: 0, playbackRate: 1, lastUpdate: Date.now() } },
  ]]));
  const hub = new RoomHubDO(state, { HOST_TOKEN_SECRET: SECRET });
  await hub.bootPromise;
  const room = hub.rooms.get("ABCDEF");
  assert.ok(room.emptyDeleteTimer, "a room nobody is in must be counting down to deletion");
  clearTimeout(room.emptyDeleteTimer);
});

// The per-IP cap lived only in memory, so every wake handed the same address a fresh ten.
test("hibernation: the per-IP connection census is rebuilt from surviving sockets", async () => {
  const state = makeState();
  state.sockets.push(fakeSocket({ userId: "u1", userName: "A", ip: "1.2.3.4" }));
  state.sockets.push(fakeSocket({ userId: "u2", userName: "B", ip: "1.2.3.4" }));
  state.sockets.push(fakeSocket({ userId: "u3", userName: "C", ip: "5.6.7.8" }));
  const hub = new RoomHubDO(state, { HOST_TOKEN_SECRET: SECRET });
  await hub.bootPromise;
  assert.equal(hub.connectionsPerIp.get("1.2.3.4"), 2, "two live sockets from one address still count as two");
  assert.equal(hub.connectionsPerIp.get("5.6.7.8"), 1);
});

// There is no ping/pong here, so a member whose lid closed without a clean close frame
// used to stay in the room forever, inflating counts and holding a slot.
test("liveness: a socket that died without closing is reaped and the room is told", async () => {
  const state = makeState();
  const alive = fakeSocket({ userId: "u1", userName: "Alive", currentRoom: "ABCDEF", ip: "1.1.1.1" }, 1);
  const dead = fakeSocket({ userId: "u2", userName: "Gone", currentRoom: "ABCDEF", ip: "2.2.2.2" }, 3);
  state.sockets.push(alive, dead);
  state._store.set("room:ABCDEF", {
    code: "ABCDEF", hostId: "u1", mode: "everyone", createdAt: Date.now(), lastActivity: Date.now(),
    playbackState: { playing: false, currentTime: 0, playbackRate: 1, lastUpdate: Date.now() },
  });
  const hub = new RoomHubDO(state, { HOST_TOKEN_SECRET: SECRET });
  await hub.bootPromise;
  assert.equal(hub.rooms.get("ABCDEF").members.size, 2);

  hub._reapDeadSockets();

  assert.equal(hub.rooms.get("ABCDEF").members.size, 1, "the dead socket is gone");
  const left = alive.sent.find((m) => m.type === "member-left");
  assert.ok(left, "the people still watching are told somebody dropped");
  assert.equal(left.memberCount, 1);
});

// The leader is the only member who broadcasts position. Handing the job to a socket that
// is already gone means the room goes silent with nothing to notice it.
test("liveness: the heartbeat leader is never a closed socket", async () => {
  const state = makeState();
  const dead = fakeSocket({ userId: "u1", userName: "Gone", currentRoom: "ABCDEF" }, 3);
  const alive = fakeSocket({ userId: "u2", userName: "Alive", currentRoom: "ABCDEF" }, 1);
  state.sockets.push(dead, alive);
  state._store.set("room:ABCDEF", {
    code: "ABCDEF", hostId: "u1", mode: "everyone", createdAt: Date.now(), lastActivity: Date.now(),
    playbackState: { playing: false, currentTime: 0, playbackRate: 1, lastUpdate: Date.now() },
  });
  const hub = new RoomHubDO(state, { HOST_TOKEN_SECRET: SECRET });
  await hub.bootPromise;
  assert.equal(hub._heartbeatLeader(hub.rooms.get("ABCDEF")), "u2", "the job goes to someone who can actually do it");
});

// Expired rooms had no reaper here at all: ROOM_TTL_MS was declared and never read.
test("expiry: a room past its TTL is swept and its members are told", async () => {
  const state = makeState();
  const ws = fakeSocket({ userId: "u1", userName: "A", currentRoom: "ABCDEF" }, 1);
  state.sockets.push(ws);
  const ancient = Date.now() - 13 * 3600000; // TTL is 12h
  state._store.set("room:ABCDEF", {
    code: "ABCDEF", hostId: "u1", mode: "everyone", createdAt: ancient, lastActivity: ancient,
    playbackState: { playing: false, currentTime: 0, playbackRate: 1, lastUpdate: ancient },
  });
  const hub = new RoomHubDO(state, { HOST_TOKEN_SECRET: SECRET });
  await hub.bootPromise;
  assert.equal(hub.rooms.has("ABCDEF"), false, "a room nobody has touched in half a day is gone");
  assert.ok(ws.sent.some((m) => m.type === "error"), "and the people in it were told why");
});

// HTTP surface: the join page used to be an open redirect and used to interpolate an
// unvalidated path segment into an inline onclick.
async function joinResponse(hub, path) {
  return hub.fetch(new Request(`https://example.com${path}`));
}

test("join page: a code we could never have issued is refused, not rendered", async () => {
  const hub = new RoomHubDO(makeState(), { HOST_TOKEN_SECRET: SECRET });
  const res = await joinResponse(hub, `/join/${encodeURIComponent("X');alert(1)//")}`);
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.ok(!body.includes("alert(1)"), "the payload must not reach the page at all");
});

test("join page: ?url= is not an open redirect", async () => {
  const hub = new RoomHubDO(makeState(), { HOST_TOKEN_SECRET: SECRET });
  const res = await joinResponse(hub, `/join/ABCDEF?url=${encodeURIComponent("https://evil.example/phish")}`);
  assert.notEqual(res.status, 302, "our domain must not send anyone to a URL from the query string");
  const body = await res.text();
  assert.ok(body.includes("ABCDEF"));
});

test("join page: carries no inline JavaScript and a script-free CSP", async () => {
  const hub = new RoomHubDO(makeState(), { HOST_TOKEN_SECRET: SECRET });
  const res = await joinResponse(hub, "/join/ABCDEF");
  const body = await res.text();
  assert.ok(!body.includes("onclick"), "no JS context for a room code to reach");
  assert.match(res.headers.get("content-security-policy") || "", /default-src 'none'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("join page: redirects to the room's own video when it has one", async () => {
  const state = makeState();
  state._store.set("room:ABCDEF", {
    code: "ABCDEF", hostId: "u1", mode: "everyone", createdAt: Date.now(), lastActivity: Date.now(),
    videoUrl: "https://youtube.com/watch?v=x",
    playbackState: { playing: false, currentTime: 0, playbackRate: 1, lastUpdate: Date.now() },
  });
  const hub = new RoomHubDO(state, { HOST_TOKEN_SECRET: SECRET });
  await hub.bootPromise;
  const res = await joinResponse(hub, "/join/ABCDEF");
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /wt_room=ABCDEF/);
});

// An ad break is precisely the period during which nobody sends anything, so the object is
// very likely to hibernate in the middle of one. Losing who was in a break there meant the
// room believed everyone was watching again, unfroze the clock while they were all still
// in their ads, and delivered the exact over-advance the freeze exists to prevent.
test("hibernation: who is in an ad break survives a wake", async () => {
  const state = makeState();
  const a = fakeSocket({ userId: "u1", userName: "A", currentRoom: "ABCDEF", ip: "1.1.1.1", adActive: true });
  const b = fakeSocket({ userId: "u2", userName: "B", currentRoom: "ABCDEF", ip: "2.2.2.2", adActive: true });
  state.sockets.push(a, b);
  state._store.set("room:ABCDEF", {
    code: "ABCDEF", hostId: "u1", mode: "everyone", createdAt: Date.now(), lastActivity: Date.now(),
    playbackState: { playing: true, currentTime: 100, playbackRate: 1, lastUpdate: Date.now(), frozenAt: Date.now() },
  });
  const hub = new RoomHubDO(state, { HOST_TOKEN_SECRET: SECRET });
  await hub.bootPromise;
  const room = hub.rooms.get("ABCDEF");
  assert.equal(room.members.get("u1").adActive, true, "a wake must not forget who was mid-break");
  assert.equal(hub._everyMemberInAd(room), true, "so the room is still correctly dark");
});

test("ad freeze: the clock holds while every member is in a break and restarts when one returns", async () => {
  const state = makeState();
  const a = fakeSocket({ userId: "u1", userName: "A", currentRoom: "ABCDEF", ip: "1.1.1.1" });
  const b = fakeSocket({ userId: "u2", userName: "B", currentRoom: "ABCDEF", ip: "2.2.2.2" });
  state.sockets.push(a, b);
  const start = Date.now() - 5000; // the film has been running five seconds
  state._store.set("room:ABCDEF", {
    code: "ABCDEF", hostId: "u1", mode: "everyone", createdAt: start, lastActivity: start,
    playbackState: { playing: true, currentTime: 100, playbackRate: 1, lastUpdate: start },
  });
  const hub = new RoomHubDO(state, { HOST_TOKEN_SECRET: SECRET });
  await hub.bootPromise;
  const room = hub.rooms.get("ABCDEF");

  hub._handleAdState(a, hub._meta(a), { type: "ad-state", active: true });
  assert.ok(!room.playbackState.frozenAt, "one person in a break must not stop the film");

  hub._handleAdState(b, hub._meta(b), { type: "ad-state", active: true });
  assert.ok(room.playbackState.frozenAt, "with nobody watching, the clock holds");
  // The held position is where the film actually was, not where it started.
  assert.ok(room.playbackState.currentTime >= 104, "and it holds at the true position, ~105s");

  const heldAt = room.playbackState.currentTime;
  hub._handleAdState(a, hub._meta(a), { type: "ad-state", active: false });
  assert.equal(room.playbackState.frozenAt, null, "somebody is watching again");
  assert.equal(room.playbackState.currentTime, heldAt, "and it restarts from where it stopped");
});

// A reaped host used to leave room.hostId pointing at somebody who could never come back,
// which in a host-only room rejected everyone else's play and pause forever.
test("liveness: a host whose socket died still hands over the controls", async () => {
  const state = makeState();
  const deadHost = fakeSocket({ userId: "u1", userName: "Host", currentRoom: "ABCDEF" }, 3);
  const alive = fakeSocket({ userId: "u2", userName: "Guest", currentRoom: "ABCDEF" }, 1);
  state.sockets.push(deadHost, alive);
  state._store.set("room:ABCDEF", {
    code: "ABCDEF", hostId: "u1", mode: "host", createdAt: Date.now(), lastActivity: Date.now(),
    playbackState: { playing: false, currentTime: 0, playbackRate: 1, lastUpdate: Date.now() },
  });
  const hub = new RoomHubDO(state, { HOST_TOKEN_SECRET: SECRET });
  await hub.bootPromise;

  hub._reapDeadSockets();

  const room = hub.rooms.get("ABCDEF");
  assert.equal(room.hostId, "u2", "the controls go to somebody who is actually here");
  assert.equal(room.mode, "host", "but the room does not unlock immediately: a reload looks the same from here");
  assert.ok(room.hostAbsentSince, "the unlock is pending, not skipped");
});

test("host absence: a room unlocks only after the host has really gone", async () => {
  const state = makeState();
  const alive = fakeSocket({ userId: "u2", userName: "Guest", currentRoom: "ABCDEF" }, 1);
  state.sockets.push(alive);
  state._store.set("room:ABCDEF", {
    code: "ABCDEF", hostId: "u2", mode: "host", createdAt: Date.now(), lastActivity: Date.now(),
    hostAbsentSince: Date.now() - 1000, // gone for a second: still within the grace window
    playbackState: { playing: false, currentTime: 0, playbackRate: 1, lastUpdate: Date.now() },
  });
  const hub = new RoomHubDO(state, { HOST_TOKEN_SECRET: SECRET });
  await hub.bootPromise;

  hub._sweepHostAbsence();
  assert.equal(hub.rooms.get("ABCDEF").mode, "host", "a brief absence is a reload, not a departure");

  hub.rooms.get("ABCDEF").hostAbsentSince = Date.now() - 120000; // two minutes gone
  hub._sweepHostAbsence();
  assert.equal(hub.rooms.get("ABCDEF").mode, "everyone", "but a real departure must not leave everyone locked out");
});

test("liveness: a reaped speaker's voice state is torn down for the others", async () => {
  const state = makeState();
  const alive = fakeSocket({ userId: "u1", userName: "A", currentRoom: "ABCDEF" }, 1);
  const dead = fakeSocket({ userId: "u2", userName: "B", currentRoom: "ABCDEF" }, 3);
  state.sockets.push(alive, dead);
  state._store.set("room:ABCDEF", {
    code: "ABCDEF", hostId: "u1", mode: "everyone", createdAt: Date.now(), lastActivity: Date.now(),
    playbackState: { playing: false, currentTime: 0, playbackRate: 1, lastUpdate: Date.now() },
  });
  const hub = new RoomHubDO(state, { HOST_TOKEN_SECRET: SECRET });
  await hub.bootPromise;
  hub.rooms.get("ABCDEF").members.get("u2").voiceActive = true;

  hub._reapDeadSockets();

  const voiceMsg = alive.sent.find((m) => m.type === "voice-state" && m.userId === "u2");
  assert.ok(voiceMsg, "the others are told to tear down the peer connection");
  assert.equal(voiceMsg.active, false);
});
