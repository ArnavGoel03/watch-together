# Changelog

All notable changes to Watch Together are documented here.

## [1.2.0] - 2026-08-21

A hardening release. Eight independent adversarial reviews were run against the whole
codebase, and everything real that came out of them is fixed here. Two of those findings
were security issues that a room member could have used against the people watching with
them, and one was the single most-felt bug in the product: the chat panel was invisible in
fullscreen, which is how people actually watch.

Also in this release: the backend can now be moved without a store update, the running
cost per room dropped by more than half, and the whole project is linted, typechecked and
tested in CI for the first time.

### Security

- **A room member could no longer send your tab to a `javascript:` URL.** The navigate
  feature is a remote tab-redirect primitive: anyone in the room can move your browser. The
  URL was only ever checked on the server, and the extension lets you point it at any relay
  you like, so that was never a control the client owned. The client now refuses anything
  that is not an ordinary `http`/`https` page, before it ever reaches `location.href`.
- **An invite link can no longer put you in a stranger's room silently.** The extension
  reads a `?wt_room=` parameter on any page, and used to join the room it named with no
  confirmation, which meant any web page could make its author a peer of yours, with a
  peer's power to move your tab. Links that arrive this way now ask first. Following your
  own party as it moves between sites still needs no confirmation, because you are already
  in that room.
- **Rebuilding a room no longer hands control to whoever asked.** Rooms live in memory, so
  a server restart wipes them and a returning member rebuilds theirs from the code. That
  path also made the rebuilder the host and honoured their choice of control mode, so
  someone who waited for a party to go quiet could rebuild it as host-only and own everyone
  else's playback. Rebuilds now restore host only for a client holding the token the server
  issued to the room's actual creator.
- **The join page no longer puts an unvalidated room code inside inline JavaScript.** HTML
  escaping does not contain a value in that position: an attribute decodes `&#39;` back to
  an apostrophe before its JavaScript is parsed. The code is validated against the shapes
  the server can actually issue, and the page now carries no inline script at all.
- **The `/join/` link is no longer an open redirect.** A `?url=` parameter was honoured when
  a room had no video of its own, so the link could send someone anywhere with our domain
  doing the sending. It redirects only to the room's own video now.
- **`Infinity` can no longer be pushed into a room's position.** The live sync and heartbeat
  paths guarded with `isNaN`, which `Infinity` passes, so any member could set every peer's
  `video.currentTime` to `Infinity`. Both paths now require a finite number, matching the
  guard the rebuild path already had.
- **Relay connections must be `wss://`.** Plaintext `ws://` was accepted in settings, which
  put room codes, chat and the address of everything you watch in the clear.
- **Client IP addresses are no longer written to the server log** in a readable form, and
  the privacy policy now describes what the service actually does with them.

### Fixed

- **The chat panel is visible in fullscreen.** It was appended to the page body, which is
  not painted with the fullscreen element, so going fullscreen made the whole panel vanish
  while the button that opened it kept working. It now follows the video into fullscreen
  and back out.
- **A remote play that the browser blocks now says so.** Browsers refuse playback that the
  viewer did not start themselves, and the rejection was being discarded, so on a tab you
  had not clicked, everyone else started watching and your video just sat there with
  nothing on screen explaining why. You now get a single button that starts it.
- **Your own seek is no longer mistaken for an echo of somebody else's.** Applying a remote
  sync ignores the events it provokes, but the guard cleared after 300ms while the window it
  protected was a second, so any seek slower than that (a large file, a slow connection)
  came back to the room as a brand new action.
- **Rewinding to the start actually works.** A guard meant to catch players remounting at
  zero was keyed to timing rather than to a remount, so pausing and then deliberately
  dragging back to the beginning was silently never sent, and the next heartbeat pulled you
  forward again.
- **Changing playback speed no longer jump-cuts everyone.** A speed change carries no
  position, but was treated as a position update, so any drift the room happened to be
  carrying became a visible seek for every other viewer.
- **Your own speed change is no longer swallowed** when it lands during one of the
  extension's own drift corrections.
- **Reloading your tab no longer costs you your own room.** Every reconnect gets a new
  server-side identity, so the host came back as an ordinary guest and a host-only room fell
  open to everyone. A host now returns as the host, and a host-only room stays locked
  through a reload rather than unlocking the instant its host disconnects.
- **Firefox: "host only" mode and custom room names work.** Both fields were dropped before
  the request left the browser, so the setting did nothing while the interface said
  otherwise.
- **Firefox: voice chat and typing indicators can work at all.** Three message types were
  relayed outbound but dropped inbound, so voice negotiation could never complete.
- **Chat messages and member notices no longer arrive twice.** Changing the server URL left
  the old socket alive, and its late close event wiped the reference to the new one, ending
  with two live connections both relaying the same room.
- **A chat message that could not be sent now says so** instead of appearing to have been
  sent to everyone.
- **A "host only" room survives a service worker restart.** Chrome recycles the extension's
  worker at will; the room's control mode was only in memory, so a rebuilt room came back as
  a free-for-all.
- **The overlay no longer shows "1 watching" for a room of five**, and no longer claims to
  be Live after the connection has dropped, and no longer shows a room you have left.
- **The overlay hotkey no longer triggers the site's own shortcut too.** Holding it on
  YouTube also toggled play/pause underneath the panel.
- **Buttons re-enable when the server answers**, not four seconds later, so an instant
  rejection no longer leaves you clicking a dead button.
- **A chapter click no longer reloads everyone's tab.** Rewriting the URL with a timestamp
  was treated as switching videos.
- **Site adapters match on the actual domain.** `host.includes("netflix")` also matched
  unrelated domains that merely contain the word.
- **A short video after a long one is no longer mistaken for an advert**, which used to
  disable sync silently for up to three minutes.
- **The player swapping in a new video element is now noticed** even when it leaves the old
  one in the page, which Netflix and YouTube both do.
- **A laptop waking from sleep re-syncs its clock** instead of easing towards the truth over
  the following minute.
- **Several leaks fixed**: a caption-watching timer left running for every video watched in
  a session, duplicated metadata listeners causing a visible stutter on load, and an
  unbounded list of system messages in the chat panel.

### Added

- **The backend can be moved without a store update.** The extension can no longer be
  redeployed quickly (store review, then auto-update), so the relay address is now a
  prioritised list rather than one hardcoded value, a relay that will not answer is skipped
  for the next one, and a server can tell every connected client to move to a replacement.
  Standing up a new backend is a configuration change on the running service.
- **A protocol version on every message**, so the server can tell what it is talking to.
  Old versions stay installed for weeks after a release.
- **Per-IP limits on room creation**, and a cap on how many rooms one address can hold open,
  so one connection can no longer fill the server and lock everyone else out.
- **The server survives an unexpected error** instead of the whole process exiting and
  ending every party on it.

### Performance and cost

- **A room costs less than half what it did.** The heartbeat was effectively the entire
  running cost, firing every five seconds per room forever. A paused room now sends nothing,
  a room of one sends nothing, and a room that is demonstrably in sync eases from five
  seconds towards twelve, snapping back immediately on any seek, pause, play or new arrival.
  Roughly 720 messages an hour per room becomes 300 while playing and none while paused.
- **The ad detector no longer runs in every tab you have open.** It was polling ten CSS
  selectors twice a second in every tab, forever, whether or not you were in a party.

### Cloudflare backend

The Cloudflare port had no tests at all, and two of its faults could only ever appear after
the object went to sleep, which is exactly when they mattered.

- **The stale-leader watchdog can now fire.** The heartbeat clock was reset on every wake, so
  a frozen leader (which keeps the room quiet, which lets it sleep) was never demoted.
- **Empty rooms are cleaned up.** A room mid-deletion when the object slept woke with no
  timer and nothing to set one, and stayed forever. There is now a sweep that survives sleep,
  and the room expiry that was written but never wired up now runs.
- **Members whose connection died without closing are removed**, rather than staying in the
  room forever inflating its count.
- **The grace period for rejoining an empty room matches the Node server** (30 minutes, not
  60 seconds).
- **Storage writes are throttled**, so dragging a scrub bar is no longer one write per frame.

### Project

- **ESLint and TypeScript on the whole codebase, and CI that runs everything.** The wire
  protocol is defined once, in one file, and checked against every surface that speaks it,
  which is where most of this release's bugs came from. The test suite was good and nothing
  ran it; the browser harness could not even start on a clean machine.
- **A real packaging script** that builds both store zips and refuses to produce one that is
  missing a file its manifest names or carrying a file that should never ship. The documented
  manual command was shipping editor working directories into the store package.
- **The server URL is defined in one place** instead of four.
- **`activeTab` removed from both manifests.** Nothing used it, and an unjustified permission
  on a listing already rejected once for over-broad access is the worst thing to leave lying
  around.

## [Unreleased]

More of the same goal as 1.1.0: the party stays together through anything, now including switching to a whole different streaming app.

### Added

- **Sessions follow you across streaming apps.** Switch the party from one site to another (Netflix to YouTube, a torrent stream to Prime) and the room moves with you instead of ending. Whoever opens the new video pulls everyone else along to it, and a fresh tab auto-rejoins by room code. If two people switch at the same instant to different videos, the room now settles everyone on one of them rather than leaving one person stranded on a video the room already left.
- **The stalled sync leader is now replaced automatically.** The leader is the only member broadcasting position, so if theirs goes quiet (a long ad, a frozen tab, a sleeping laptop) the whole room used to lose drift correction silently. The server now notices a leader that has stopped beating and hands the job to someone who can, on both the Node and Cloudflare backends.

### Fixed

- **A real action taken in the same instant as an incoming sync is no longer swallowed.** Applying a remote play, pause or seek briefly ignores the events it provokes, to avoid echoing them back. That window used to drop a genuine user action that happened to land inside it (you seek right as your friend pauses, and nobody sees your seek). It now ignores only the events that match what was just applied, so your own action still goes through.
- **A Cloudflare room woken from hibernation no longer demotes a healthy sync leader.** The heartbeat clock is restarted on wake so the surviving leader gets a full grace window to prove it is still beating.

### Testing

- **A real two-browser test harness.** Two separate browser profiles (the only way to have two real participants, since one profile is one member), a real seekable video served over HTTP range requests, and assertions that play, pause and seek actually cross between them. It immediately caught two routing bugs in the background worker that no unit test could see.

## [1.1.0] - 2026-07-14

The sync-robustness release. Everything in it serves one goal: the party stays together, and the session survives whatever the browser, the network, or the ad break throws at it.

### Fixed

- **Sync no longer drives every open tab.** Room traffic was broadcast to every tab running the content script (it runs on all sites), so one person hitting play would play every video the user had open in any tab, and any tab could push a sync that moved the whole party. The room is now bound to a single party tab: only that tab receives playback traffic, and only that tab may send it. This was the most serious bug in 1.0.1.
- **Ads no longer drag the room to the start of the video.** An ad reuses the same video element with a tiny duration, so the sync leader was broadcasting the ad's position (a few seconds in) as though it were the film's. Everyone else got yanked back to the beginning.
- **Chat messages over 500 characters are truncated instead of dropped.** (The truncation always worked; the test asserting it was checking the wrong socket and hid a real gap.)
- **The Firefox build's version now matches the Chrome build's.** It had drifted, and a stale version number is an automatic store rejection.

### Added

- **Sessions survive a reload.** Reloading or navigating the party tab used to silently drop you out of the room. The room now hands your membership straight back and pulls the current position from the server, so you land back in sync instead of drifting.
- **Sessions survive a server restart.** Rooms live in memory, so a restart (routine on a free-tier host that idles down) used to strand a live party on "Room not found". A rejoining client now rebuilds the room from the last position it saw, and the party carries on. Someone typing an unknown room code by hand still gets a clean "Room not found", and a room can only be rebuilt under a code the server could actually have issued.
- **Sessions survive closing the party tab.** The room stays live and the popup offers to attach it to a new tab, rather than ending the session.
- **Sessions survive sleep, tab-switching, and network drops.** Coming back from a backgrounded tab, a sleeping laptop, or a dropped connection now triggers a resync instead of leaving you quietly behind.
- **Ad handling is per-viewer.** Your pre-roll is not your friend's, so an ad is no longer a "pause the room" event. You sit out your own ad, the room carries on without you, and you snap back to its true position the moment your ad ends. Recognises YouTube, the Google IMA SDK, JW Player, Video.js, Bitmovin and Plyr, plus a player-agnostic fallback that catches ones nobody has heard of.
- **A sync-health readout and a Resync button** in the overlay: how far you are from the room right now, and one click to snap back.
- **The empty-room grace period is 30 minutes** (was 1). Everyone can step away without losing the room.

### Changed

- **Voice chat is disabled in this release.** The code is untouched and still there behind a flag; it is simply not switched on. Zoom already covers voice for the way this gets used, and shipping a microphone permission alongside all-sites access is exactly what got an earlier version rejected from the Chrome Web Store. It can be switched on in a future release.

### Notes

- Every version uploaded to the Chrome Web Store is re-reviewed, so this release goes through review like any other.
