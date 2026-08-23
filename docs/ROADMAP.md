# Watch Together: roadmap

`docs/STATE.md` records what is true right now and why each decision was made. This file
records what happens next and in what order. When the two disagree, STATE.md is right
about the present and this file is wrong about the future, so fix this one.

Last reviewed 2026-08-23.

A line moves off this list when the code, its test and its push exist. Nothing is "done"
because a commit message says so.

---

## Now: both stores are in review

**Chrome 1.2.2 submitted 2026-08-23. Edge 1.2.2 submitted 2026-08-23, seven business
days quoted.** The submission chain that used to live here is done. What is left is the
work that should happen WHILE review runs, because if either store comes back with a
question, the answer wants to already exist.

1. **Smoke the real players by hand** (below). This is the largest untested surface in
   the product and it does not need a dashboard.
2. **One manual pass on the per-site permission prompt** (below).
3. **Record what was actually pasted** into the Chrome description back into STATE.md's
   listing table, so the dashboard stops being the only copy.
4. **Reconcile the category.** `store-listing.md` says Social & Communication; the Chrome
   dashboard says Entertainment, and Edge was set to Entertainment to match it. One of
   the two is wrong and the repo should say whichever is right.

The version the public can install is still 1.0.1, and 1.0.1 broadcasts playback commands
to every open tab. That does not change until a review clears.

### Why the description was a paste and not an edit

The 1.2.0 draft was rejected on 2026-08-22 under "Spam and placement in the Store",
violation reference Yellow Argon, for a list of platform names in the item description:
YouTube, Netflix, Prime Video, Disney+, JioHotstar and Hotstar.

That string does not exist anywhere in this repository. `store-listing.md` was rewritten
to carry no platform names at all in commit 1e977cc, after the FIRST rejection. The
dashboard is holding older text than the repo is, so the fix is to make the dashboard
match the repo rather than to change anything here.

The dashboard cannot be automated. Chrome refuses to script, read or screenshot
`chrome.google.com/webstore` at all, for extensions and for MCP alike. This is done by
hand or not at all.

Afterwards, record the description in STATE.md's listing table. The dashboard is the only
other copy and it is not diffable, which is precisely how it drifted in the first place.

### Manual smoke on real streaming sites

The single largest untested surface in the product, and it stays that way: whether the
client RECOGNISES an advert on each real player needs the real sites, real accounts and a
human. What is no longer untested is everything behind that question. A real-browser test
now drives two Chrome profiles through every ad marker the extension knows: the marker
appears, the content script notices, the relay is told, the other person's member list
shows the break, and it clears again when the marker lifts. If that fails, the plumbing
is broken. If the real sites fail while it passes, a selector is out of date, and the fix
is one line in `AD_SELECTORS` in `config.js`.

What to check on each of YouTube, Netflix and JioHotstar: a pre-roll, a mid-roll that
catches one person, a mid-roll that catches everybody, and whether the break clears.

### One manual pass on the per-site permission prompt

Chrome's own permission dialog cannot be driven by a test, so "Enable on this site" has
never been exercised end to end by anything but a person. Open a site outside the
manifest list, grant it, and confirm two things: the scripts reach the tab you are
already looking at without a reload, and they still work on that site tomorrow.

---

## Next

- **Safari is built but cannot be submitted.** Blocked on the Apple Developer Program,
  ninety nine dollars a year, and on nothing else. Before that money is spent, run it in
  Safari and use it from both sides of a room: the "Enable on this site" flow calls
  `chrome.permissions.request()`, which Safari answers differently from Chrome, and it is
  the one thing likely to need Safari-specific code. `docs/SAFARI.md` has the build and
  run steps, which need no account at all.
- **Firefox has never been submitted.** The build is packaged on every release and
  `dist/watch-together-firefox-v1.2.2.zip` exists right now. Submission needs an AMO
  account, which nothing in this repository has. It is a separate dashboard from Chrome's
  and it does not block the Chrome chain.
- **Mismatched sources, the remaining half.** Locking in an offset now persists against
  the video it was measured on, so a fixed mismatch stays fixed the next night. What is
  still missing is sharing it: the offset is one viewer's private correction, so the
  other person is told nothing and has to answer the same prompt themselves. Whether the
  room should carry a per-member offset is a design question, not a bug.

---

## Later

- **`render.yaml` still has not been applied.** The file now says so at the top instead
  of quietly implying otherwise. Either recreate the service from the blueprint, which
  mints a fresh `HOST_TOKEN_SECRET` and logs out every host token in flight, or set the
  values by hand on the running service and delete the notice.
- **Voice.** `VOICE_ENABLED = false` and the WebRTC mesh is intact behind it, on purpose.
  A microphone permission next to a broad host permission is what got an earlier version
  rejected. This turns on when the store relationship is boring, not before.

---

## Settled, so nobody re-opens it

- **The site demo reaches real playback.** The open question was whether the embeds
  engage and then hold at buffering forever, which was seen on one profile with several
  extensions loaded. Checked on 2026-08-23 against the live site in a clean Chrome with
  no extensions: the fallback never fires, and four screenshots of the picture over five
  seconds are four different images, which only happens if video is actually decoding. It
  was a local content blocker. The demo is fine for visitors.

---

## Not doing, and why

- **Personalised server-side ad insertion.** The advert is stitched into the stream:
  duration unchanged, no DOM marker, nothing local distinguishes it from the film. It is
  mitigated by the divergence prompt and the per-viewer offset, and that is the honest
  ceiling. Do not spend days on a heuristic.
- **A shared audio channel.** Ducking exists so a call over the top works. Mixing
  everybody's audio is a different product.
- **Anything that widens the permission ask.** `<all_urls>` is optional and stays
  optional. The short host list plus "Enable on this site" is the whole permissions
  strategy, and it is the reason review is slow rather than fatal.

---

## How something gets onto this list

It has to be either blocking a release, or a promise the site already makes that the
product does not fully keep. Ideas that are neither belong in a conversation, not in a
file that people read as a commitment.
