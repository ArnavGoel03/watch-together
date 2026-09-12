# Watch Together: Cloudflare Workers port

Same protocol as `../server/`, deployed on Cloudflare Workers + a Durable Object.
Both backends can run side by side; the extension picks one per session.

## Why this exists

- **Edge ingress**: requests enter Cloudflare, then route to one shared Durable Object.
  Room processing is centralized, so global low latency is not guaranteed.
- **No cold-start sleep**: Render free tier sleeps after 15 minutes idle. Workers don't.
- **Cheaper at scale**: `$5/mo` Workers Paid plan covers up to 10M Durable Object requests, which is roughly 10× what 100 daily users will generate.

The downside is a one-time rewrite cost, which you've already paid by reading this sentence. The wire protocol matches `../server/server.js` exactly so the extension only needs the WebSocket URL changed.

## First-time deploy

```bash
cd server-cf
npm install
npx wrangler login          # opens a browser; one-time
npx wrangler deploy
```

The deploy command prints your worker URL, e.g. `https://watch-together-cf.your-account.workers.dev`. Use that as the WebSocket URL: `wss://watch-together-cf.your-account.workers.dev`.

## Local development

```bash
cd server-cf
npx wrangler dev --port 8787
# then point the extension at ws://localhost:8787
```

## Verify the Worker

From the repository root, install dependencies in `server/` and `server-cf/`,
then run `npm --prefix server-cf test` for unit coverage and
`npm --prefix server-cf run test:integration` for the real local runtime smoke.
The smoke creates two local WebSockets, checks room creation/join/playback and
malformed invite handling, then terminates its runtime and removes temporary
storage. It does not prove production hibernation behavior.

## How the extension picks which backend

Open the extension popup → Settings → "Server URL". Pick the Cloudflare URL to use this backend, or the Render URL for the other. Both members of a room must be on the same backend (a CF room code doesn't exist on Render and vice versa).

## Architecture notes

- **One Durable Object** (`RoomHubDO`, named `"hub"`) holds all rooms. Single-DO is fine for the friend-watching-together scale (hundreds of concurrent users). To shard, change the `idFromName("hub")` calls in `worker.js` to `idFromName("hub-" + hash(roomCode))` and run multiple instances.
- **WebSocket Hibernation API**: `state.acceptWebSocket(ws)` lets the DO sleep when no messages are flowing, dropping CPU charges to zero. State persists via `state.storage` and per-WS attachments.
- **Empty-room grace**: same 60s window as the Node server so a solo leaver can rejoin the same code.
- **Rate limit + per-IP cap**: same defaults as the Node server. In-memory; rebuilds on DO restart.
