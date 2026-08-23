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
test("hibernation: an empty room keeps counting down across a wake, from where it was", async () => {
  const state = makeState(new Map([[
    "room:ABCDEF",
    { code: "ABCDEF", hostId: "u1", mode: "everyone", createdAt: Date.now(), lastActivity: Date.now(), playbackState: { playing: false, currentTime: 0, playbackRate: 1, lastUpdate: Date.now() } },
  ]]));
  const hub = new RoomHubDO(state, { HOST_TOKEN_SECRET: SECRET });
  await hub.bootPromise;
  const room = hub.rooms.get("ABCDEF");
  assert.ok(room.emptySince, "a room nobody is in must be counting down to deletion");
  assert.ok(await state.storage.get("room:ABCDEF"), "and it is still there, because the window has not passed");

  // The point of a deadline rather than a timer. A timer dies with the object, so the
  // countdown restarted from the full thirty minutes on every unrelated wake and the room
  // could outlive its own grace window by hours.
  const emptied = room.emptySince;
  const woken = new RoomHubDO(makeState(state._store), { HOST_TOKEN_SECRET: SECRET });
  await woken.bootPromise;
  assert.equal(woken.rooms.get("ABCDEF").emptySince, emptied, "a sleep does not restart the clock");
});

test("empty rooms: one whose grace window has passed is collected, even with nobody left to wake the object", async () => {
  // The failure this closes: when the LAST room went empty, nothing scheduled an alarm at
  // all, so the object slept with no timer of any kind. The room was never deleted and sat
  // in storage against MAX_ROOMS until something unrelated happened to wake the object.
  const longAgo = Date.now() - 31 * 60000;
  const state = makeState(new Map([[
    "room:ABCDEF",
    { code: "ABCDEF", hostId: "u1", mode: "everyone", emptySince: longAgo, createdAt: longAgo, lastActivity: longAgo, playbackState: { playing: false, currentTime: 0, playbackRate: 1, lastUpdate: longAgo } },
  ]]));
  const hub = new RoomHubDO(state, { HOST_TOKEN_SECRET: SECRET });
  await hub.bootPromise;
  assert.equal(hub.rooms.has("ABCDEF"), false, "past its grace window, the room is gone from memory");
  assert.equal(await state.storage.get("room:ABCDEF"), undefined, "and from storage, so it stops counting against the cap");
});

test("empty rooms: the object wakes itself for a grace window with nobody in any room", async () => {
  const state = makeState(new Map([[
    "room:ABCDEF",
    { code: "ABCDEF", hostId: "u1", mode: "everyone", emptySince: Date.now(), createdAt: Date.now(), lastActivity: Date.now(), playbackState: { playing: false, currentTime: 0, playbackRate: 1, lastUpdate: Date.now() } },
  ]]));
  const hub = new RoomHubDO(state, { HOST_TOKEN_SECRET: SECRET });
  await hub.bootPromise;
  await hub._scheduleLeaderSweep();
  const alarm = await state.storage.getAlarm();
  assert.ok(alarm, "an alarm is the only timer that outlives hibernation, so one has to be set");
  assert.ok(alarm > Date.now() + 60000, "and it is set for the deadline, not five seconds away, so an empty room is not billed a wake every five seconds for thirty minutes");
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

// ============================================================================
// The guards this relay was missing that its Node twin had.
//
// Every test below covers something that was correct in server/server.js and absent here,
// which is why none of it was noticed: the file said it was kept in lockstep by hand, and
// nothing anywhere disagreed. This is the relay production runs.
// ============================================================================

/** A hub with one socket already connected, ready to send messages. */
async function hubWithSocket(meta = {}) {
  const state = makeState();
  const hub = new RoomHubDO(state, { HOST_TOKEN_SECRET: SECRET });
  await hub.bootPromise;
  const attachment = { userId: "u1", userName: "A", currentRoom: null, ip: "1.2.3.4", voiceActive: false, ...meta };
  const ws = fakeSocket(attachment);
  state.sockets.push(ws);
  return { hub, state, ws, attachment };
}

test("create-room: the per-address room budget is actually enforced on the path that makes rooms", async () => {
  // _claimRoomSlot was simply never called here. One address could mint rooms as fast as
  // the generic message limiter allowed, and each one then sits in storage for its whole
  // grace window, so the global cap filled for every real user everywhere.
  const { hub, ws } = await hubWithSocket();
  let made = 0;
  for (let i = 0; i < 40; i++) {
    ws.serializeAttachment({ currentRoom: null });
    await hub.webSocketMessage(ws, JSON.stringify({ type: "create-room", userName: "A" }));
    made = hub.rooms.size;
  }
  assert.ok(made <= 20, `one address minted ${made} rooms, past the twenty it is allowed to hold`);
  const refusals = ws.sent.filter((m) => m.type === "error");
  assert.ok(refusals.length > 0, "and it was told why, rather than silently failing");
});

test("heartbeat: host-only mode is not bypassable through the heartbeat channel", async () => {
  const { hub, state } = await hubWithSocket();
  const hostMeta = { userId: "host", userName: "Host", currentRoom: "ABCDEF", ip: "1.1.1.1" };
  const guestMeta = { userId: "guest", userName: "Guest", currentRoom: "ABCDEF", ip: "2.2.2.2" };
  const hostWs = fakeSocket(hostMeta);
  const guestWs = fakeSocket(guestMeta);
  state.sockets.push(hostWs, guestWs);
  hub.rooms.set("ABCDEF", {
    code: "ABCDEF", hostId: "host", mode: "host", createdAt: Date.now(), lastActivity: Date.now(),
    playbackState: { playing: true, currentTime: 100, playbackRate: 1, lastUpdate: Date.now() },
    members: new Map([
      // The host is sitting out a routine advert, which is exactly when the leader role
      // deliberately steps over them and lands on a guest.
      ["host", { ws: hostWs, userName: "Host", adActive: true }],
      ["guest", { ws: guestWs, userName: "Guest", adActive: false }],
    ]),
  });

  await hub.webSocketMessage(guestWs, JSON.stringify({ type: "heartbeat", playing: true, currentTime: 9999, playbackRate: 1 }));
  assert.equal(
    hub.rooms.get("ABCDEF").playbackState.currentTime,
    100,
    "a guest's position drove the host's own video in a room locked to the host"
  );
  assert.equal(hostWs.sent.some((m) => m.type === "heartbeat"), false, "and it was not relayed either");
});

test("ad flag: any message that proves someone is watching clears their break", async () => {
  // ad-state is edge triggered. A "my break ended" lost to a socket that was down at that
  // moment left the member marked dark, and the only paths that could clear it here were
  // sync and heartbeat, both behind checks a guest in a locked room can never pass.
  const { hub, state } = await hubWithSocket();
  const meta = { userId: "u1", userName: "A", currentRoom: "ABCDEF", ip: "1.1.1.1", adActive: true };
  const ws = fakeSocket(meta);
  state.sockets.push(ws);
  hub.rooms.set("ABCDEF", {
    code: "ABCDEF", hostId: "other", mode: "host", createdAt: Date.now(), lastActivity: Date.now(),
    playbackState: { playing: true, currentTime: 10, playbackRate: 1, lastUpdate: Date.now(), frozenAt: Date.now() },
    members: new Map([["u1", { ws, userName: "A", adActive: true }]]),
  });

  await hub.webSocketMessage(ws, JSON.stringify({ type: "chat", message: "still here" }));
  assert.equal(hub.rooms.get("ABCDEF").members.get("u1").adActive, false, "chatting proves you are not in an ad break");
  assert.equal(hub.rooms.get("ABCDEF").playbackState.frozenAt, null, "so the room's clock starts again");
});

test("ad flag: a ping does not count as proof anybody is watching", async () => {
  // The exception that matters. A ping says the party is still there, not that anyone is
  // looking at the film, and treating it as proof would unfreeze the clock during the very
  // break the freeze exists for.
  const { hub, state } = await hubWithSocket();
  const meta = { userId: "u1", userName: "A", currentRoom: "ABCDEF", ip: "1.1.1.1", adActive: true };
  const ws = fakeSocket(meta);
  state.sockets.push(ws);
  const frozenAt = Date.now();
  hub.rooms.set("ABCDEF", {
    code: "ABCDEF", hostId: "u1", mode: "everyone", createdAt: Date.now(), lastActivity: Date.now(),
    playbackState: { playing: true, currentTime: 10, playbackRate: 1, lastUpdate: frozenAt, frozenAt },
    members: new Map([["u1", { ws, userName: "A", adActive: true }]]),
  });

  await hub.webSocketMessage(ws, JSON.stringify({ type: "ping" }));
  assert.equal(hub.rooms.get("ABCDEF").members.get("u1").adActive, true, "a keepalive is not a viewing");
  assert.equal(hub.rooms.get("ABCDEF").playbackState.frozenAt, frozenAt, "and the clock stays held");
});

test("ad freeze: a member whose socket died does not get a vote on whether the room is dark", async () => {
  // A ghost marked "watching" vetoed the freeze on behalf of somebody who is not there,
  // and the room ran on through an ad break exactly as it did before the freeze existed.
  const { hub, state } = await hubWithSocket();
  const liveWs = fakeSocket({ userId: "live", userName: "Live", currentRoom: "ABCDEF", ip: "1.1.1.1" });
  const deadWs = fakeSocket({ userId: "dead", userName: "Dead", currentRoom: "ABCDEF", ip: "2.2.2.2" }, 3);
  state.sockets.push(liveWs);
  const room = {
    code: "ABCDEF", hostId: "live", mode: "everyone", createdAt: Date.now(), lastActivity: Date.now(),
    playbackState: { playing: true, currentTime: 10, playbackRate: 1, lastUpdate: Date.now() },
    members: new Map([
      ["live", { ws: liveWs, userName: "Live", adActive: true }],
      ["dead", { ws: deadWs, userName: "Dead", adActive: false }],
    ]),
  };
  hub.rooms.set("ABCDEF", room);

  assert.equal(hub._everyMemberInAd(room), true, "the only member actually connected is in a break");
  hub._updateRoomAdFreeze(room);
  assert.ok(room.playbackState.frozenAt, "so the clock holds instead of running on without anybody");
});

test("rebuild: a stranger who knows a code cannot rebuild the room and lock it", async () => {
  const { hub, ws } = await hubWithSocket();
  await hub.webSocketMessage(ws, JSON.stringify({
    type: "join-room",
    roomCode: "GHOST1",
    userName: "Stranger",
    recreateIfMissing: true,
    mode: "host",
    hostToken: "f".repeat(64),
    resumeState: { playing: true, currentTime: 30, playbackRate: 1 },
  }));
  const joined = ws.sent.find((m) => m.type === "room-joined");
  assert.ok(joined, "the rebuild itself is allowed: knowing the code is what joining proves too");
  assert.equal(joined.isHost, false, "but a forged token is not a token");
  assert.equal(joined.mode, "everyone", "and mode:host on a rebuild request is not honoured");
  assert.equal(hub.rooms.get("GHOST1").hostId, null, "nobody holds the room");
});

test("rebuild: the real host reclaims with the token this worker issued", async () => {
  const { hub, ws } = await hubWithSocket();
  const token = await mintHostToken(SECRET, "GHOST2");
  await hub.webSocketMessage(ws, JSON.stringify({
    type: "join-room",
    roomCode: "GHOST2",
    userName: "Host",
    recreateIfMissing: true,
    mode: "host",
    hostToken: token,
    resumeState: { playing: false, currentTime: 12, playbackRate: 1 },
  }));
  const joined = ws.sent.find((m) => m.type === "room-joined");
  assert.equal(joined.isHost, true, "the token this worker minted still identifies its host");
  assert.equal(joined.mode, "host", "and their locked room comes back locked");
});

test("rebuild: two members reconnecting at once land in the same room, not two", async () => {
  // The host-token check is a Web Crypto call, and a Durable Object's input gate only holds
  // events back across storage operations. Both callers could find the room missing, both
  // build one, and the second replaced the first: the loser then sat in the real room able
  // to inject sync, navigate and chat while appearing in no member list and no reap.
  const { hub, state } = await hubWithSocket();
  const a = fakeSocket({ userId: "ua", userName: "A", currentRoom: null, ip: "1.1.1.1" });
  const b = fakeSocket({ userId: "ub", userName: "B", currentRoom: null, ip: "2.2.2.2" });
  state.sockets.push(a, b);
  const rebuild = { type: "join-room", roomCode: "GHOST3", userName: "X", recreateIfMissing: true, resumeState: { playing: false, currentTime: 5, playbackRate: 1 } };

  await Promise.all([
    hub.webSocketMessage(a, JSON.stringify(rebuild)),
    hub.webSocketMessage(b, JSON.stringify(rebuild)),
  ]);

  const room = hub.rooms.get("GHOST3");
  assert.equal(hub.rooms.size, 1);
  assert.equal(room.members.size, 2, "both reconnecting members are in the one room that survived");
  assert.ok(room.members.has("ua") && room.members.has("ub"));
});

test("join: guessing room codes has a ceiling", async () => {
  // A miss is free to send and its answer is informative, which together make an unbounded
  // stream of them a search of the code space for other people's parties.
  const { hub, ws } = await hubWithSocket();
  for (let i = 0; i < 40; i++) {
    await hub.webSocketMessage(ws, JSON.stringify({ type: "join-room", roomCode: "AAAA" + String(i).padStart(2, "0") }));
  }
  const limited = ws.sent.filter((m) => m.type === "error" && m.message === "Rate limited - slow down");
  assert.ok(limited.length > 0, "an address may guess forever");
});

test("join: a real room is never refused because somebody else was guessing", async () => {
  const { hub, state, ws } = await hubWithSocket();
  await hub.webSocketMessage(ws, JSON.stringify({ type: "create-room", userName: "Host" }));
  const created = ws.sent.find((m) => m.type === "room-created");

  const guesser = fakeSocket({ userId: "bad", userName: "Bad", currentRoom: null, ip: "9.9.9.9" });
  state.sockets.push(guesser);
  for (let i = 0; i < 40; i++) {
    await hub.webSocketMessage(guesser, JSON.stringify({ type: "join-room", roomCode: "ZZZZ" + String(i).padStart(2, "0") }));
  }

  const friend = fakeSocket({ userId: "good", userName: "Good", currentRoom: null, ip: "8.8.8.8" });
  state.sockets.push(friend);
  await hub.webSocketMessage(friend, JSON.stringify({ type: "join-room", roomCode: created.roomCode, userName: "Good" }));
  assert.ok(friend.sent.find((m) => m.type === "room-joined"), "only misses count, and only against the address making them");
});

test("playback: an absurd position is refused rather than becoming the room's own", async () => {
  const { hub, state } = await hubWithSocket();
  const ws = fakeSocket({ userId: "u1", userName: "A", currentRoom: "ABCDEF", ip: "1.1.1.1" });
  state.sockets.push(ws);
  hub.rooms.set("ABCDEF", {
    code: "ABCDEF", hostId: "u1", mode: "everyone", createdAt: Date.now(), lastActivity: Date.now(),
    playbackState: { playing: true, currentTime: 42, playbackRate: 1, lastUpdate: Date.now() },
    members: new Map([["u1", { ws, userName: "A", adActive: false }]]),
  });

  for (const bad of [1e308, Infinity, -1, "nonsense", null]) {
    await hub.webSocketMessage(ws, JSON.stringify({ type: "sync", playing: true, currentTime: bad, playbackRate: 1 }));
    assert.equal(hub.rooms.get("ABCDEF").playbackState.currentTime, 42, `currentTime ${bad} was accepted`);
  }
});

test("host: the last member out of a locked room does not leave it locked to a ghost", async () => {
  // hostId pointed at somebody gone, so the "an unsteered room goes to whoever arrives
  // first" rule could never fire, and the first friend back to a host-only room could not
  // play, pause or seek anything, with nothing on screen to say why.
  const { hub, state, ws } = await hubWithSocket();
  await hub.webSocketMessage(ws, JSON.stringify({ type: "create-room", userName: "Host", mode: "host" }));
  const created = ws.sent.find((m) => m.type === "room-created");
  await hub.webSocketClose(ws);

  const room = hub.rooms.get(created.roomCode);
  assert.ok(room, "the room outlives its last member by the grace window, so it is still joinable");
  assert.equal(room.hostId, null, "and it is steerable by whoever comes back");

  const friend = fakeSocket({ userId: "friend", userName: "Friend", currentRoom: null, ip: "5.5.5.5" });
  state.sockets.push(friend);
  await hub.webSocketMessage(friend, JSON.stringify({ type: "join-room", roomCode: created.roomCode, userName: "Friend" }));
  const joined = friend.sent.find((m) => m.type === "room-joined");
  assert.equal(joined.isHost, true, "the first friend back can drive the film");
});
