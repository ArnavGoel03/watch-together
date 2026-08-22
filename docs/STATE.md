# Watch Together: state of the project

Read this before doing anything else. It exists so nobody has to re-derive where things
stand by reading 8,000 lines of source and a year of git log.

Last updated: 2026-08-23, at the end of the v1.2.1 release and the first store submission.

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

- **Version 1.2.1**, both manifests. Built and verified in `dist/`.
- **v1.2.0 was submitted for review on 2026-08-22 and is pending.** It contains a bug
  found straight after submitting: the popup header rendered a blank white square where
  the logo should be. 1.2.1 fixes it. Upload 1.2.1 over the pending submission rather
  than letting 1.2.0 through; the review clock restarts either way.
- **The live store version is still 1.0.1, with 37 users.** They have the worst bug in
  the project's history: no `partyTabId`, so playback commands are broadcast to every
  open tab. Getting them off it is the reason this release matters.
- **Publisher account is `yashgoel0304@gmail.com`**, item ID
  `kilmggcpfkcfpkaapillgloabbgmeeoa`. It MUST be published from that account or the 37
  existing users are stranded on 1.0.1 forever.
- **Production backend: Cloudflare** (`wss://watch-together-cf.goelhome.workers.dev`),
  deployed 2026-08-21, with `HOST_TOKEN_SECRET` set as a Worker secret. **Render is the
  fallback**, and a real one: if the first relay does not answer, `relay.js` walks to the
  next on its own. Render is also what every already-installed v1.1.0 copy still talks to,
  so it does not get to rot.

  Cloudflare is primary because Durable Objects hibernate and wake on the next message: no
  spin-down, no cold start, and the whole "we paused for dinner and the room was gone" class
  of failure does not exist there. It was safe to switch because v1.2.0 has not shipped, so
  no installed copy had the new list yet.
- **Tests: 155 green in the default gate** (130 node and vitest, 17 worker) plus 8
  real-browser tests driving two separate Chrome profiles. Lint, typecheck, dash check
  and version metadata all clean. `npm test` runs everything except the browser suite,
  which is `npm run test:browser` and is worth running by hand after any popup or overlay
  change, because it is the only thing that loads the extension for real.
- **Marketing site is live** at `watch.arnavgoel.dev`, with `/support` and `/privacy`.

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

## render.yaml has never actually been applied

Worth knowing before trusting it. The live Render service's environment was completely
EMPTY until `HOST_TOKEN_SECRET` was set by hand through the API, which means the service was
created through the dashboard rather than from the blueprint, and none of the variables
`server/render.yaml` declares (`PORT`, `MAX_ROOMS`, `MAX_ROOM_MEMBERS`, `TRUSTED_PROXY_HOPS`,
and the `generateValue` secret) were ever in effect.

Nothing was broken by that, because every one of them has a sensible default in code and
`TRUSTED_PROXY_HOPS` defaults to 1, which is right for Render. But it does mean the file is
documentation of intent rather than a description of the running service, so do not read it
and assume. If the service is ever recreated from the blueprint, the declared values take
over, including a freshly generated host-token secret, which would invalidate every host
token currently held by a client.

The Render CLI cannot set environment variables (no `env` subcommand as of v2.24.0). Use the
REST API with the key the CLI stores in `~/.render/cli.yaml`, and note that setting a
variable does NOT restart the service on its own: trigger a deploy afterwards, or the change
sits there doing nothing.

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

## The store listing, recorded

Filled in on 2026-08-22. Recorded here because the dashboard is the only other copy and
it is not diffable.

**Rejected on 2026-08-22**, "Spam and placement in the Store", reference Yellow Argon,
for a list of platform names in the item description: YouTube, Netflix, Prime Video,
Disney+, JioHotstar and Hotstar. That string is in no file in this repository.
`store-listing.md` was rewritten to carry no platform names at all in commit 1e977cc,
after the FIRST rejection, so the dashboard is holding older text than the repo is and
the fix is to make the dashboard match `store-listing.md`. It cannot be automated:
Chrome refuses to script, read or screenshot `chrome.google.com/webstore` at all. Record
the description here once it is pasted, because not doing that is how it drifted. See
`docs/ROADMAP.md`.

| Field | Value |
| --- | --- |
| Homepage URL | `https://watch.arnavgoel.dev` |
| Support URL | `https://watch.arnavgoel.dev/support` |
| Privacy policy URL | `https://watch.arnavgoel.dev/privacy` |
| Official URL | left as None. Needs the domain verified in Search Console; `arnavgoel.dev` already has two `google-site-verification` TXT records, so it can be enabled later |
| Category | Entertainment |
| Mature content | off |
| Google Analytics | opted out, so there is no extra data recipient to declare |

Data usage, ticked: **Personally identifiable information** (the display name),
**Personal communications** (chat is relayed), **Web history** (the address of the one
attached tab is transmitted), **User activity** (play, pause and seek are transmitted).

Data usage, deliberately NOT ticked: Health, Financial, Authentication, Location and
Website content. Location looks like it applies because Google's example text names IP
address, but the relay only sees the connection address the way any server does, uses it
solely to cap rooms per address, and logs a one way hash. Website content does not apply
because the extension reads `currentTime` and `paused`, which is playback state, not
content. Whatever is ticked must keep matching `/privacy`, because the two are compared.

**The permission justification fields are generated from whichever package is uploaded.**
Until 1.2.1 is in, the form is still asking about 1.0.1, which had `activeTab` and
required `<all_urls>`. Upload the package BEFORE writing the justifications, or you will
write one for a permission the new version does not use. After upload: `activeTab`
disappears, `scripting` appears, and the host permission question becomes about six named
video sites instead of every site on the web.

The yellow "may require an in-depth review" banner is triggered by `<all_urls>` appearing
anywhere in the manifest, optional included. It means slower review, not rejection.

## Appearance: two looks, one attribute (added 2026-08-23)

The default look is near-black surfaces, hairline edges and light from above. That is a
deliberate house style, and it is not what somebody who lives in Chrome on Windows
expects, so there is a second one. Settings, Appearance: "Depth" and "Material".

`UI_STYLES` in `config.js` is the source of truth, including the labels; the popup builds
its `<option>` list from it. The chosen value is stored under `uiStyle` in
`chrome.storage.local` and applied as a `data-ui` attribute, which the stylesheets key
off. The popup and the in-page panel both read the same key, so changing it in one place
updates the other immediately.

Two rules to preserve if you touch this:

**It is a token swap, never a branch.** No code anywhere asks which look is active and no
element exists in one and not the other. A look with its own code path drifts from the
other the moment either side changes.

**The attribute goes on the panel and the launcher THEMSELVES, not a shared ancestor.**
Going fullscreen reparents the panel into the fullscreen element. An attribute set on an
ancestor is left behind by that move, and the panel silently reverts to the other look
part way through a film.

## The marketing site, and its demo

`site/` is plain HTML, CSS and one module. No framework and no build step, deliberately:
it is one document, and a framework would cost more than it returns.

**Deploying it is NOT a git push.** The Vercel project is linked but its Git integration
does not fire for this directory, so a push builds nothing and the change looks lost. It
deploys with `vercel deploy --prod --yes` run from inside `site/`. This cost half an hour
once; do not rediscover it.

`scripts/check-site.mjs` (`npm run check:site`) serves the site under the REAL
`vercel.json` headers and drives a browser against it. It exists because an earlier CSP
on this site blocked its own stylesheet and script: every request returned 200, the page
looked served, and the only symptom was that nothing moved. A check that fetches HTML
cannot see that. It fails on a blocked asset, a missing embed, or the clock advancing
during a shared advert.

The hero runs **two real YouTube embeds** driven by one room clock, so the ad freeze and
the wait-for-slow behaviour are demonstrated rather than asserted. They are driven over
the frame's own message channel rather than by loading YouTube's API script, which would
mean widening `script-src` for a page that otherwise runs nothing but its own code.

Two things about that which took a real browser to find, and which will bite again if
undone:

**The `listening` handshake must be posted on `onReady`, not only on the iframe's
`load`.** Load fires when the document arrives, not when the widget is listening, so a
message sent then is discarded and never retried. The symptom is subtle and misleading:
the video plays perfectly while the page believes it never started, and the page's own
fallback hides a working player. Commands are applied on `onReady` for the same reason.

**The fallback waits on ENGAGEMENT, not on playback, and it is reversible.** An earlier
version gave up after six and a half seconds if no player had reached "playing" and
marked both players failed permanently, so nothing could bring them back. Buffering
already proves the command landed. Two streams starting at once on one connection can sit
in that state for a while.

## Where the artwork comes from

Nothing is drawn by hand and nothing is drawn in code. Two source files, three scripts:

```
assets/logo-source.jpg    -> scripts/make-master.py  -> assets/logo-master.png
assets/logo-master.png    -> scripts/make-icons.py   -> every icon size, favicon, site copies
assets/banner-source.jpg  -> scripts/make-promo.py   -> promo tiles, social card, posters
```

An earlier `make-icons.py` DREW the icon from a hardcoded gradient, which meant the
artwork lived in a Python file and re-running it would silently reinstate a design that
had been deliberately replaced. Deriving from a master image makes a logo change a
one-file change.

Two size rules that look like mistakes and are not:

**16 and 32 use a tighter crop of the same artwork than 48 and up.** At those sizes the
ring around the play mark falls below one pixel of stroke and dissolves into noise,
taking the triangle's edge with it, so the toolbar showed a coloured smudge. Shipping
different artwork per size is what Apple and Google both do.

**The 128 is not full bleed.** It carries 16px of transparent padding around 96px of art,
because the store draws its own container behind it and full bleed artwork collides with
that container's corners.

`~/Desktop/Watch Together store assets/` holds everything at final size, numbered in
upload order, with a text file saying which field each file belongs in.

## watch@arnavgoel.dev

Support email, forwarded to the owner's Gmail. Set up on Vercel DNS with Forward Email's
free tier, which is configured entirely in DNS with no account: two MX records at the
apex plus a TXT record carrying the rule.

The TXT value is **encrypted** (via Forward Email's `/v1/encrypt` endpoint) so the
destination address is not sitting in public DNS for scrapers. If the forwarding ever
needs changing, re-encrypt the new rule rather than pasting a plaintext one.

There were no MX records on the apex before this, so nothing was displaced.

## Open, in rough priority order

The ordered plan, with what each item is blocked on, is `docs/ROADMAP.md`. What follows
is the same set of facts as reference.

0. **Upload 1.2.1 over the pending 1.2.0 submission.** The zip is built and verified and
   sits in `~/Desktop/Watch Together store assets/0 - Upload this package first/`. Upload
   it BEFORE touching the Privacy tab, because those fields are generated from whichever
   package is currently uploaded.
1. **Manual smoke on real streaming sites.** Everything automated runs against a bare
   `<video>` element. Real YouTube, Netflix and JioHotstar players, their ad breaks and
   their DRM are not covered by any test and never have been. The ad-break logic is
   correct by construction on the server side and covered by tests, but whether the
   client correctly RECOGNISES an ad on each real player is still unverified. This is the
   single largest untested surface in the product.
2. **The site demo does not reach playback in at least one real browser profile.** The
   players engage and then hold at buffering without ever reaching playing, consistently,
   over 16 second windows. The embed handshake is healthy, so the page is driving them
   correctly. A YouTube embed stuck buffering with a healthy handshake is most often a
   content blocker cutting off the media requests, and that profile has several
   extensions loaded. The iframe is cross origin so its internal network is not
   observable from the parent, and this could not be confirmed from here.

   **The test that settles it: open the site in an Incognito window, where extensions are
   off, and press Play the demo.** If it plays, it is a local blocker and the site is fine
   for visitors. If it also sticks, something real is wrong.

   If it turns out a meaningful share of visitors cannot play it, the demo is worse than
   the abstract version it replaced, which depended on nothing. That is a product call,
   not a bug fix.
3. **One manual pass on the per-site permission prompt.** Chrome's own permission dialog
   cannot be automated, so the "Enable on this site" flow has never been exercised
   end to end by anything but a human.
4. **Mismatched sources.** Two people on different rips or regions of the same film have
   timelines offset by seconds or minutes. There is a per-viewer offset and a divergence
   prompt, but no way to say "I am 12 seconds ahead, lock it in" and have it persist.
5. **Personalised server-side ad insertion (SSAI) is unsolved and probably unsolvable
   here.** The ad is stitched into the stream itself: duration is unchanged, there is no
   DOM marker, and nothing local distinguishes it from the film. Mitigated rather than
   solved, by the timeline-divergence prompt and the per-viewer offset. Do not spend days
   on a heuristic for this.
6. **Voice is off, not deleted.** `VOICE_ENABLED = false` in `overlay.js`, WebRTC mesh
   intact behind it, deliberately, per the owner. A mic permission is what got an earlier
   version rejected. A test pins the exact line by which the overlay reads that flag from
   `window.__wtConfig`, so the flag can never be copied into a local that drifts. If you
   refactor that line into an alias, the test fails on purpose. Leave it inline.
7. **Firefox has never been submitted.** The build exists and is packaged every release.
8. **`render.yaml` has never actually been applied**, see the section above.
