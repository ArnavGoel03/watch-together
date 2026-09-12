# Extension transport and trust audit

Date: 2026-09-13. Scope: both background scripts, relay selection, shared URL validation,
manifests, invite extraction, and the invite/overlay trust boundary. This records source
and executable regression evidence, not a claim about the version currently installed
from any browser store.

## Confirmed and fixed in the working tree

| Severity | Finding and reproduction | Correction |
| --- | --- | --- |
| High | Both backgrounds discarded the content script's `ping`. A paused party's documented keepalive never reached the relay. A VM driving the real background received `create-room` as the last outbound message after sending `ping`. | Route `ping` from the bound party tab; reject bystander pings. |
| High | A configured private relay silently failed over to the public relay list after two failures, replaying room identity, video URL and host credential outside the chosen service. | An explicit override is exclusive until cleared; server migration cannot replace it. Public defaults retain failover. |
| High | The invite confirmation accepted `button.click()` from the host page, bypassing the intended human decision. Overlay join/create controls had the same synthetic-event boundary. | Require trusted primary action clicks; reject synthetic click/change/input/key events at the overlay and its controls, including controls moved out of the panel. |
| Medium | Every permitted tab could consume the global pending invite and inherit a previously consented join without checking its destination. | Store destination URLs for retries and redirects; only the matching URL consumes the hint. Validate finite, recent timestamps and recheck the destination at approval. |
| Medium | A join queued during disconnection still executed after Leave. Both production background scripts reproduced this. | Generation checks retire queued create/join callbacks and late asynchronous rejoin work after a newer request or Leave. |
| Medium | Changing a room to host control, transferring host, or changing heartbeat leadership updated memory without persisting the change. Reloads restored stale authority or rebuilt the old mode. | Persist authority changes; Firefox now also stores and restores heartbeat leadership. |
| Medium | Retired Firefox sockets could still deliver open/message events and replace the current room after changing relays. | Apply socket identity guards to open/message as well as close; connection failure accounting is local to each socket. |
| Medium | Firefox silently dropped inbound presence and pinned call updates. Clearing its relay override was rejected. | Restore routing parity and accept empty override as reset. |
| Medium | Firefox exposed optional site permission but had no registration or immediate injection implementation. | Register granted origins through the MV2 content-scripts API, serialize updates, inject configured scripts in order, and return the existing result message. |
| Medium | Malformed `wss://` values passed regex validation but threw in WebSocket construction, leaving repeated attempts against an unusable URL. | Parse URLs and reject invalid hosts/ports, fragments and embedded credentials. |
| Medium | Overlay connection Save/Reset reported success while the background refused those messages because only the popup may set the relay. | Remove the dead controls and their wiring. Relay settings stay on the extension-owned popup. |
| Low | JSON `null` from a relay and non-string room codes threw in background message handlers. | Reject non-object packets and validate room codes before normalization. |
| Low | Invite extraction replaced the site's history state with an empty object. | Preserve the existing history state while removing the invite parameter. |

## Verification

- `node --test server/relay.test.mjs`: 48 passed. The suite now executes the shipped
  background scripts against controlled WebSocket, port and storage boundaries, plus
  the actual invite and consent functions. Seven initial transport/Firefox assertions
  and two queued-join cancellation assertions failed before their corresponding fixes.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- Firefox optional permission behavior is verified at the API boundary with mocks;
  an actual Firefox permission prompt, background suspension and subsequent navigation
  still need browser verification.
- Real-browser and rendered UI verification are owned by the parent audit. Synthetic
  test clicks on guarded controls must be replaced with browser-generated clicks.

## Residual risks and coverage limits

- **Shared page DOM is not an isolated permission surface.** Trusted-event checks stop
  programmatic clicks, but the page can still alter labels/styles or trick a person into
  a real click. Room acceptance on an extension-owned surface is the stronger boundary.
- **Invite hints are URL-bound, not tab-bound.** Two tabs on the exact same normalized
  destination may race for one global hint. A background-owned tab claim would remove
  this remaining ambiguity.
- **Browser startup restores a numeric tab ID.** The existing startup check verifies
  that the tab exists, not that a recycled ID still identifies the original video tab.
  Storage hydration and startup event ordering are not covered by the synchronous VM.
- **WebSocket connection establishment has no explicit deadline.** A socket stuck in
  CONNECTING depends on the browser's network timeout before relay failover progresses.
- **Default relays are independent room stores.** Public fallback can create a second
  copy of a room during a partial outage. This audit does not add cross-relay replication
  or a globally authoritative room directory.
- **Remote HTTP(S) navigation remains intentional room capability.** Scheme validation
  blocks script/data/file URLs, but ordinary web pages, including local HTTP endpoints,
  remain reachable by room peers. The code cannot infer whether every target is a video.
- Required permissions remain limited to listed video sites and loopback; broader
  origins remain optional. Loopback access covers local web applications as well as the
  test harness. There are no external-message listeners or web-accessible extension
  resources in either manifest, and relay-setting messages remain popup-only.
- Host tokens remain in extension-local storage and travel to the relay; this is not an
  end-to-end encrypted design. No live third-party room or user data was probed.
