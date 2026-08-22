// Single source of truth for values that must agree across the service worker, the
// content script, the overlay and the popup. Anything that appeared in two files was a
// drift bug waiting to happen: the server URL alone used to be written out in four
// places, so pointing the extension at a new relay meant finding all four.
//
// Loaded as the first content script, via importScripts() in the MV3 service worker,
// via the background scripts array on Firefox, and as a plain <script> in the popup.
// Content scripts share one isolated world, so `self.__wtConfig` reaches all of them
// without touching the host page.
(function (root) {
  if (root.__wtConfig) return;

  // Where the relay lives, in priority order.
  //
  // A list, not a single value, because the client is the one thing you CANNOT redeploy
  // quickly: the server is live the moment you push it, but the extension goes through
  // Chrome Web Store review and then waits on auto-update, so a hardcoded single URL means
  // that moving the backend strands every installed copy until a review clears. With a
  // list, a relay can go away and the extension walks to the next one on its own.
  //
  // Adding a backend later (Oracle, a VPS, anything) is two independent moves, and neither
  // of them needs a store release to take effect for existing users:
  //   1. Stand the new relay up and put its URL in SERVER_MOVED_URL on the OLD server. It
  //      tells every client that connects to move, and they do, permanently. See the
  //      `server-moved` handler in background.js.
  //   2. Add the URL to this list so fresh installs go straight there.
  const SERVER_URLS = [
    // Cloudflare first. Durable Objects hibernate and wake on the next message, so there is
    // no spin-down and no cold start: the whole class of "we paused for dinner and the room
    // was gone" simply does not exist there. One object per room, with real persistent
    // storage behind it.
    "wss://watch-together-cf.goelhome.workers.dev",
    // Render stays as the fallback, and it is a real one rather than a formality: if the
    // first relay does not answer, relay.js walks to this one on its own. It is also the
    // deployment that every already-installed copy is talking to, so it does not get to
    // rot just because new installs go elsewhere.
    "wss://watch-together-server-acwi.onrender.com",
  ];
  const SERVER_URL = SERVER_URLS[0];

  root.__wtConfig = {
    // Every file that makes up the in-page half of the extension, in load order.
    //
    // Defined here because it is needed in two places that must never disagree: the
    // manifest's content_scripts (for the sites we are granted up front) and the runtime
    // injection used when a viewer grants access to some other site. A file present in one
    // list and missing from the other produces an extension that loads and silently does
    // nothing, which is the worst kind of bug to diagnose.
    INJECT_FILES: [
      "config.js",
      "relay.js",
      "adapters/generic.js",
      "adapters/jiohotstar.js",
      "adapters/netflix.js",
      "adapters/youtube.js",
      "content.js",
      "overlay.js",
    ],

    // Voice chat ships OFF, and the WebRTC mesh behind it is kept rather than deleted.
    //
    // Watch parties pair with a separate call (Zoom, Meet, Discord), so a built-in mesh is
    // not worth what it costs: two microphone consumers on one machine is at best an echo
    // problem, and a microphone permission sitting next to broad host access is what got an
    // earlier version rejected from the store.
    //
    // It lives here because BOTH surfaces need it. The overlay hid its microphone button,
    // but the popup went on showing a "Voice quality" setting with a three-line explanation
    // for a feature that could not run, which is worse than showing nothing: it is a
    // control that does not control anything.
    VOICE_ENABLED: false,

    // Which visual language the interface speaks.
    //
    // The default look is built on near-black surfaces, hairline edges and light falling
    // from above: a raised control has a lit top edge and a shadow beneath, a field is a
    // hole with the shadow inside it. That is a deliberate house style, and it is not what
    // somebody who lives in Chrome on Windows is used to seeing.
    //
    // So the whole thing is a token swap on one attribute rather than a second interface.
    // Every surface reads data-ui off its own root, the stylesheet redefines the tokens
    // under that attribute, and no logic anywhere branches on which one is active. A look
    // that needed its own code path would drift the moment either side changed.
    UI_STYLES: [
      { value: "apple", label: "Depth", hint: "Hairline edges, light from above" },
      { value: "material", label: "Material", hint: "Flat surfaces, filled buttons" },
    ],
    UI_STYLE_DEFAULT: "apple",
    UI_STYLE_STORAGE_KEY: "uiStyle",

    /** Falls back to the default rather than trusting whatever was in storage. */
    normalizeUiStyle(value) {
      const known = this.UI_STYLES.some((s) => s.value === value);
      // String() rather than returning `value` straight through: the argument is whatever
      // came out of storage, so narrowing it here is what makes the return type honest.
      return known ? String(value) : this.UI_STYLE_DEFAULT;
    },

    // Stamped on everything this client sends. Old extension versions stay installed for
    // weeks after a store release, so the server is permanently talking to clients it
    // cannot upgrade: a version on the wire makes that explicit instead of leaving the
    // server to guess from which fields happen to be present. Bump it only when the shape
    // of a message changes in a way an older peer would misread.
    PROTOCOL_VERSION: 1,

    // The relay every surface talks to unless the user overrides it in Settings, or unless
    // a server has told us it moved.
    SERVER_URL,
    SERVER_URLS,
    // Same host over HTTPS, for the shareable /join/CODE link.
    HTTP_ORIGIN: SERVER_URL.replace(/^wss:/, "https:").replace(/^ws:/, "http:"),

    // A remote peer can move our tab. Only ever to a real web page: `javascript:` and
    // `data:` both survive `new URL()` and would run in whatever origin the viewer
    // happens to have open. The relay filters these too, but a user is free to point
    // the extension at any relay, so the client cannot treat that as a control.
    SAFE_NAVIGATE_PROTOCOLS: ["http:", "https:"],

    // Room codes we could have issued. Kept identical to ROOM_CODE_REGEX and
    // CUSTOM_NAME_REGEX on the server; anything else is not a code.
    ROOM_CODE_REGEX: /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/,
    CUSTOM_NAME_REGEX: /^[A-Z0-9-]{4,32}$/,

    isJoinableCode(code) {
      if (typeof code !== "string") return false;
      const c = code.toUpperCase();
      return root.__wtConfig.ROOM_CODE_REGEX.test(c) || root.__wtConfig.CUSTOM_NAME_REGEX.test(c);
    },

    // ---- Timelines that stop lining up ----
    //
    // Some platforms stitch adverts into the stream itself rather than loading them as a
    // separate video (Hulu, JioHotstar and similar do this on ad-supported tiers). Nothing
    // local can see those: the duration never changes and no marker appears in the page, so
    // to this extension they are simply part of the film.
    //
    // If everybody is served the SAME stitched stream that is a gift, and the adverts play
    // in perfect sync with no work from us. But when the pods are personalised, one viewer's
    // break might run 90 seconds and another's 120, and from then on the same currentTime
    // means a different frame for each of them. The gap is a STEP, it appears the moment the
    // break ends, and it never closes on its own. Worse, ordinary drift correction reacts to
    // it by seeking somebody backwards into the tail of their own adverts.
    //
    // A step like that is not drift and must not be treated as it. It is the two people
    // holding different cuts of the same film, which is exactly what the per-viewer offset
    // exists to express.
    TIMELINE_STEP_MIN_SECONDS: 5,

    /**
     * Does this gap look like two different cuts rather than one player lagging?
     * Everything that could explain it more simply has to be ruled out first, because
     * guessing wrong here silently desynchronises somebody.
     */
    looksLikeTimelineDivergence(drift, ctx) {
      if (typeof drift !== "number" || !isFinite(drift)) return false;
      if (Math.abs(drift) < root.__wtConfig.TIMELINE_STEP_MIN_SECONDS) return false;
      // Falling behind because the video stalled is lag, and it closes on its own.
      if (ctx.buffering) return false;
      // A paused player drifts for the dullest possible reason.
      if (ctx.paused) return false;
      // They just moved the playhead themselves. That gap is theirs and it is intended.
      if (ctx.sinceLocalSeekMs < 5000) return false;
      // A player that has only just been bound is still settling.
      if (ctx.sinceAttachMs < 10000) return false;
      // Mid-redirect to somebody else's video: positions are meaningless until it lands.
      if (ctx.navigating) return false;
      // Asked recently. Being wrong occasionally is survivable; nagging is not.
      if (ctx.sinceAskedMs < 120000) return false;
      return true;
    },

    /**
     * The offset that leaves this viewer exactly where they are, reinterpreting the room's
     * timeline around them instead of dragging them through their own adverts.
     * Same arithmetic as the manual "Use current" control, deliberately.
     */
    offsetAbsorbing(currentOffset, drift) {
      return Math.round((currentOffset - drift) * 2) / 2;
    },

    // A relay URL we are willing to talk to.
    //
    // wss only, with one exception: loopback. Room codes, chat and the address of
    // everything you watch cross this socket, and ws:// puts all of it in clear text on
    // whatever network the viewer is on. Loopback never leaves the machine, cannot be
    // intercepted, and cannot be given a real certificate, so refusing it does not protect
    // anyone: it just makes local development and the browser test harness impossible.
    //
    // That is not hypothetical. Rejecting ws://localhost silently sent the two-browser
    // harness to the PRODUCTION relay instead of the local one under test, where it quietly
    // passed for a while and then started failing against real rate limits.
    isValidServerUrl(raw) {
      if (typeof raw !== "string") return false;
      if (/^wss:\/\/[^\s]+$/i.test(raw)) return true;
      if (!/^ws:\/\/[^\s]+$/i.test(raw)) return false;
      try {
        const host = new URL(raw).hostname;
        return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
      } catch {
        return false;
      }
    },

    // A video-call link the room can share. Deliberately an allowlist of the platforms
    // people actually use, not "any https URL": this link is handed to everyone in the
    // room and rendered as a button, so a free-text URL field would be a tidy way to get
    // strangers to click on anything at all. Zoom's own deep link scheme is included so
    // the desktop app opens directly rather than bouncing through the browser.
    CALL_HOSTS: [
      "zoom.us",
      "zoomgov.com",
      "meet.google.com",
      "teams.microsoft.com",
      "teams.live.com",
      "discord.gg",
      "discord.com",
      "whereby.com",
      "meet.jit.si",
   ],

    // Which platform a pinned link belongs to, so the button can say "Join Zoom call"
    // rather than a vague "Join the call". Knowing what you are about to be dropped into
    // matters when the answer might be a different app opening over your film.
    describeCall(raw) {
      try {
        const u = new URL(String(raw).trim());
        if (u.protocol === "zoommtg:" || u.protocol === "zoomus:") return { id: "zoom", name: "Zoom" };
        const host = u.hostname.toLowerCase();
        const match = (d) => host === d || host.endsWith("." + d);
        if (match("zoom.us") || match("zoomgov.com")) return { id: "zoom", name: "Zoom" };
        if (match("meet.google.com")) return { id: "meet", name: "Google Meet" };
        if (match("teams.microsoft.com") || match("teams.live.com")) return { id: "teams", name: "Teams" };
        if (match("discord.gg") || match("discord.com")) return { id: "discord", name: "Discord" };
        if (match("whereby.com")) return { id: "whereby", name: "Whereby" };
        if (match("meet.jit.si")) return { id: "jitsi", name: "Jitsi" };
      } catch { /* not a URL we can read */ }
      return { id: "call", name: "call" };
    },

    // Pages that start a brand new meeting on the platforms people actually use. Both work
    // for anyone already signed in, and neither needs an API key, an OAuth app, or a review:
    // creating meetings through the vendors' APIs would mean a published app and weeks of
    // approval for something a signed-in user does in one click anyway.
    NEW_CALL_URLS: {
      zoom: "https://zoom.us/start/videomeeting",
      meet: "https://meet.google.com/new",
    },

    isValidCallUrl(raw) {
      if (typeof raw !== "string" || !raw.trim()) return false;
      try {
        const u = new URL(raw.trim());
        // Zoom's app scheme, which opens the installed client straight into the meeting.
        if (u.protocol === "zoommtg:" || u.protocol === "zoomus:") return true;
        if (u.protocol !== "https:") return false;
        const host = u.hostname.toLowerCase();
        return root.__wtConfig.CALL_HOSTS.some((d) => host === d || host.endsWith("." + d));
      } catch {
        return false;
      }
    },

    /**
     * Ad markers used by the common web players. Cheap to test, and it covers most of the
     * web without a per-site adapter.
     *
     * Here rather than in content.js because it was in two places: the YouTube adapter
     * carried its own two-selector copy and used it to decide whether to apply a sync,
     * so a marker added to one list silently did not exist for the other. This is exactly
     * the kind of value that drifts and then fails quietly, on the one site most people
     * try first.
     */
    AD_SELECTORS: [
      ".ad-showing",              // YouTube
      ".ad-interrupting",         // YouTube
      ".ytp-ad-player-overlay",   // YouTube
      ".ytp-ad-module:not(:empty)",
      ".ima-ad-container",        // Google IMA SDK (very widely embedded)
      ".videoAdUi",
      ".jw-flag-ads",             // JW Player
      ".vjs-ad-playing",          // Video.js
      ".bitmovinplayer-ad",       // Bitmovin
      ".plyr--ads",               // Plyr
    ],

    // How many videos worth of locked-in offsets to keep. Storage is small and this is a
    // convenience, not a record: past this the least recently used one goes.
    OFFSET_STORE_LIMIT: 40,

    // Query parameters that say WHERE you are in a video, or how you got to it, rather
    // than WHICH video it is. Two URLs differing only by these are the same film, and an
    // offset measured on one has to be found again from the other.
    OFFSET_KEY_IGNORED_PARAMS: [
      "wt_room", "t", "start", "time_continue", "si", "feature", "pp",
      "list", "index", "ab_channel", "utm_source", "utm_medium", "utm_campaign",
    ],

    /**
     * The identity a locked-in offset belongs to.
     *
     * An offset says "my copy of THIS film runs N seconds against whatever the room is
     * holding". That is a fact about a video, not about a browser, so it is stored per
     * video. Stored globally, as it once was, it is a trap: the number is correct for the
     * film it was measured on and silently wrong for every other one, forever, with
     * nothing on screen to explain why two people are twelve seconds apart tomorrow.
     */
    offsetKeyFor(url) {
      if (typeof url !== "string" || !url) return "";
      try {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol)) return "";
        for (const p of root.__wtConfig.OFFSET_KEY_IGNORED_PARAMS) u.searchParams.delete(p);
        // Sorted, so the same video reached with its parameters in a different order is
        // still the same key.
        u.searchParams.sort();
        const q = u.searchParams.toString();
        return u.host.toLowerCase() + u.pathname.replace(/\/$/, "") + (q ? "?" + q : "");
      } catch {
        return "";
      }
    },

    /** The offset held for one video, and zero for anything unknown or malformed. */
    readOffset(store, key) {
      if (!store || !key || typeof store !== "object") return 0;
      const entry = store[key];
      const seconds = entry && typeof entry === "object" ? entry.seconds : entry;
      if (typeof seconds !== "number" || !isFinite(seconds)) return 0;
      return Math.max(-600, Math.min(600, seconds));
    },

    /**
     * The store with one video's offset recorded, as a NEW object. Zero deletes the entry
     * rather than writing a zero, because "no offset" and "an offset that happens to be
     * none" are the same thing and only one of them should take up a slot.
     */
    writeOffset(store, key, seconds, nowMs) {
      const next = {};
      if (store && typeof store === "object") {
        for (const k of Object.keys(store)) {
          const e = store[k];
          if (e && typeof e === "object" && typeof e.seconds === "number") next[k] = e;
          else if (typeof e === "number" && isFinite(e)) next[k] = { seconds: e, at: 0 };
        }
      }
      if (!key) return next;
      const n = Number(seconds);
      const clamped = isFinite(n) ? Math.max(-600, Math.min(600, n)) : 0;
      if (clamped === 0) delete next[key];
      else next[key] = { seconds: clamped, at: typeof nowMs === "number" ? nowMs : 0 };

      const keys = Object.keys(next);
      const limit = root.__wtConfig.OFFSET_STORE_LIMIT;
      if (keys.length > limit) {
        keys
          .sort((a, b) => (next[a].at || 0) - (next[b].at || 0))
          .slice(0, keys.length - limit)
          .forEach((k) => delete next[k]);
      }
      return next;
    },

    // True only for a URL it is safe to send someone's tab to.
    isSafeNavigateUrl(raw) {
      if (typeof raw !== "string" || !raw) return false;
      try {
        const u = new URL(raw);
        return root.__wtConfig.SAFE_NAVIGATE_PROTOCOLS.includes(u.protocol);
      } catch {
        return false;
      }
    },
  };
})(typeof self !== "undefined" ? self : window);
