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
      this.affinity = null;
      /** Index into the current candidate list. */
      this.index = 0;
      /** Failed connection attempts against the CURRENT candidate. */
      this.failures = 0;
      /** Try a candidate this many times before walking to the next one. */
      this.maxFailuresPerCandidate = 2;
    }

    /** The full ordered list of relays worth trying, deduplicated. */
    candidates() {
      // A private relay is a privacy boundary. Falling back to a public relay would
      // replay its room code, playback URL and host credential without consent.
      if (cfg.isValidServerUrl(this.override)) return [this.override];
      if (cfg.isValidServerUrl(this.affinity)) return [this.affinity];
      const list = [];
      if (cfg.isValidServerUrl(this.moved)) list.push(this.moved);
      for (const url of cfg.SERVER_URLS) if (cfg.isValidServerUrl(url)) list.push(url);
      // A migration URL that equals a built-in must not be tried twice.
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
      if (cfg.isValidServerUrl(this.override)) return false;
      if (!cfg.isValidServerUrl(url)) return false;
      if (url === this.moved) return false;
      if (url === this.current()) return false;
      this.moved = url;
      if (this.affinity) this.affinity = url;
      this.index = 0;
      this.failures = 0;
      return true;
    }

    // Independent relays do not share room state. A successful membership pins its
    // authority until leave or an authenticated migration from that same connection.
    pin(url = this.current()) {
      this.affinity = cfg.isValidServerUrl(url) ? url : null;
      this.index = 0;
      this.failures = 0;
    }

    clearAffinity() {
      this.affinity = null;
      this.index = 0;
      this.failures = 0;
    }

    /** The user set, or cleared, an explicit server in Settings. */
    setOverride(url) {
      this.override = cfg.isValidServerUrl(url) ? url : null;
      this.index = 0;
      this.failures = 0;
      return this.override;
    }

    /** Restore what we learned last time the browser was open. */
    hydrate({ serverUrl, movedServerUrl, roomRelayUrl, currentRoom } = {}) {
      if (cfg.isValidServerUrl(serverUrl)) this.override = serverUrl;
      if (cfg.isValidServerUrl(movedServerUrl)) this.moved = movedServerUrl;
      if (currentRoom) this.pin(cfg.isValidServerUrl(roomRelayUrl) ? roomRelayUrl : this.current());
    }
  }

  // Diagnostics are deliberately constructed from enums and numbers. Never accept a
  // wire message or an arbitrary object here, even when a caller believes it is safe.
  class ConnectionLifecycle {
    constructor(publish) {
      this.publish = publish;
      this.startedAt = Date.now();
      this.connectionState = "idle";
      this.rttMs = null;
      this.reconnectAttempts = 0;
      this.events = [];
      this.pingAt = null;
      this.socketDeadline = null;
      this.requestDeadline = null;
      this.waiters = new Set();
    }

    record(event, value) {
      if (!cfg.DIAGNOSTIC_EVENTS.includes(event)) return;
      const entry = { atMs: Math.max(0, Date.now() - this.startedAt), event };
      if (Number.isFinite(value) && value >= 0 && value <= 60000) entry.value = Math.round(value);
      this.events.push(entry);
      if (this.events.length > 100) this.events.shift();
    }

    snapshot() {
      return { schemaVersion: 1, connectionState: this.connectionState, rttMs: this.rttMs,
        reconnectAttempts: this.reconnectAttempts, events: this.events.map((entry) => ({ ...entry })) };
    }

    state(state, attempts = 0) {
      if (!["idle", "connecting", "connected", "reconnecting", "disconnected"].includes(state)) return;
      this.connectionState = state;
      this.reconnectAttempts = Math.max(0, Math.min(1000, attempts));
      if (state !== "connected") { this.pingAt = null; this.rttMs = null; }
      this.record(state);
      this.publish(this.snapshot());
    }

    arm(onTimeout) {
      this.disarm();
      this.state("connecting", this.reconnectAttempts);
      this.socketDeadline = setTimeout(() => {
        this.socketDeadline = null;
        this.record("connect-timeout");
        onTimeout();
      }, 10000);
    }

    disarm() {
      if (this.socketDeadline !== null) clearTimeout(this.socketDeadline);
      this.socketDeadline = null;
    }

    request(onTimeout) {
      this.cancelRequest();
      this.requestDeadline = setTimeout(() => {
        this.requestDeadline = null;
        this.record("request-timeout");
        onTimeout();
      }, 15000);
    }

    cancelRequest() {
      if (this.requestDeadline !== null) clearTimeout(this.requestDeadline);
      this.requestDeadline = null;
    }

    ping() {
      // Only one measurement may be outstanding because legacy pongs have no nonce.
      if (this.pingAt === null) { this.pingAt = Date.now(); this.record("ping"); }
    }

    pong() {
      if (this.pingAt === null) return;
      const elapsed = Date.now() - this.pingAt;
      this.pingAt = null;
      if (elapsed < 0 || elapsed > 60000) return;
      this.rttMs = elapsed;
      this.record("pong", elapsed);
      this.publish(this.snapshot());
    }

    cancelWaiters() {
      for (const timer of this.waiters) clearTimeout(timer);
      this.waiters.clear();
    }

    wait(ready, valid, connect, callback, timeout) {
      const deadline = Date.now() + 25000;
      const check = () => {
        if (!valid()) return;
        if (ready()) { callback(); return; }
        if (Date.now() >= deadline) {
          this.record("request-timeout");
          this.publish(this.snapshot());
          timeout();
          return;
        }
        connect();
        const timer = setTimeout(() => { this.waiters.delete(timer); check(); }, 250);
        this.waiters.add(timer);
      };
      check();
    }
  }

  // Invitations belong to the tab that received them, never a browser-wide slot. A
  // login redirect keeps the entry until that same tab returns to the exact destination.
  class InviteStore {
    constructor(storage) {
      this.storage = storage;
      this.entries = {};
      this.sequence = 0;
      this.queue = new Promise((resolve) => storage.get(["pendingInvitesByTab"], (data) => {
        if (data.pendingInvitesByTab && typeof data.pendingInvitesByTab === "object") this.entries = data.pendingInvitesByTab;
        this.prune();
        resolve();
      }));
    }

    normalize(raw) {
      if (typeof raw !== "string" || raw.length > 4096 || !cfg.isSafeNavigateUrl(raw)) return null;
      const url = new URL(raw);
      for (const key of [...url.searchParams.keys()]) if (key.startsWith("wt_")) url.searchParams.delete(key);
      return url.href;
    }

    prune() {
      const now = Date.now();
      this.entries = Object.fromEntries(Object.entries(this.entries).filter(([key, entry]) =>
        /^\d+$/.test(key) && entry && cfg.isJoinableCode(entry.roomCode) && this.normalize(entry.url) === entry.url &&
        typeof entry.id === "string" && Number.isFinite(entry.at) && entry.at <= now && now - entry.at < 1800000
      ).sort((a, b) => b[1].at - a[1].at).slice(0, 32));
    }

    handle(msg, sender) {
      const task = this.queue.then(() => {
        this.prune();
        const tabId = sender?.tab?.id;
        const url = this.normalize(sender?.url || sender?.tab?.url);
        if (!Number.isInteger(tabId) || tabId < 0 || (sender.frameId && sender.frameId !== 0) || !url) return { ok: false, pendingInvite: null };
        const key = String(tabId);
        const entry = this.entries[key];
        let result = { ok: false, pendingInvite: null };
        if (msg.type === "capture-invite" && cfg.isJoinableCode(msg.roomCode) && this.normalize(msg.url) === url) {
          this.entries[key] = {
            id: `${Date.now()}-${++this.sequence}`, roomCode: msg.roomCode.toUpperCase(), url, at: Date.now(),
            inviteToken: typeof msg.inviteToken === "string" && /^[a-f0-9]{32,128}$/i.test(msg.inviteToken) ? msg.inviteToken : null,
            relayUrl: cfg.isValidServerUrl(msg.relayUrl) ? msg.relayUrl : null,
          };
          this.prune();
          result = { ok: true, pendingInvite: null };
        } else if (msg.type === "get-pending-invite") {
          result = { ok: true, pendingInvite: entry?.url === url ? { ...entry } : null };
        } else if (msg.type === "clear-pending-invite" && entry?.url === url && msg.id === entry.id) {
          delete this.entries[key];
          result = { ok: true, pendingInvite: null };
        }
        this.storage.set({ pendingInvitesByTab: this.entries });
        return result;
      });
      this.queue = task.then(() => undefined);
      return task;
    }

    removeTab(tabId) {
      this.queue = this.queue.then(() => {
        delete this.entries[String(tabId)];
        this.prune();
        this.storage.set({ pendingInvitesByTab: this.entries });
      });
    }
  }

  root.__wtRelay = { RelayPicker, ConnectionLifecycle, InviteStore };
})(typeof self !== "undefined" ? self : window);
