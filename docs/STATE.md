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
- **Production backend: Cloudflare** (`wss://watch-together-cf.goelhome.workers.dev`),
  deployed 2026-08-21, with `HOST_TOKEN_SECRET` set as a Worker secret. **Render is the
  fallback**, and a real one: if the first relay does not answer, `relay.js` walks to the
  next on its own. Render is also what every already-installed v1.1.0 copy still talks to,
  so it does not get to rot.

  Cloudflare is primary because Durable Objects hibernate and wake on the next message: no
  spin-down, no cold start, and the whole "we paused for dinner and the room was gone" class
  of failure does not exist there. It was safe to switch because v1.2.0 has not shipped, so
  no installed copy had the new list yet.
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

## The look, and why it is not purple

A watch party happens in the dark, on top of somebody else's player. So the design is a
projection booth rather than a dashboard: near-black surfaces, hairline rules, one warm
lamp-amber accent (`#e8a33d`), and no gradients anywhere.

The previous violet-to-indigo gradient was removed deliberately, not incidentally. That
palette is the house style of every generated interface, and a product that looks
auto-produced is not trusted with a viewer's Netflix session. The amber also earns its place
practically: every player this sits on top of has already claimed a colour (YouTube and
Netflix red, Prime blue), and a warm accent stays legible as OURS rather than reading as
part of the page underneath.

Colours are defined once per surface as CSS custom properties, in the token block at the top
of `overlay.js`'s injected stylesheet and in `:root` in `popup.css`, and both servers' join
pages use the same values so the first thing an invited person sees is recognisably the same
product. **A colour written out by hand anywhere else is drift**, and the two token blocks
are kept in step by hand, which is the one place this repo still has a manual invariant.

## Progressive disclosure

The default surface is three things: the room code, who is here, and chat. That is the whole
job for most people, and it is what somebody sees on first open.

Everything else lives in one drawer, grouped into five sections (Sync, Room, Voice call, On
this device, Connection). The grouping is not decoration: each heading carries the answer to
the question people actually have about a setting, which is whether it affects the room or
only them. Host-only controls are disabled with a badge that reads "you" or "host only"
depending on who is looking, rather than describing the control in the abstract.

Both disclosures remember being opened, so a power user opens them once. That persistence is
why the browser test asserting the collapsed default uses the GUEST profile: the host profile
has opened them by then, and the preference is real.

## Wait for slow connections

When somebody's connection stalls they fall behind, and drift correction then seeks them
FORWARD to catch up, skipping exactly the footage they were waiting to load. Then it happens
again. On a weak connection that person watches the film as a slideshow with pieces missing
while everybody else sees nothing wrong.

Turning this on makes the room pause until they are ready and resume from where it stopped.
Three things about it are deliberate:

- **Off by default and host-controlled.** One person's wifi stopping everyone else's film is
  a social decision, not a technical one.
- **It gives up after `WAIT_FOR_SLOW_MAX_MS` (60s).** A connection that never recovers must
  not hold four other people hostage, so the room carries on without them.
- **The room says who it is waiting for.** A room that stops on its own with nothing on
  screen to explain it reads as a bug.

Buffering comes from the player's own `waiting`/`stalled` events, announced only after it has
lasted more than a moment, and cleared the instant playback resumes.

## Permissions: a short list, then ask (changed 2026-08-21)

The extension used to require `<all_urls>` before doing anything. That is the single biggest
thing a Chrome Web Store reviewer weighs, and an earlier version of this extension was
already rejected once over permission breadth.

It now requires only the sites that actually have adapters (YouTube, Netflix, Hotstar,
JioHotstar, Prime Video, Disney+) plus loopback, and offers `<all_urls>` as an OPTIONAL
grant. On any other site the popup shows "Enable on this site", the viewer grants that one
origin, and:

1. `site-granted` injects the scripts into the tab they are already looking at, because
   nobody expects to reload a page after saying yes, and
2. `chrome.scripting.registerContentScripts` registers the granted origins so it keeps
   working on every future visit without asking again.

Same capability, completely different posture: "reads every page you visit" becomes "works
on six video sites, and asks before touching anything else".

Two things to know if you touch this:

- **`http://localhost/*` and `http://127.0.0.1/*` are in the required list on purpose.** They
  grant access to nobody's data, and without them the two-browser harness cannot run at all,
  because Chrome's permission dialog cannot be automated. Removing them means the real
  browser tests stop covering anything.
- **The file list is defined once**, as `INJECT_FILES` in `config.js`, and the manifest is
  checked against it by a test. A file present in one and missing from the other loads an
  extension that silently does nothing on exactly the sites a viewer granted by hand, which
  is close to undiagnosable from a bug report.

The optional-permission flow itself is covered by unit-level checks, not by the browser
harness, for the dialog reason above. It wants one manual pass on a site outside the list
before the store upload.

## Why rooms used to die halfway through a film

This was the most damaging failure the product had, and it had several causes. All are now
closed, but the shape of the problem is worth keeping in mind, because every one of them was
a SILENCE being mistaken for an ending:

- **The free-tier host spinning down.** Render sleeps a service after roughly fifteen
  minutes without traffic, and rooms live in memory, so a spin-down took every room with it.
- **The adaptive heartbeat made this worse before it made it better.** Once a paused room
  and a room of one stopped sending anything (correct, and a large cost saving), a party
  pausing for dinner produced exactly zero traffic and looked identical to a party that had
  ended.
- **Room TTL.** A room ages out from `lastActivity`, which playback traffic used to be the
  only thing refreshing.

The fix is a keepalive: while anybody is in a room, the client sends `ping` once a minute.
It marks the room alive and nothing else. It deliberately does NOT count as proof that
somebody is watching, because treating it that way would unfreeze the clock during the very
ad break the freeze exists for. Sixty messages an hour against the 720 the old fixed
heartbeat cost.

`.github/workflows/keep-warm.yml` covers the other half, the quiet period BEFORE a party
starts, so the first person to create a room does not sit through a cold boot. It is free
only because this repository is public; see the comment in that file.

Rooms also survive a genuine restart via `recreateIfMissing`, and empty rooms linger for 30
minutes so a browser restart or a dead wifi stretch can rejoin the same code.

Moving to Cloudflare removes the whole class: Durable Objects hibernate and wake on the next
message, with no spin-down and no cold start.

## Switching what you are watching, mid-party

This already works, and it works for all three cases people ask about:

- **Next episode of the same series.** Netflix changes the URL, so the move is detected and
  broadcast, and everyone follows.
- **A different series on the same site.** Identical mechanism.
- **A different site entirely, YouTube to Netflix.** Also works, but by a different route: a
  cross-site jump destroys the content script, so nothing in the page sees the change. The
  party tab announces the move when it comes back up and finds it is not where the room is
  (`onResume`), and the background muzzles the opposite case with `navSuppressUntil` so a tab
  being redirected INTO someone else's video does not bounce the room back.

The room code never changes, and the shareable `/join/CODE` link redirects to whatever the
room is watching NOW, so somebody arriving an hour late lands on the right video. What none
of this can solve is access: a friend still needs their own Netflix login.

Note that whoever's autoplay fires first drags the room to the next episode. That is the
intended behaviour for a watch party, but it is worth knowing before someone reports it.

## Voice calls: a link, not an integration (decided 2026-08-21)

The room carries a call link that the host pins once, and everyone gets a button for it,
including people who join an hour late. There are quick "Start a Zoom" and "Start a Meet"
buttons that open the platform's own new-meeting page; the host then copies that link back.

This is deliberately NOT an API integration. Creating meetings through the Zoom or Google
APIs needs OAuth, a published and reviewed vendor app, and server-side token storage, which
is weeks of work and an ongoing compliance surface, for something a signed-in user already
does in one click. The link approach needs no keys, no review, and no new permissions.

**Standing decision: we only ever replace this with our own video, never with a deeper
third-party integration.** If we build voice or video ourselves, this becomes the fallback
for people who prefer their own tool. Until then, adding Zoom OAuth would be buying a large
maintenance burden to remove one paste.

The link is validated on both the client and the server against an allowlist of real
platforms (Zoom, Google Meet, Teams, Discord, Whereby, Jitsi, plus Zoom's `zoommtg:` deep
link). It has to be: this becomes a button a whole room is invited to press, so a free-text
URL field would be a convenient way to get strangers to click on anything. Only the host can
set it.

## Audio: there is no shared audio channel, and that is the point

A common worry is the film's audio colliding with the call. It cannot, because this
extension never transmits audio: every viewer plays their own copy from their own source
and hears their own speakers. Only playback POSITION crosses the network.

The real problem is local, and physical: your speakers reaching your own microphone. So the
control that helps is a per-viewer volume with a Duck button, which drops the film to 15%
while you talk instead of pausing it for everybody, and restores it after. It touches only
`video.volume` on the one element, never the system volume or an output device, so it cannot
interfere with the call's own audio.

The built-in voice mesh stays disabled for the same reason (`VOICE_ENABLED = false`): two
microphone consumers on one machine is at best an echo problem, and a microphone permission
next to `<all_urls>` is what got an earlier version rejected from the store. There is a test
asserting `getUserMedia` is unreachable.

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

0. **Nothing is blocking a store upload except your decision and one manual pass.** The
   packages are built and verified in `dist/`, the permission breadth that caused the earlier
   rejection is fixed, and the privacy policy matches the code.
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
5. **Set `HOST_TOKEN_SECRET` on Render too**, if you want host status to survive a restart
   on the fallback as well. It is already set on Cloudflare, which is primary. Render has no
   CLI login here yet (`render login`), and `render.yaml` declares it with `generateValue`,
   which only applies if the service was created from that blueprint.
6. **Voice is off, not deleted.** `VOICE_ENABLED = false` in `overlay.js`, WebRTC mesh
   intact behind it, deliberately, per the owner. A mic permission is what got an earlier
   version rejected.
