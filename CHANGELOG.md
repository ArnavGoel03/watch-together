# Changelog

All notable changes to Watch Together are documented here.

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
