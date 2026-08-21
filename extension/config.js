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
    "wss://watch-together-server-acwi.onrender.com",
  ];
  const SERVER_URL = SERVER_URLS[0];

  root.__wtConfig = {
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
