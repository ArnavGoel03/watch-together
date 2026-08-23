# Chrome Web Store Listing

## Name
Watch Together - Sync Videos with Friends

## Short Description (132 char max)
Sync video playback with friends in real-time. Works on any video site, with shared controls and built-in chat.

## Detailed Description

Watch Together lets you sync video playback across devices anywhere in the world. Start a room, share the code, and watch the same video at the exact same moment: with everyone in full control.

UNIVERSAL COMPATIBILITY
Works on any website with an HTML5 video player. Whether it's a streaming service, a video platform, or a clip embedded on a blog, Watch Together syncs play, pause, and seek events across everyone in the room.

HOW IT WORKS
1. Install the extension on a Chromium-based browser
2. Click the icon and create a room
3. Share the room code or link with friends
4. Everyone opens the same video
5. Play, pause, or seek: it syncs instantly for the whole room

KEY FEATURES
- Real-time playback sync across all participants
- Shared control: anyone in the room can play, pause, or seek
- Built-in chat so you can talk while watching
- Simple 6-character room codes and shareable links
- Automatic drift correction keeps everyone aligned
- Clean dark UI that stays out of the way
- No account required: just pick a name and start

GREAT FOR
- Long-distance movie nights
- Watching shows with friends in different cities
- Study groups and co-learning sessions
- Family watch parties when you're apart
- Premieres and live events

PRIVACY
- No data collection or tracking
- No account required
- Room data is temporary and deleted when everyone leaves
- Open source

## Permission justifications

Written against the 1.2.x manifest. These go to the review team rather than onto the
listing, and BOTH stores ask for them, so they live here instead of only in two
dashboards. Re-read them whenever a permission is added or removed.

### Single purpose description

Watch Together keeps video playback in step for people watching the same video in different browsers. One person presses play, pause or seek, and everyone in the room lands on the same timestamp. That is its only purpose. It reads the position of the video element on the one page a viewer has attached to a room, sends that position to a relay, and applies the room's position back to that same element. It also provides a small in-page panel for creating or joining a room and for text chat with the people in it.

### storage

Stores this viewer's own settings and current room on their own device, using chrome.storage.local: display name, current room code, chosen appearance, overlay hotkey, relay URL, the per-video sync offset, and whether the panel's sections were last left open. None of it is transmitted anywhere. Without it, every setting and the room the viewer is in would be lost on each page load.

### tabs

Identifies which single tab a room is bound to, so that playback commands reach that tab and no other. The extension records the tab when a room is created or joined and addresses its messages to it. This is a correctness requirement rather than a convenience: an earlier version without it broadcast play, pause and seek to every open tab, moving videos the viewer was not watching. It is not used to read browsing history or to enumerate tabs for any other purpose.

### scripting

Used only when a viewer grants access to a site the manifest does not cover, through "Enable on this site" in the popup. Two calls follow that grant: one injects the player scripts into the tab the viewer is already looking at, so they do not have to reload the page after saying yes, and one registers those scripts for that origin so it keeps working on future visits without asking again. It is never used to inject code into a site the viewer has not explicitly granted.

### Host permissions

The listed hosts are the video sites that have a player adapter: youtube.com, youtu.be, netflix.com, hotstar.com, jiohotstar.com, primevideo.com and disneyplus.com. On those sites the extension reads and sets the video element's currentTime and paused state, which is the only way to hold two players at the same position. localhost and 127.0.0.1 are included so it also works against a relay or a test page running on the viewer's own machine. Every other site is deliberately not requested at install: all_urls is declared as an OPTIONAL permission and is requested only when the viewer presses "Enable on this site" and confirms in the browser's own dialog.

### Remote code

No. Every script the extension runs ships inside the package. There are no external script references, no modules pointing at external files, and no strings evaluated through eval or new Function.

### Data usage, ticked

Personally identifiable information (the display name a viewer chooses), personal communications (chat messages are relayed between members while the room is open), web history (the address of the ONE tab a room is attached to is transmitted to the room), and user activity (play, pause and seek are transmitted).

### Data usage, deliberately NOT ticked

Health, financial, authentication, location and website content. Location looks like it applies because the example text names IP address, but the relay only sees the connection address the way any server does, uses it solely to cap rooms per address, and logs a one way hash of it. Website content does not apply because the extension reads currentTime and paused, which is playback state and not content.

Whatever is ticked must keep matching `/privacy`, because the two are compared.

### Privacy policy URL

https://watch.arnavgoel.dev/privacy

## Category
Social & Communication

## Tags
watch together, watch party, sync video, video sync, group watch, synchronized playback, movie night, remote viewing

## Languages
English, Hindi
