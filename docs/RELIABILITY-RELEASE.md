# Reliability release, 2026-09-13

User requested all six proposed improvements. This is the persistent work queue.

| Workstream | Status | Acceptance |
| --- | --- | --- |
| Real provider qualification | In progress | Real YouTube attempt prepared; signed-in Netflix/JioHotstar access requested. Firefox hosted harness added; real Safari playback unavailable. |
| Invitations and first join | Implemented, browser verification pending | Correct video and relay, revocable credentials, tab binding through login, optional-site extraction. Legacy global consent removed. |
| Recovery | Implemented, integration pending | 10s socket open, 25s waiting actions, 15s membership acknowledgement; cancellation, stable room relay, private override isolation. |
| Host controls | Implemented, local verification passed | Independent navigation permission, lock, removal and invite revocation on both relays. Lost-room recovery requires host and fresh invitations. |
| Private diagnostics | Implemented, browser verification pending | Latency and drift, 100 local events, allowlisted export without URLs, IPs, chat, room codes, names or tokens. |
| Accessibility and polish | Implemented, browser verification pending | Focus return and Tab exit, volume through player remount, version/release/update metadata. |
| Release verification and shipping | Pending | Gates, rendered browser evidence, packages, pushed code, live Worker, STATE and Atlas. Store submissions and Render identity require working account access. |

New UI labels were proposed for approval. Implementation is provisional until that reply:
Lock room; Allow guests to change video; Remove; Revoke invitations; Download diagnostics;
Latency; Drift; Update available. Other UI wording reuses project strings.
The earlier storage and retention correction is already approved and live.

## Verification log

- Full local `npm test` passes: lint, all six typecheck contexts, dash/version gates,
  252 Node tests, 64 Vitest tests and 46 Worker tests (362 tests).
- Real local workerd: room creation, two-member playback, health and malformed invite checks pass.
- Both store packages build and verify manifest contents; store submission is still separate.
- Local Chrome cannot launch in this sandbox. The browser suite fails in setup; its skipped tests
  are not passing evidence. Hosted Chrome CI must run all cases and supply rendered screenshots.
- Firefox stable installation cannot mount its DMG here (`hdiutil: Device not configured`).
  The Firefox harness fails explicitly with zero skips; hosted Linux CI must supply execution evidence.
- Safari macOS arm64 Debug app builds, but Xcode logs App Intents extraction warnings and unavailable
  CoreSimulator service errors. This is build evidence only, not a warning-free release or real Safari
  popup/playback qualification. iOS was not rebuilt in this release session.
- An intermediate Node gate ran during reconstruction hardening and failed seven old permissive
  reconstruction expectations. Final fixtures now verify fail-closed recovery and the full gate passes.

## Compatibility and bounds

Access settings preserve legacy behavior until explicitly changed. A new navigation setting then
controls guest navigation independently of playback. Locking admits valid existing member or host
credentials; removing a guest invalidates their remembered credential and rotates invitations.
Invitation revocation requires the new token on fresh joins. Older clients cannot use the new
protected invitation or guest rejoin protocol until updated.

Cloudflare persists access settings with the room. Node room state is still in memory. Recovery
after actual room loss requires the original host token and fresh invitations, preventing old
guest credentials or revoked links from reopening an unrestricted room. A remembered member
credential can expire after 500 distinct members; active credentials are retained.

New host tokens bind to a random room instance. A later room reusing a name cannot mint the
original host's authority. Existing saved invitations and host credentials reject a replacement
room instead of silently joining it. Legacy code-only clients can still deliberately join a later
public room with the same name; names do not have permanent ownership in the in-memory relay.

Pending invitations are local, bound to a tab and exact destination, capped at 32 entries, and
expire after 30 minutes. Provider login may leave and return to that destination without losing
the invitation. A private relay setting cannot be replaced by an invitation link.
