# Watch Together

A browser extension that keeps video playback in sync between people watching the same
thing in different browsers, plus the relay it talks to and the site that sells it.

**Read `docs/STATE.md` before doing anything else.** It carries the current version, the
store submission state, every architectural decision and the reasoning behind it. Do not
re-derive status from the source or the git log; do not duplicate STATE.md into here.

## This has real users

37 people are on the live store version. That number is the whole reason for the care in
this repo. A bug shipped here is a bug in somebody's film night, and a store release takes
days to review, so it cannot be quietly fixed afterwards. Verify before claiming done.

## Commands

```
npm test                 lint, typecheck, dash check, version metadata, server + worker tests
npm run test:browser     loads the extension in two real Chrome profiles. NOT in npm test
npm run check:site       serves the site under its real CSP and drives a browser at it
npm run package          builds and verifies both zips into dist/
npm run safari:build     the macOS Safari app, ad-hoc signed, into safari/build
npm run safari:register  tells macOS the built extension exists, without stealing focus
python3 scripts/make-master.py    crops the icon out of the delivered artwork
python3 scripts/make-icons.py     every icon size, from that one master
python3 scripts/make-promo.py     store tiles, social card, posters, from the banner sheet
```

`npm test` does not include the browser suite. Run it by hand after any change to the
popup or the overlay: it is the only thing that loads the extension for real.

## Deploying

**Extension:** `npm run package`, then upload `dist/watch-together-chrome-vX.Y.Z.zip` by
hand. It must be published from `yashgoel0304@gmail.com` or the existing users are
stranded on 1.0.1 forever.

**Relay:** Cloudflare is primary, Render is a live fallback. Pushing the server ships it
immediately, which is the asymmetry to exploit: the server is redeployable in seconds and
the extension takes days of review, so **prefer a server-side fix wherever one exists**.

**Site:** `cd site && vercel deploy --prod --yes`. A git push does NOT deploy it. The
Vercel project is linked but its Git integration does not fire for this directory, so a
push builds nothing and the change looks lost.

**Safari:** not deployable. It needs the Apple Developer Program at ninety nine dollars a
year, which is unbought, and it has never been run inside Safari by anybody. Read
`docs/SAFARI.md` before touching `safari/`: it is a handoff document covering the local
run, the test that actually decides whether it works, enrolment, signing and submission.

## Invariants, each of which cost something to learn

**One source of truth, always `config.js`.** Server URLs, protocol version, injected file
list, call hosts, appearance styles, every validator. The server URL alone used to be
written out in four places. If a value appears in two files, that is a bug.

**One extension directory feeds three browsers.** `safari/` is an Xcode project whose every
path REFERENCES `extension/` relatively rather than copying it, exactly as the two manifests
share one source tree. If you ever find yourself copying files into `safari/`, stop: that is
a second source of truth and this repo's first invariant is that there is never one.

**Never duplicate logic between the two background twins.** `background.js` and
`background-firefox.js` diverging is where a whole class of bug came from. Shared logic
goes in `relay.js` or `config.js`.

**The overlay reads `VOICE_ENABLED` from `window.__wtConfig` on one exact line, and a test
pins that line.** It exists so the flag can never be copied into a local that drifts. If
you tidy it into an alias the test fails on purpose. Leave it inline.

**Appearance is a token swap on a `data-ui` attribute, never a branch.** No code asks
which look is active; no element exists in one look and not the other. The attribute goes
on the panel and launcher themselves, never a shared ancestor, because fullscreen
reparents the panel and an ancestor's attribute is left behind mid-film.

**A room's position is `(currentTime, lastUpdate)`, read by extrapolating forward.** That
is why the ad freeze exists: with nobody watching, the clock must HOLD, or an advert that
catches everyone convinces the room that time passed and throws them all forward when it
ends. Understand this before touching anything in `server.js` that touches time.

**Artwork is derived, never drawn.** Two source files, three scripts, listed above. An
earlier `make-icons.py` drew the icon in code, which meant re-running it would silently
reinstate a design that had been replaced.

## Traps

**Chrome for Testing cannot play YouTube.** It returns Error 153 regardless of the page.
This is not evidence that anything is broken. To check anything involving real YouTube
playback, drive the user's actual Chrome; that environment has the codecs.

**Stable Chrome silently ignores `--load-extension`.** Extension tests need Chrome for
Testing. Two participants need two separate PROFILES, not two tabs: a second tab in the
same browser joins over the same socket and is not a second person.

**Headless never fires `fullscreenchange`** and hangs when screenshotting a playing video.

**Safari builds and registers, and has never been RUN.** Building is not running, and
registering is not running. The one API expected to differ is `chrome.permissions.request()`
behind "Enable on this site", because Safari manages site access through its own UI. Do not
describe Safari as working until a human has synced a room with it.

**Regenerating the Safari project silently reintroduces two defects.** The converter drags
`manifest.firefox.json` and `background-firefox.js` into the Apple binary, and seeds
`MARKETING_VERSION` at 1.0 in all eight build configurations. `check-version.mjs` catches
the second; nothing catches the first. `docs/SAFARI.md` has the recipe.

**A page can return 200 for everything and still be dead.** An earlier CSP on the site
blocked its own stylesheet and script. Everything served, nothing moved. Any check that
only fetches HTML would have passed it. This is why `check-site.mjs` drives a browser.

**The store's permission justification fields are generated from whichever package is
currently uploaded.** Upload the new zip before writing them.

**The gate's three refusals are contracts, not noise.** `typecheck` refuses new
`config.js` members until they are declared on `WatchTogetherConfig` in
`types/globals.d.ts`. `check-version.mjs` refuses a version bump without a CHANGELOG
entry, and reads `MARKETING_VERSION` out of the Safari pbxproj so the app cannot ship a
version that contradicts the extension inside it. `check-dashes.mjs` refuses em and en
dashes anywhere. Satisfy them; do not weaken them.

## Style

No em or en dashes, anywhere, enforced by the gate. Comments explain WHY, especially the
non-obvious constraint that forced the shape of the code; a comment restating what the
line does is noise. Match the density and voice already in the file.
