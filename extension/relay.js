// Which relay to talk to, and what to do when it stops answering.
//
// This lives in its own file, loaded by BOTH background scripts, because every serious
// bug this extension has shipped came from the Chrome and Firefox background twins each
// carrying their own copy of the same logic and then drifting apart: Firefox silently
// dropped `mode` and `customName` from create-room, and dropped three inbound message
// types entirely, so features worked on one browser and did nothing on the other. Logic
// that both twins need belongs in one file that both twins load.
//
// The problem this solves: the server can be redeployed in seconds, but the client cannot.
// A new extension version has to clear Chrome Web Store review and then wait for browsers
// to auto-update, which is days. So the relay address can never be a single hardcoded
// value, or moving the backend strands every installed copy until a review clears.
//
// Three sources, in order of trust:
//   1. What the user typed in Settings. Their machine, their choice, always wins.
//   2. Where a server told us it had moved. This is the migration path: stand up the new
//      relay, set SERVER_MOVED_URL on the old one, and every client walks itself over
//      without a store release. Persisted, so it survives restarts.
//   3. The built-in list in config.js, tried in order.
//
// Within that, a relay that will not connect is skipped and the next one tried, so one
// dead backend is a pause rather than an outage.

(function (root) {
  if (root.__wtRelay) return;

  const cfg = root.__wtConfig;

  class RelayPicker {
    constructor() {
      /** What the user explicitly chose in Settings. Highest priority, never overridden. */
      this.override = null;
      /** Where a server told us it moved. Persisted across restarts. */
      this.moved = null;
      /** Index into the current candidate list. */
      this.index = 0;
      /** Failed connection attempts against the CURRENT candidate. */
      this.failures = 0;
      /** Try a candidate this many times before walking to the next one. */
      this.maxFailuresPerCandidate = 2;
    }

    /** The full ordered list of relays worth trying, deduplicated. */
    candidates() {
      const list = [];
      if (cfg.isValidServerUrl(this.override)) list.push(this.override);
      if (cfg.isValidServerUrl(this.moved)) list.push(this.moved);
      for (const url of cfg.SERVER_URLS) if (cfg.isValidServerUrl(url)) list.push(url);
      // A user override that happens to equal a built-in must not be tried twice.
      return [...new Set(list)];
    }

    /** The relay to connect to right now. */
    current() {
      const list = this.candidates();
      if (list.length === 0) return cfg.SERVER_URL;
      return list[this.index % list.length];
    }

    /** A connection succeeded: this relay is good, stop counting against it. */
    onConnected() {
      this.failures = 0;
    }

    /**
     * A connection attempt failed. Returns true if we moved on to a different relay, so
     * the caller can tell the difference between "retrying" and "trying somewhere else".
     */
    onFailure() {
      this.failures++;
      if (this.failures < this.maxFailuresPerCandidate) return false;
      this.failures = 0;
      const list = this.candidates();
      if (list.length < 2) return false; // nowhere else to go: keep retrying this one
      this.index = (this.index + 1) % list.length;
      return true;
    }

    /**
     * A server told us it has moved. Accepted only if it is a real wss:// URL and actually
     * different from where we already are, so a server cannot make us thrash by repeating
     * its own address back at us.
     */
    acceptMove(url) {
      if (!cfg.isValidServerUrl(url)) return false;
      if (url === this.moved) return false;
      if (url === this.current()) return false;
      this.moved = url;
      this.index = 0;
      this.failures = 0;
      return true;
    }

    /** The user set, or cleared, an explicit server in Settings. */
    setOverride(url) {
      this.override = cfg.isValidServerUrl(url) ? url : null;
      this.index = 0;
      this.failures = 0;
      return this.override;
    }

    /** Restore what we learned last time the browser was open. */
    hydrate({ serverUrl, movedServerUrl } = {}) {
      if (cfg.isValidServerUrl(serverUrl)) this.override = serverUrl;
      if (cfg.isValidServerUrl(movedServerUrl)) this.moved = movedServerUrl;
    }
  }

  root.__wtRelay = { RelayPicker };
})(typeof self !== "undefined" ? self : window);
