# Release, privacy, and dependency audit

Reviewed 2026-09-13 against the local working tree. This is one part of the
project red-team review in `RED-TEAM.md`. Store dashboards and production
deployments were not inspected by this audit stream. The older store versions,
user count, review status, and Safari registration in `STATE.md` are historical
claims, not independently verified current facts.

## Findings

### P1: privacy promises contradict durable room storage, correction approved

`site/privacy.html:33`, `:38`, and `:60` say URLs and IPs are never written to a
database and both relays use memory only. `server-cf/src/worker.js` persists every
room field except members and write-throttle bookkeeping in `_persistRoom`.
Those fields include `videoUrl` and the creator's raw `ownerIp`. Socket
attachments also retain the member name and connection metadata across
hibernation. This is durable storage, backed by the SQLite Durable Object
configured in `server-cf/wrangler.toml`.

Deletion is not immediate on the last departure: shared defaults allow an empty
ordinary room for 30 minutes and an empty named room for seven days. Idle limits
are 12 hours and 30 days respectively. `store-listing.md` also promises that room
data is deleted when everyone leaves and certification notes say nothing is
stored. Those statements need correction before the next submission.

Owner approved the following exact replacement on 2026-09-13. It is applied
to the policy and repository listing; publication evidence is in STATE:

> The Cloudflare relay stores room metadata in Durable Object storage so rooms
> can survive hibernation. This includes the room code, the attached page's URL,
> playback state, room settings, and the creator's IP address for rate limiting.
> Connection metadata includes each connected member's display name and IP
> address. Chat messages are relayed without a chat-history database. The Render
> fallback keeps room state in memory. Empty ordinary rooms are retained for up
> to 30 minutes; empty named rooms for up to seven days. Inactive ordinary rooms
> expire after 12 hours and inactive named rooms after 30 days. Cleanup runs on
> periodic sweeps, so these are retention targets rather than exact deletion
> timestamps.

If the relay changes its storage or retention during remediation, revise this
proposal against the final implementation before publication. Cloud provider
request-log retention has not been verified and is not covered by this proposal.

### P1: vulnerable runtime WebSocket dependency, fixed locally

The server lockfile resolved `ws` 8.20.0. The registry audit identified remote
memory exhaustion from fragmented WebSocket messages
(`GHSA-96hv-2xvq-fx4p`) and uninitialized memory disclosure
(`GHSA-58qx-3vcg-4xpx`). The lockfile now resolves 8.21.3, retaining the compatible
manifest range. Deployment is required for the fallback relay to receive it.

### P2: development dependency advisories, fixed locally

Initial audits reported 13 affected server packages (11 high, two moderate,
including runtime `ws`) and six worker tooling packages (four high, two moderate).
They are package counts, not distinct exploitable product vulnerabilities.

Registry versions were checked before updating. Puppeteer is now 25.10.0,
Wrangler 4.131.1, and the existing Vitest 4 range resolves to patched 4.1.11.
Puppeteer needed a major update to remove its vulnerable archive extraction
chain; Wrangler needed a major update to remove its vulnerable toolchain.
Compatible transitive dependencies were refreshed. All three package audit
reports now contain zero advisories. This does not prove that dependencies have
no undisclosed vulnerabilities.

Puppeteer 25 requires Node 22.12 or newer; CI's Node 22 setup resolves a current
minor. Production installs omit these development dependencies. The worker now
declares its existing ES module format explicitly. The Vitest config uses `.mjs`
so its ES module syntax does not cause a new Vite warning.

### P2: release package verifier missed popup and CSS, fixed locally

`scripts/package.mjs` previously checked content JavaScript, background scripts,
and top-level icons, while overlooking manifest CSS and the toolbar popup.
A missing popup could pass its claim that every manifest asset was present.
It now also checks action popups/icons, content CSS, background pages, options
pages, devtools pages, and overridden browser pages, and refuses directories
where a referenced file is required.

Validation used an isolated copy, with no changes to extension sources: a valid
package passed; a missing popup, missing CSS, missing Firefox action icon, and
popup path resolving to a directory each failed as intended. This checks direct
manifest references, not a complete HTML/CSS dependency graph.

### P2: site verification does not prove video playback, open

`scripts/check-site.mjs` checks iframe creation and source origins, then reads
the demo's own clock. It does not establish that either iframe loaded a player,
decoded video, advanced its real playback time, or followed a seek. Third-party
request failures are excluded, and the check can finish before the 11-second
fallback. The calculated `applied.scripted` result is unused. The success text
therefore overstates its evidence when it says both embeds load.

The site check is absent from CI. Its coverage also omits the support/privacy
pages, mobile layout, keyboard operation, and reduced-motion behavior. The
existing site CSP is restrictive and the message listener checks both embed
origin and source; no bypass was established in this audit.

### P2: compatibility and privacy marketing overstate evidence, open

`site/index.html:128` and `:136` say only the playhead crosses the network,
contradicting both the protocol and the adjacent URL disclosure. The existing
accurate policy list of playhead, URL, names, presence, chat, room codes, and IP
processing should replace the claim when public copy is approved.

`store-listing.md` promises any HTML5 video site, exact synchronization, and
live events. The browser suite uses bare local video, while the project's
handover explicitly says real streaming players, DRM, permission prompts, and
server-side personalized ads have not been verified. Firefox and Safari lack
an automated real-browser suite; Safari has not completed a two-person sync
test. These are release qualification gaps, not proof every named site fails.

### P2: worker integration command was a false green, fixed locally

`server-cf/package.json` names a script `test:integration` but it only prints
manual instructions and exits successfully. Worker tests use fake storage and
sockets, so they cannot establish actual runtime upgrade, hibernation, alarm,
or deployment behavior. It should run a real integration check or fail clearly
instead of reporting a successful test without assertions.

Now replaced by `integration.test.mjs`, which launches actual local Wrangler/workerd
with temporary storage and bounded cleanup. It passed in 1.17 seconds: health,
malformed invite 404, two WebSocket upgrades, room creation/join, host-token shape
and playback propagation. A full hibernation cycle still needs qualification.

### P3: immutable caching uses mutable filenames, open

`site/vercel.json` gives `/assets/*` a one-year immutable cache lifetime, but
assets such as `logo-256.png` and `og-card.png` have stable filenames. Replacing
their contents cannot reliably update returning visitors until cache expiry.
Use content-versioned asset paths or a cache policy that revalidates them.

## Verification and handoff

- Root audit: zero advisories, no dependency changes needed.
- Server audit after updates: zero advisories.
- Worker audit after updates: zero advisories.
- Node server/protocol suites: 176 passed during this stream's initial run.
- Vitest server suite: 64 passed. Config warning fixed by renaming to `.mjs`.
- Worker suite: 35 passed after concurrent relay fixes, with no module-format
  warning; Wrangler 4.131.1 starts and reports its version.
- Package verifier: valid fixture plus four negative fixtures passed.
- The new `content-runtime.test.mjs` suite is included in all server scripts
  that enumerate the full Node test suite; its owner verifies its assertions.
- Browser run did not reach tests: Chrome exited during launch with `Code:
  null`, empty stderr, and nine tests skipped. No browser pass is claimed.
  Hosted CI runs 34714445272 and 34714686507 subsequently passed all nine
  browser tests. Root visually reviewed the final retained screenshots.

Outstanding: public privacy/listing correction, Render dependency rollout
verification, real provider/Firefox/Safari and actual hibernation qualification,
the site gate gaps, cache policy and live store-state verification. Cloudflare
repair is deployed; root report carries its version identity.
