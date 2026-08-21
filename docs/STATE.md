# Watch Together: state of the project

Read this before doing anything else. It exists so nobody has to re-derive where things
stand by reading 8,000 lines of source and a year of git log.

Last updated: 2026-08-21, at the end of the v1.2.0 hardening release.

## What it is

A browser extension that keeps video playback in sync between people watching the same
thing in different places, plus the relay server that carries the messages. Chrome (MV3)
and Firefox (MV2). It has real users.

## The one thing to understand first

The two halves ship on completely different timescales, and almost every design decision
follows from that.

| | Ships via | Live after |
|---|---|---|
| `server/`, `server-cf/` | You deploy it | Seconds |
| `extension/` | Chrome Web Store | Days of review, then browser auto-update |

Consequences, in order of how often they bite:

1. **Prefer server-side fixes.** A bug fixable on the server reaches every existing user
   immediately. The same bug fixed in the extension waits on review.
2. **Old clients live for weeks.** Every server change must keep working for the previous
   extension version. That is what the protocol version on each message is for.
3. **The relay address cannot be a hardcoded constant**, or moving the backend strands
   every install until a review clears. See "Moving the backend" below.

## Where things are

- `extension/config.js` is the single source of truth: relay URLs, the protocol version,
  the URL-safety rules, room-code shapes. Anything that used to appear in two files lives
  here now. The server URL was previously written out in four places.
- `extension/relay.js` decides which relay to talk to and handles failover. Loaded by BOTH
  background twins. Shared deliberately: every serious bug in this project's history came
  from `background.js` and `background-firefox.js` carrying separate copies of the same
  logic and drifting apart.
- `types/protocol.d.ts` defines the wire protocol once. `npm run typecheck` checks every
  surface against it.
- `server/server.js` is the reference implementation. `server-cf/src/worker.js` is a
  Durable Objects port of the same protocol and must match it.

## Current status

- **Version 1.2.0**, both manifests, tagged `v1.2.0`. NOT yet uploaded to the Chrome Web
  Store. Every store version is re-reviewed, and an earlier version was rejected once for
  requesting a microphone permission next to `<all_urls>`.
- **Production backend: Render** (`wss://watch-together-server-acwi.onrender.com`), free
  tier. The Cloudflare port exists, is now tested, and is the better platform, but is not
  what users connect to yet.
- **Tests: 170 green** (97 node, 61 vitest, 12 worker) plus 6 real-browser tests driving
  two separate Chrome profiles. Lint and typecheck clean. CI runs all of it.

## Things that will trip you up

- **The browser harness needs Chrome for Testing.** Stable Chrome silently ignores
  `--load-extension` now: the browser starts, the page loads, and no content script is ever
  injected, so every assertion fails on a timeout that reads like a sync bug. Install with
  `npx --prefix server puppeteer browsers install chrome`. On macOS, if extraction mangles
  the app bundle the binary exists but its Frameworks directory does not, and launching dies
  in dlopen; re-extract the official zip with `ditto -x -k`.
- **Two participants need two browser profiles.** One profile is one background worker, so
  one WebSocket, one user, one room. A second tab is not a second person.
- **Headless Chrome does not fire `fullscreenchange`** for a programmatic `requestFullscreen`,
  and screenshotting a page with a decoding video hangs. The fullscreen test fires the event
  explicitly and asserts the extension reacts correctly, which is the part we own.
- **A paused room deliberately stops heartbeating.** If you make the stale-leader watchdog
  stricter, do not treat that silence as a frozen tab. Both servers skip paused rooms.
- **`recreateIfMissing` is not a bug.** Rooms live in memory and a free-tier restart wipes
  them, so a returning member rebuilds theirs from the code. What it must NOT do is grant
  host, which is what the host token fixes.

## How ad breaks work, and why the server has to know

Ads are per-viewer: your pre-roll is not your friend's. So an ad is a "drop out, then catch
back up" event, not a "pause the room" event. Each viewer sits out their own break and is
snapped back to the room's position when it ends.

That is fine until EVERY member is in a break at once, which is exactly what a platform
mid-roll produces, because everyone is at the same timestamp of the same title. The room's
position is stored as `(currentTime, lastUpdate)` and read by extrapolating forward from
`lastUpdate`, on the assumption that playback continued. With nobody watching, that
assumption is false, and a 90-second break used to convince the room that 90 seconds of
film had gone by. Everyone came back and got hard-seeked past the scene they were about to
watch: in sync with each other, and a minute and a half into the future.

So clients report their break state (`ad-state`), and the server:

- **holds the room clock** when the last viewer goes dark (`frozenAt`), and restarts it from
  the held position when the first one returns. While frozen, any position it hands out is
  stamped with the current time, so the client extrapolates by zero.
- **keeps the sync-leader role away from anyone in a break**, since that member has
  deliberately stopped broadcasting position.
- **stops the stale-leader watchdog policing an ad-dark room**, where nobody can beat.

Two things to keep in mind if you touch this:

1. `ad-state` is in `PLAYBACK_TYPES`, so only the party tab may send it. It has to be: the
   message can hold the film still for everyone, and the content script runs on every tab.
2. The client re-asserts its ad state on reconnect and rejoin. The message is only sent on
   a transition, and a socket that is down at that moment drops it silently, which would
   leave the server holding a room for a break that ended long ago.

Client-side detection is heuristic (player ad markers, plus a duration-collapse test with a
warmup after navigation and a three-minute safety valve). It has never been tested against
a real player, because the automated harness only ever drives a bare `<video>`.

## Moving the backend (to Cloudflare, Oracle, anywhere)

Neither step needs a store release to reach existing users:

1. Stand up the new relay. Set `SERVER_MOVED_URL` to its `wss://` address on the OLD
   server and restart. Every client that connects is told to move, remembers it, and
   reconnects there.
2. Add the URL to `SERVER_URLS` in `extension/config.js` so fresh installs go straight to
   it, and ship that whenever you next have a release.

A user who set their own server in Settings always keeps it.

## Cost model

The heartbeat is effectively the entire running cost: it is the only message that fires
forever regardless of what anyone does. Cloudflare bills incoming WebSocket messages at
20:1, so what matters is message COUNT, not size. Shrinking the JSON saves nothing.

As of 1.2.0: a paused room sends nothing, a solo room sends nothing, and a room in sync
eases from 5s to 12s between beats, snapping back on any action. Roughly 720 messages an
hour per room became 300 while playing and 0 while paused, which is about 45 billable
Cloudflare requests for a three-hour film.

The 12s ceiling is not arbitrary: it must stay under the server's `LEADER_STALE_MS` (15s),
or the watchdog demotes a leader who is healthy and merely quiet.

## Open, in rough priority order

1. **Manual smoke on real streaming sites.** Everything automated runs against a bare
   `<video>` element. Real YouTube, Netflix and JioHotstar players, their ad breaks and
   their DRM are not covered by any test and never have been. The ad-break logic is now
   correct by construction on the server side and covered by tests, but whether the client
   correctly RECOGNISES an ad on each real player is still unverified.
2. **Buffering is the next real gap.** When a viewer stalls they fall behind, and the room
   hard-seeks them forward to catch up, which skips exactly the footage they were waiting
   to load. Then it happens again. The primitives are all here now (drift is measured, and
   `ad-state` established the per-member status channel); what is missing is a "wait for
   me" mode that pauses the room while somebody is genuinely stuck.
3. **Mismatched sources.** Two people on different rips or regions of the same film have
   timelines offset by seconds or minutes, and sync currently fights that forever instead
   of letting a viewer say "I am 12 seconds ahead, lock it in".
4. **Decide on the Chrome Web Store upload.** 1.2.0 is packaged and the known review risks
   are addressed (`activeTab` removed, privacy policy now matches what the code does), but
   `<all_urls>` remains the standing rejection risk.
5. **Move production to Cloudflare.** The port is fixed and tested; it needs a deploy, a
   `HOST_TOKEN_SECRET`, and then the `SERVER_MOVED_URL` migration above.
6. **Voice is off, not deleted.** `VOICE_ENABLED = false` in `overlay.js`, WebRTC mesh
   intact behind it, deliberately, per the owner. A mic permission is what got an earlier
   version rejected.
