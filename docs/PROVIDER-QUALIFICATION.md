# Provider qualification

This is evidence about real provider playback, separate from the controlled video fixture.
A passing fixture test proves extension behavior under those controlled conditions. It does
not qualify Netflix DRM, personalized advertisements, provider login, or a sleeping device.

## Recorded state, 2026-09-13

The local YouTube qualification attempt stopped at Chrome launch. The emitted report records
`outcome: blocked`, `stage: browser-launch`, `reason: browser-launch-rejected`, with zero
participants and every playback case `not-run`. No YouTube page or decoded media was observed
in that run. Syntax and ESLint checks passed for the harness.

The hosted run must supply its own JSON artifact before any provider case below is called
passed. The implementation's test results and the local launch failure are not substitutes.

## Running the public YouTube baseline

From the repository root, after installing `server/` dependencies and Puppeteer's Chrome:

```sh
WT_PROVIDER_REPORT=/tmp/watch-together-provider.json node server/provider.test.mjs
```

CI uses the same command with its own artifact path. `WT_PROVIDER_REQUIRE_PASS=1` makes an
unavailable baseline exit nonzero. Without it, an external blocker produces a JSON report and
exit zero so that bot challenges or unavailable browsers do not masquerade as unit regressions.
A failed assertion after verified content playback exits nonzero. Always read the report's
`outcome` and individual cases; process exit zero is not qualification evidence.

The harness uses two fresh Chrome profiles, the shipped extension, a public YouTube sample,
and a child-owned local Node relay on an ephemeral port. IPC from that child establishes
readiness. Each extension's selected local relay is checked before room creation. No account
credentials, existing personal browser profiles, paid services, or public relay rooms are used.
Provider cookie dialogs are handled only by choosing an available English `Reject all` button.
The harness does not solve bot challenges or sign in.

Before synchronization checks, both pages must show advancing video time and an increasing
count of decoded video frames with real media data available. The DOM report records player
availability, ready/network state, media errors, duration, time, decoded frames, extension
attachment, and recognized login, bot, consent, player-error and advertisement conditions.
An advertisement is not accepted as proof that the requested content played.

After those prerequisites, the baseline checks two-member room creation/join, both directions
of the play/pause transition, seeking within two seconds, and explicit relay reconnect followed
by playback control. Reconnect requires a new server acknowledgement and member identity,
not the background's cached membership. The reconnect test closes/reopens the extension's
relay socket through its settings action; it does not simulate operating-system sleep.

Every operation is bounded at 15 seconds or less. Launches have an abort signal, teardown is
bounded, and a hard 115-second watchdog terminates browsers and the relay. Reports contain
allowlisted versions, case names, statuses and measured numbers. They exclude URLs, room codes,
member names, chat, IP addresses and credentials. A completed baseline reports `outcome: partial`
and `baselinePassed: true`, because the broader matrix still requires qualification.

## Real-provider matrix

| Scenario | YouTube | Netflix | JioHotstar | Required evidence |
| --- | --- | --- | --- | --- |
| Content loads and advances | Local run blocked at browser launch; hosted report pending | Account/device run pending | Account/device run pending | Real media time and decoded frames advance on both participants |
| Join and play/pause | Hosted baseline pending | Pending | Pending | Two devices/profiles join one authoritative room; transitions reach the other player |
| Seek and measured drift | Hosted baseline pending | Pending | Pending | Observed final positions, timestamps and drift after a real seek |
| Relay socket reconnect | Hosted baseline pending | Pending | Pending | New membership acknowledgement and successful control after reconnect |
| Provider buffering | Pending | Pending | Pending | Actual stalled provider media, correct presence, recovery without stale seek/pause |
| Advertisement entry/exit | Pending | Pending where plan includes ads | Pending where plan includes ads | Different ad lengths on two participants, held room clock, resync after both finish |
| Next video or episode | Pending | Pending | Pending | Provider-driven navigation/player replacement; URL permission and playback recovered |
| Login during invitation | Pending | Pending | Pending | Invite received before login, same tab returns to destination, explicit consent joins correct room |
| Laptop sleep and wake | Pending | Pending | Pending | Actual OS sleep, stale socket retirement, preserved room authority and playback recovery |
| Cross-device and network | Pending | Pending | Pending | Two real devices on distinct networks, recorded versions and drift |
| Firefox provider playback | Pending | Pending | Pending | Real Firefox provider session, separate from its controlled extension fixture |
| Safari provider playback | Pending | Pending | Pending | Enabled Safari extension, granted site permission, actual playback and synchronization |

Netflix and JioHotstar require an authorized signed-in account and devices capable of their
DRM playback. No paid plan is provisioned by this harness. Safari requires an actual enabled
extension and website grants. Those cases remain pending until the necessary sessions and
hardware are available. Synthetic ad, remount, network, and sleep events remain controlled
tests and must not be entered here as real provider evidence.

## Recording a manual result

For each real session, record date, extension/browser/OS versions, provider and plan's ad
capability, device count, scenario, observed outcome and measured drift. Store no credentials,
private playback URL, room code, participant identity, or chat. Record a concrete blocker when
access, geography, provider anti-automation, DRM, or device permissions prevent the scenario.
A blocked case is neither passed nor an extension defect until the failure is reproduced with
its prerequisites available.
