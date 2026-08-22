# Watch Together: roadmap

`docs/STATE.md` records what is true right now and why each decision was made. This file
records what happens next and in what order. When the two disagree, STATE.md is right
about the present and this file is wrong about the future, so fix this one.

Last reviewed 2026-08-23.

A line moves off this list when the code, its test and its push exist. Nothing is
"done" because a commit message says so.

---

## Now: get 37 users off 1.0.1

Everything in this section is one dependency chain. Nothing else in the project matters
until the chain clears, because the version the public can install is 1.0.1, and 1.0.1
broadcasts playback commands to every open tab.

### 1. Resubmit the listing without the platform names

**Blocked on: one paste into the dashboard.**

The 1.2.0 draft was rejected on 2026-08-22 under "Spam and placement in the Store",
violation reference Yellow Argon. The quoted text is a list of platform names in the
item description: YouTube, Netflix, Prime Video, Disney+, JioHotstar and Hotstar. The
policy is about metadata, not about the extension, and the stated remedy is to remove
the keywords and resubmit.

That string does not exist anywhere in this repository. `store-listing.md` was already
rewritten to carry no platform names at all, in commit 1e977cc, after the FIRST
rejection. So the dashboard is holding older text than the repo is, and the fix is to
make the dashboard match `store-listing.md` rather than to edit anything here.

The dashboard cannot be automated: Chrome refuses to script, read or screenshot
`chrome.google.com/webstore`, for extensions and for MCP alike. This step is done by
hand or not at all.

Two related fields carry the same risk and want the same read:

- **Short description.** 132 characters, and the one in `store-listing.md` names no
  platform.
- **Host permission justification.** It is generated from the uploaded package, and for
  1.2.x it legitimately names six sites, because six is what the manifest asks for. A
  justification that names the sites it is justifying is not keyword stuffing. Leave it
  factual and do not pad it.

After the paste, re-record the description in STATE.md's listing table. The dashboard is
the only other copy and it is not diffable, which is exactly how it drifted.

### 2. Upload 1.2.1 over the pending submission

Already true and unchanged from STATE.md: the package is built and verified, and the
Privacy tab's questions are generated from whichever package is uploaded, so the upload
comes first and the justifications second.

### 3. Manual smoke on real streaming sites

The single largest untested surface in the product. Every automated test runs against a
bare `<video>`. Whether the client RECOGNISES an ad on each real player has never been
verified by anything but a person. Do this before the review lands, not after.

### 4. One manual pass on the per-site permission prompt

Chrome's own permission dialog cannot be driven by a test. The "Enable on this site"
flow has never been exercised end to end except by hand.

---

## Next: the things a second reviewer would ask about

- **Settle the site demo's playback question.** Open `watch.arnavgoel.dev` in an
  Incognito window, extensions off, and press Play the demo. Playing means the earlier
  stall was a local content blocker and the demo is fine for visitors. Sticking means
  something real is wrong, and the honest fallback the page already ships is doing more
  work than intended. This is a fifteen second test that has been open for a day.
- **Mismatched sources.** There is a per-viewer offset and a divergence prompt, but no
  way to say "I am twelve seconds ahead, lock it in" and have it persist for the room.
  The card on the site now draws this behaviour, which is a promise the product should
  keep completely rather than nearly.
- **Firefox.** The build exists and is packaged on every release. It has never been
  submitted anywhere.
- **`render.yaml` has never been applied.** The live Render service was created through
  the dashboard, so the blueprint is documentation of intent, not a description of the
  running service. Either apply it or say in the file that it is not applied.

---

## Later

- **Persisted per-room offsets**, so a fixed source mismatch stays fixed the next night.
- **Voice.** `VOICE_ENABLED = false` and the WebRTC mesh is intact behind it, on purpose.
  A microphone permission next to a broad host permission is what got an earlier version
  rejected. This turns on when the store relationship is boring, not before.
- **The site's remaining flat surfaces.** The hero and the six cards now demonstrate
  rather than describe. The support and privacy pages do not.

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
