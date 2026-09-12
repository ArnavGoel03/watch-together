// Explicit smoke against an owned relay. Never prints room codes or credentials.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../server/package.json", import.meta.url));
const { WebSocket } = require("ws");
const endpoint = process.argv[2];
assert.ok(endpoint && /^wss:\/\//.test(endpoint), "Pass the owned production wss endpoint explicitly");
const clients = [];
const timer = setTimeout(() => {
  for (const client of clients) client.ws.terminate();
  console.error("Relay smoke exceeded 25 seconds");
  process.exit(1);
}, 25000);

async function connect() {
  const client = { ws: new WebSocket(endpoint, { handshakeTimeout: 5000 }), messages: [] };
  clients.push(client);
  client.ws.on("message", data => client.messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => { client.ws.once("open", resolve); client.ws.once("error", reject); });
  return client;
}
function send(client, message) { client.ws.send(JSON.stringify(message)); }
async function take(client, type) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const index = client.messages.findIndex(message => message.type === type);
    if (index >= 0) return client.messages.splice(index, 1)[0];
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`No ${type} acknowledgement`);
}
try {
  const host = await connect();
  send(host, { type: "create-room", userName: "Release verification" });
  const created = await take(host, "room-created");
  assert.match(created.hostToken, /^[a-f0-9]{32}\.[a-f0-9]{64}$/);
  const guest = await connect();
  send(guest, { type: "join-room", roomCode: created.roomCode, inviteToken: created.inviteToken, userName: "Release verification" });
  const joined = await take(guest, "room-joined");
  send(host, { type: "set-room-access", locked: true, navigationMode: "host" });
  assert.equal((await take(guest, "room-access")).locked, true);
  const fresh = await connect();
  send(fresh, { type: "join-room", roomCode: created.roomCode, inviteToken: created.inviteToken });
  assert.equal((await take(fresh, "error")).code, "ROOM_LOCKED");
  send(fresh, { type: "join-room", roomCode: created.roomCode, memberToken: joined.memberToken });
  await take(fresh, "room-joined");
  send(host, { type: "revoke-invites" });
  const rotated = await take(guest, "room-access");
  assert.equal(rotated.inviteRequired, true);
  assert.notEqual(rotated.inviteToken, created.inviteToken);
  send(host, { type: "sync", action: "seek", playing: false, currentTime: 23, playbackRate: 1 });
  assert.equal((await take(guest, "sync")).currentTime, 23);
  send(host, { type: "remove-member", userId: joined.userId });
  assert.equal((await take(guest, "error")).code, "MEMBER_REMOVED");
  assert.equal((await take(fresh, "error")).code, "MEMBER_REMOVED");
  console.log("Live relay verified: instance-bound host proof, locked join denial, credential rejoin, invite rotation, playback and removal.");
} finally {
  clearTimeout(timer);
  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) send(client, {type: "leave-room"});
    client.ws.close();
  }
}
