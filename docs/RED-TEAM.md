# Watch Together red-team audit

2026-09-13. Scope: Chrome and Firefox extension, Safari packaging, both relays,
protocol, player adapters, popup/overlay, permissions, privacy, dependencies,
release gates and production evidence. This is an audit with repairs, not a
claim that every streaming provider or browser combination is qualified.

## Work queue

- Complete: relay, protocol, persistence and resource-limit source review.
- Complete: extension permissions, message routing, reconnect and invite review.
- Complete: playback, adapter and overlay review with runtime regression tests.
- Complete: dependency, privacy and package review.
- Complete: local static gates, server suites, worker unit tests and packaging.
- Complete: hosted browser verification (nine tests), real Worker smoke, pushed repair
  and Cloudflare deployment.
- Complete: final screenshot review; GitHub delivery is PR 1.
- Open: Render deployment identity, its CLI authentication has expired.
- Complete: STATE, Atlas owner briefing and audit status records updated.
- Complete: policy/listing copy approved on 2026-09-13 and applied to source.
- Complete: approved policy published and live text/render verified on 2026-09-13.
- Open: live store-state verification and dashboard listing updates.
- Open: real streaming/DRM, Firefox and Safari qualification, residual risks below.

## Confirmed defects and repairs

| Priority | Failure | Repair and evidence |
| --- | --- | --- |
| P1 | Every adapter bypassed the shared playback policy. Live DVR streams were seeked, rate changes moved position, small drift hard-seeked, autoplay refusal was silent. | Adapters select players; `content.js` alone applies playback policy. Runtime tests execute all four shipped adapters. |
| P1 | Pauses/seeks sent local time without removing the viewer's offset. | Outgoing actions and heartbeats now use the room timeline. Seek targets are bounded to the local media. |
| P1 | Both backgrounds discarded the minute keepalive. | Party-tab ping forwarding is tested against both actual background scripts. |
| P1 | A private relay failure silently replayed room information to public infrastructure. | Explicit overrides remain exclusive until cleared. Redirect advice cannot override that choice. |
| P1 | Host-page JavaScript could programmatically accept an invite or activate overlay controls. | Trusted-event checks cover consent and overlay actions. This does not eliminate clickjacking of shared DOM. |
| P1 | Invalid percent encoding in an invite path threw from Node's HTTP request handler. | Shared safe decoding returns invalid-code handling; HTTP regression verifies health afterward. |
| P1 | Lookup rate limits answered successful guesses even after refusing misses. | Both HTTP paths and WebSocket joins enforce budgets regardless of room existence. |
| P1 | Concurrent Worker joins could overfill a room while token validation yielded. | Capacity is rechecked after asynchronous work and before membership publication. |
| P1 | Worker's live-room budget reset after hibernation. | The per-address census is rebuilt from persisted owners; a wake regression verifies it. Rebuild also rechecks global capacity after crypto yields. |
| P1 | Locked runtime `ws` had published memory exhaustion/disclosure advisories. | Patched compatible version installed; all three package audits report zero advisories. |
| P2 | Firefox lacked optional-site injection, dropped presence/call updates and retained stale socket callbacks. | MV2 registration/injection, message parity and stale-socket guards have runtime regressions. |
| P2 | Mode/host/leader changes and queued room actions could become stale across lifecycle changes. | Both backgrounds persist authority updates and invalidate deferred room requests when superseded. |
| P2 | A global invite hint could be consumed by an unrelated page. | Destination URL and finite freshness checks precede consumption; hint writers include destination identity. Version 1.3.0 replaces global hints with background-owned tab claims. |
| P2 | Leaving a room left navigation/metadata playback pending; attaching before metadata discarded the queued sync. | Deferred work is cancelled on leave; snapshot-before-apply preserves metadata waits. |
| P2 | A wait-for-slow pause falsely announced buffer recovery. | Remote pause retains buffering until the player reports readiness. |
| P2 | Temporary drift rates leaked into room state; stale player events remained active after navigation. | Heartbeats advertise the canonical rate; player handoff cancels nudges and detaches events. |
| P2 | Volume, duck and picture-in-picture targeted the first video instead of the selected player. | Overlay uses the sync core's selected video. Generic selection excludes decorative videos when a real player exists. |
| P2 | In-page relay Save/Reset controls were silently rejected by the background. | Removed those controls; relay settings remain in the privileged popup. |
| P2 | Store package verifier ignored popup/CSS/action assets. | Verifier now covers these assets and rejects missing files/directories; positive and negative fixtures checked. |

`server/content-runtime.test.mjs` originally had 15 regression cases: all 15
failed against an isolated copy of original HEAD and passed against the repair.
It now has 17 cases, including deferred metadata and wait-for-slow recovery.
The four new Worker regressions also fail against original main (31 pass, four
fail), and all 35 pass after repair.
`server/relay.test.mjs` executes actual background code, not copied algorithms.
Existing copied-algorithm tests remain weaker evidence and were not treated as
proof that browser integration works.

## Open findings and qualification limits

- **P1, privacy disclosure, website corrected:** the owner-approved Cloudflare
  storage and retention disclosure is live and verified on 2026-09-13. The
  repository listing and certification text are corrected; store dashboards
  still need the next submission. [Release audit](RED-TEAM-RELEASE.md) retains
  the exact approved text. Provider logging retention remains unverified.
- **P2, room trust:** default rooms deliberately let any member navigate everyone
  to any HTTP(S) page. Named rooms can be guessable; room codes are bearer
  credentials, not user authentication. Rate limits are per address and Worker
  limiter counters are memory-resident. Distributed guessing and hibernation
  reset of short rate windows are not eliminated.
- **Host reuse fixed in 1.3.0:** new signed tokens include a random room-instance
  nonce, so reusing a room name cannot recreate the previous host authority.
  Legacy tokens are accepted only for legacy rooms or authorized reconstruction.
  Host tokens remain bearer credentials without an account-level revocation service.
- **P2, permission boundary:** trusted-click checks block programmatic events;
  shared host DOM can still be overlaid, moved or visually tampered with. An
  isolated browser-owned consent surface is stronger. Version 1.3.0 resolves
  same-URL invite races through tab-bound claims. Startup tab identity/hydration races remain
  unqualified. See [extension review](RED-TEAM-EXTENSION.md).
- **P2, availability:** version 1.3.0 pins existing rooms to their relay and bounds
  socket establishment at ten seconds. Relays still have independent room stores.
  Single-hub Durable Object throughput/geography and cost under hostile traffic
  were not load-tested against production.
- **P2, real providers:** bare-video tests cannot establish Netflix/JioHotstar
  DRM, changing ad markers, live DVR policy, embedded cross-origin players,
  autoplay prompts on real sites, or personalized server-side ads. Browser
  optional-permission dialogs still need real-browser qualification. Synthetic
  Netflix/JioHotstar button retries were removed with duplicated adapter policy;
  actual provider playback is a required follow-up, not a proven compatibility
  claim. Firefox/Safari need real two-person sessions.
- **P2, localhost permission:** required loopback grants also cover local admin
  applications. The historical claim that they grant access to nobody's data is
  incorrect. A development-only manifest would preserve test access without
  distributing these grants; permission packaging remains a release follow-up.
- **P2, accessibility/UI:** no complete screen-reader, focus-trap, keyboard,
  mobile Safari, zoom or high-contrast qualification was possible locally.
  Caption track listener lifecycle and whole-document mutation observation
  remain performance concerns, not benchmarked failures. Version 1.3.0 adds the
  version/release-time footer, update indicator and tested keyboard/focus repairs.
  Demo Data Mode remains outside this six-workstream reliability release.
- **P2, marketing/site gate:** the site check does not prove actual embedded
  playback and is absent from CI. Site claims exceed verified provider coverage.
  Detailed evidence is in the release audit.
- **P3, cache:** stable-name marketing assets use immutable caching. This was
  corrected in source to revalidate stable filenames; live header verification
  is tracked in the reliability release.

## Verification and production evidence

Both public health endpoints answered `status: ok` on 2026-09-13. This proves
availability only, not which commit is deployed. No production rooms were
joined, enumerated or modified for this audit.

Local `npm test` passed: 202 Node tests, 64 Vitest tests, 35 Worker tests.
Hosted CI runs 34714445272 and 34714686507 passed all five jobs, including nine
browser tests and the real Worker smoke. The latter verifies updated CI actions
and has no project/dependency warning output. Total verified cases: 311. All three
`npm audit` reports were clean after dependency updates. Both v1.2.4 extension
packages build and pass package verification.

Local Chrome launch failed before test execution with `Code: null`, empty
stderr, nine skipped tests. The in-app browser also reported no available
browser. Hosted CI browser tests passed. The final popup and overlay screenshots from
run 34714686507 were visually reviewed after waiting for entrance animations.
They are retained in `docs/evidence/red-team-2026-09-13/`. Controls render
legibly and the room/member/chat layout is intact at the tested desktop size.
This is not a complete accessibility or responsive-layout qualification.
No store publication is inferred from packaging.

Cloudflare deployed from pushed commit `fc3da47`; version
`ba47c113-21a3-41ab-acb8-0077237bbd24` is at 100 percent in the deployment API.
Health is good after deploy; malformed path receives an edge HTTP 400 (the
local runtime receives it and returns 404). Both outcomes refuse the request.


Render CLI reports an expired token. Its public health endpoint is available,
but a fresh deployment identity cannot be confirmed through the CLI. The
Git-connected fallback receives main-branch changes; do not describe its patch
as live without host-side evidence. Extension packages remain unsubmitted.
