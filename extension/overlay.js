// Overlay - injects Watch Together UI directly into video player controls

(function () {
  if (window.__watchTogetherOverlayLoaded) return;
  window.__watchTogetherOverlayLoaded = true;

  let overlayBtn = null;
  let overlayPanel = null;
  let port = null;
  let inRoom = false;
  let currentRoom = null;
  let myUserId = null;
  let userName = "";
  let memberCount = 1;
  // Who is here and what each of them is doing. The count alone answers "is anyone else
  // there"; it does not answer the question people actually ask when something looks
  // wrong, which is "is it me, or is it them". Names plus per-person state do.
  const membersById = new Map(); // id -> { userName, inAd }
  let iAmHost = false;
  let iAmLeader = false;
  let roomMode = "everyone";
  let syncOffset = 0; // seconds this viewer's copy runs ahead of the room's timeline
  let pendingEnterSend = false; // true if user pressed Enter during IME composition
  const inFlight = new Set();

  // ---------- Hotkey config ----------
  // Two modes: "click" (current behavior, button click toggles) or "hold" (panel only
  // visible while configured key is held - push-to-show, like push-to-talk).
  const HOTKEY_DEFAULT = "\\"; // backslash - rarely used by sites, easy to reach on most layouts
  let overlayMode = "click";
  let overlayHotkey = HOTKEY_DEFAULT;
  let hotkeyHeld = false; // true while the configured hotkey is currently down

  // ---------- Voice mesh state ----------
  // WebRTC peer-to-peer audio. Server only relays SDP/ICE via voice-signal messages.
  //
  // SHIPPED OFF as of v1.1.0. Watch parties pair with a separate call (Zoom, Meet,
  // Discord), so the built-in mesh is not worth the microphone permission: it would
  // put an <all_urls> extension in front of a manual store review for a feature nobody
  // asked for. The implementation is kept intact and unreferenced-but-live behind this
  // flag. Flip to true to bring it back; the UI, signaling, and server relays all remain.
  const VOICE_ENABLED = false;

  const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
  // Voice quality modes:
  //   "media"  - DEFAULT. Echo cancellation OFF. Chrome does NOT switch the tab into the
  //              "communication" audio category, so the video's audio stays at full volume.
  //              Trade-off: people on speakers may hear themselves through their friend's mic.
  //   "voice"  - Echo cancellation ON. Better voice quality on speakers. Chrome ducks the
  //              video audio, sometimes permanently until the tab is closed (known bug).
  let voiceQuality = "media";
  // Default playback volume for peer voices. Lower than 1.0 so voice doesn't drown out video.
  const PEER_VOLUME = 0.85;
  const voice = {
    active: false,            // we are broadcasting our mic
    localStream: null,        // MediaStream from getUserMedia
    peers: new Map(),         // peerUserId -> RTCPeerConnection
    audioEls: new Map(),      // peerUserId -> HTMLAudioElement
    activePeerIds: new Set(), // userIds of other members currently in voice
    pendingICE: new Map(),    // peerUserId -> [candidates] queued before remoteDescription set
  };

  function micConstraints() {
    if (voiceQuality === "voice") {
      return {
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      };
    }
    // "media" - explicitly disable processing so Chrome stays in "playback" audio category
    return {
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    };
  }

  // Robust clipboard write - must run synchronously inside the click handler
  // (Chrome rejects clipboard writes outside the user-gesture context).
  async function safeCopy(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through to execCommand */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none;z-index:-1";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  // Anything waiting on the server is released by the server's answer, with the timer
  // kept only as a backstop. Releasing on the timer alone meant a rejection that arrived
  // in 40ms still left Create greyed out for the remaining four seconds, so the user read
  // the error, clicked again, and nothing happened.
  const inFlightResolvers = new Map();

  function withInFlight(key, btn, fn) {
    if (inFlight.has(key)) return;
    inFlight.add(key);
    if (btn) btn.disabled = true;
    const release = () => {
      if (!inFlight.has(key)) return;
      inFlight.delete(key);
      inFlightResolvers.delete(key);
      if (btn) btn.disabled = false;
    };
    inFlightResolvers.set(key, release);
    Promise.resolve(fn()).finally(release);
  }

  // Called when the server has actually answered.
  function settleInFlight(...keys) {
    for (const key of keys) {
      const release = inFlightResolvers.get(key);
      if (release) release();
    }
  }

  function safePost(msg) {
    try {
      if (!port) { connectPort(); return false; }
      port.postMessage(msg);
      return true;
    } catch {
      port = null;
      connectPort();
      return false;
    }
  }

  // ============================================================
  // Voice mesh - WebRTC peer-to-peer audio
  // ============================================================

  async function startVoice() {
    if (!VOICE_ENABLED) return;
    if (voice.active) return;
    try {
      voice.localStream = await navigator.mediaDevices.getUserMedia(micConstraints());
    } catch (err) {
      addSystemMsg("Mic access denied - enable it in site settings");
      console.warn("[WatchTogether voice] getUserMedia failed:", err);
      return;
    }
    voice.active = true;
    updateMicButton();
    safePost({ type: "voice-state", active: true });
    // Initiate offers to every existing voice-active peer.
    // Tie-break: only the lower-userId side initiates to avoid dueling offers.
    for (const peerId of voice.activePeerIds) {
      if (peerId === myUserId) continue;
      if (myUserId && myUserId < peerId) {
        ensurePeer(peerId, /*initiator*/ true);
      } else {
        // Other side will initiate when they see our voice-state - we just open the slot
        ensurePeer(peerId, /*initiator*/ false);
      }
    }
  }

  function stopVoice() {
    if (!voice.active && voice.peers.size === 0) return;
    voice.active = false;
    // 1. Stop and disable every mic track BEFORE dropping the stream reference.
    //    Belt-and-suspenders so Chrome releases the audio session ASAP.
    if (voice.localStream) {
      for (const t of voice.localStream.getTracks()) {
        try { t.enabled = false; } catch {}
        try { t.stop(); } catch {}
      }
      voice.localStream = null;
    }
    // 2. Tear down every peer connection. Remove all event listeners by setting
    //    null handlers first - defensive against the close path firing late.
    for (const [peerId, pc] of voice.peers) {
      try {
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;
        for (const sender of pc.getSenders ? pc.getSenders() : []) {
          if (sender.track) try { sender.track.stop(); } catch {}
        }
        pc.close();
      } catch {}
      removeAudioFor(peerId);
    }
    voice.peers.clear();
    voice.pendingICE.clear();
    safePost({ type: "voice-state", active: false });
    updateMicButton();
    updateVoiceBadge();
  }

  function ensurePeer(peerId, initiator) {
    if (voice.peers.has(peerId)) return voice.peers.get(peerId);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    voice.peers.set(peerId, pc);

    if (voice.localStream) {
      voice.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, voice.localStream);
      });
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        safePost({
          type: "voice-signal",
          toUserId: peerId,
          signal: { kind: "ice", candidate: e.candidate },
        });
      }
    };

    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream) return;
      let el = voice.audioEls.get(peerId);
      if (!el) {
        el = document.createElement("audio");
        el.id = `wt-voice-audio-${peerId}`;
        el.autoplay = true;
        el.volume = PEER_VOLUME; // keep voice from drowning the show
        el.style.cssText = "position:fixed;width:0;height:0;opacity:0;pointer-events:none";
        document.body.appendChild(el);
        voice.audioEls.set(peerId, el);
      }
      el.srcObject = stream;
    };

    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        // Best-effort renegotiation: only the initiator side retries
        if (initiator && voice.active && voice.activePeerIds.has(peerId)) {
          // Tear down and re-create after a beat
          try { pc.close(); } catch {}
          voice.peers.delete(peerId);
          removeAudioFor(peerId);
          setTimeout(() => {
            if (voice.active && voice.activePeerIds.has(peerId)) {
              ensurePeer(peerId, true);
            }
          }, 1000);
        }
      }
    };

    if (initiator) {
      (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          safePost({
            type: "voice-signal",
            toUserId: peerId,
            signal: { kind: "offer", sdp: offer },
          });
        } catch (err) {
          console.warn("[WatchTogether voice] createOffer failed:", err);
        }
      })();
    }
    return pc;
  }

  function removeAudioFor(peerId) {
    const el = voice.audioEls.get(peerId);
    if (el) {
      el.srcObject = null;
      el.remove();
      voice.audioEls.delete(peerId);
    }
  }

  async function handleVoiceSignal(msg) {
    const peerId = msg.fromUserId;
    if (!peerId) return;
    const sig = msg.signal || {};
    const pc = ensurePeer(peerId, /*initiator*/ false);
    try {
      if (sig.kind === "offer") {
        await pc.setRemoteDescription(sig.sdp);
        // Drain any ICE candidates that arrived before the offer
        const queued = voice.pendingICE.get(peerId) || [];
        for (const c of queued) {
          try { await pc.addIceCandidate(c); } catch {}
        }
        voice.pendingICE.delete(peerId);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        safePost({
          type: "voice-signal",
          toUserId: peerId,
          signal: { kind: "answer", sdp: answer },
        });
      } else if (sig.kind === "answer") {
        await pc.setRemoteDescription(sig.sdp);
        const queued = voice.pendingICE.get(peerId) || [];
        for (const c of queued) {
          try { await pc.addIceCandidate(c); } catch {}
        }
        voice.pendingICE.delete(peerId);
      } else if (sig.kind === "ice") {
        if (pc.remoteDescription) {
          try { await pc.addIceCandidate(sig.candidate); } catch {}
        } else {
          // Queue until remoteDescription is set
          if (!voice.pendingICE.has(peerId)) voice.pendingICE.set(peerId, []);
          voice.pendingICE.get(peerId).push(sig.candidate);
        }
      }
    } catch (err) {
      console.warn("[WatchTogether voice] signal handling failed:", err);
    }
  }

  function handleVoiceStateMsg(msg) {
    // Track who is voice-active in the room
    if (Array.isArray(msg.activeUserIds)) {
      voice.activePeerIds = new Set(msg.activeUserIds.filter((id) => id !== myUserId));
    }
    // Tear down peer connections for users who turned off voice
    for (const peerId of Array.from(voice.peers.keys())) {
      if (!voice.activePeerIds.has(peerId)) {
        try { voice.peers.get(peerId).close(); } catch {}
        voice.peers.delete(peerId);
        removeAudioFor(peerId);
      }
    }
    // If we're active and someone new joined voice, open a peer (tie-break by id)
    if (voice.active && msg.userId !== myUserId && msg.active) {
      if (myUserId && myUserId < msg.userId) {
        ensurePeer(msg.userId, true);
      } else {
        ensurePeer(msg.userId, false);
      }
    }
    updateVoiceBadge();
  }

  function updateMicButton() {
    if (!overlayPanel) return;
    const btn = overlayPanel.querySelector("#wt-mic");
    if (!btn) return;
    btn.classList.toggle("wt-mic-on", voice.active);
    const lbl = overlayPanel.querySelector("#wt-mic-label");
    if (lbl) lbl.textContent = voice.active ? "Mute" : "Voice";
  }

  function updateVoiceBadge() {
    if (!overlayPanel) return;
    const badge = overlayPanel.querySelector("#wt-voice-active");
    if (!badge) return;
    const total = voice.activePeerIds.size + (voice.active ? 1 : 0);
    // A monochrome glyph, not an emoji: the rest of the panel is inline SVG and a colour
    // emoji next to it looks like it wandered in from another product.
    badge.textContent = total > 0 ? `${total} on voice` : "";
  }

  // ============================================================
  // Hotkey - tap to open (click mode) or hold to show (hold mode)
  // ============================================================

  function loadHotkeyConfig() {
    chrome.storage.local.get(["overlayMode", "overlayHotkey", "voiceQuality"], (data) => {
      if (data.overlayMode === "click" || data.overlayMode === "hold") {
        overlayMode = data.overlayMode;
      }
      if (typeof data.overlayHotkey === "string" && data.overlayHotkey) {
        overlayHotkey = data.overlayHotkey;
      }
      if (data.voiceQuality === "media" || data.voiceQuality === "voice") {
        voiceQuality = data.voiceQuality;
      }
    });
  }

  // Match `key` representations the way they're stored in settings (a single
  // displayable key - letters, digits, or punctuation like "\\"). Modifier-only
  // hotkeys are not supported in V1 - just one key.
  function matchesHotkey(e) {
    if (!overlayHotkey) return false;
    // Don't trigger while typing in an input/textarea anywhere on the page
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return false;
    // e.key is reliable for printable keys; lowercase to be case-insensitive for letters
    const pressed = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const want = overlayHotkey.length === 1 ? overlayHotkey.toLowerCase() : overlayHotkey;
    return pressed === want;
  }

  // A fullscreen video is painted in the browser's top layer, and only elements INSIDE
  // the fullscreen element are painted with it. The panel lived on document.body, so it
  // was there, toggling, posting messages, and completely invisible from the moment
  // anyone went fullscreen: which is exactly when people actually watch. The toolbar
  // button never had this problem because it is injected into the player's own controls.
  // Follow the fullscreen element in and back out again.
  function currentFullscreenHost() {
    const doc = /** @type {any} */ (document);
    // Safari and older WebKit builds still only expose the prefixed property.
    return doc.fullscreenElement || doc.webkitFullscreenElement || null;
  }

  function reparentPanel() {
    if (!overlayPanel) return;
    const host = currentFullscreenHost() || document.body;
    if (overlayPanel.parentNode === host) return;
    host.appendChild(overlayPanel);
  }

  let fullscreenTrackingBound = false;
  function trackFullscreenHost() {
    reparentPanel();
    if (fullscreenTrackingBound) return;
    fullscreenTrackingBound = true;
    document.addEventListener("fullscreenchange", reparentPanel, true);
    document.addEventListener("webkitfullscreenchange", reparentPanel, true);
  }

  // Everything the panel reveals rather than shows. The default surface is deliberately
  // three things: the code, who is here, and chat. That is the whole job for most people.
  // Everything else lives one click away and REMEMBERS whether it was opened, so somebody
  // who wants the detail opens it once and never thinks about it again, while somebody who
  // does not never sees it.
  function wireProgressiveDisclosure() {
    const membersToggle = overlayPanel.querySelector("#wt-members-toggle");
    const membersList = overlayPanel.querySelector("#wt-members");
    const advanced = overlayPanel.querySelector("#wt-advanced");

    membersToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = membersList.hasAttribute("hidden");
      membersList.toggleAttribute("hidden", !open);
      membersToggle.setAttribute("aria-expanded", String(open));
      membersToggle.classList.toggle("wt-open", open);
      chrome.storage.local.set({ wtMembersOpen: open });
      if (open) renderMembers();
    });

    advanced.addEventListener("toggle", () => {
      chrome.storage.local.set({ wtAdvancedOpen: advanced.open });
    });

    chrome.storage.local.get(
      ["wtMembersOpen", "wtAdvancedOpen", "syncOffset", "overlayHotkey", "serverUrl"],
      /** @param {any} d */ (d) => {
        if (d.wtMembersOpen) {
          membersList.removeAttribute("hidden");
          membersToggle.setAttribute("aria-expanded", "true");
          membersToggle.classList.add("wt-open");
        }
        if (d.wtAdvancedOpen) advanced.open = true;
        syncOffset = typeof d.syncOffset === "number" ? d.syncOffset : 0;
        const offsetInput = overlayPanel.querySelector("#wt-offset");
        if (offsetInput) offsetInput.value = String(syncOffset);
        const hotkeyInput = overlayPanel.querySelector("#wt-hotkey");
        if (hotkeyInput) hotkeyInput.value = describeHotkey(d.overlayHotkey || overlayHotkey);
        const serverInput = overlayPanel.querySelector("#wt-server");
        if (serverInput) serverInput.value = d.serverUrl || "";
        const serverHint = overlayPanel.querySelector("#wt-server .wt-adv-hint");
        if (serverHint) serverHint.textContent = "";
      }
    );

    wireOffsetControls();
    wireHotkeyCapture();
    wireServerControls();
    wireModeControl();
    renderModeControl();
  }

  // Only the host can move this, and the buttons say so by being disabled rather than by
  // silently doing nothing when a guest presses them.
  function wireModeControl() {
    const seg = overlayPanel.querySelector("#wt-mode-seg");
    seg.addEventListener("click", (e) => {
      e.stopPropagation();
      const btn = e.target.closest(".wt-seg-btn");
      if (!btn || btn.disabled) return;
      const mode = btn.dataset.mode === "host" ? "host" : "everyone";
      if (mode === roomMode) return;
      safePost({ type: "set-mode", mode });
    });
  }

  function describeHotkey(key) {
    if (!key) return "";
    if (key === " ") return "Space";
    if (key === "\\") return "Backslash";
    return key.length === 1 ? key.toUpperCase() : key;
  }

  // A per-viewer offset. Two people watching the same film from different sources have
  // timelines that do not line up: a different rip, a region cut, a version with the
  // adverts still in. Without this the room and the viewer simply fight forever, each
  // dragging the other back. The offset is local: the room's timeline stays canonical and
  // this viewer is shifted against it.
  function wireOffsetControls() {
    const input = overlayPanel.querySelector("#wt-offset");
    const commit = (value) => {
      const n = Number(value);
      syncOffset = Number.isFinite(n) ? Math.max(-600, Math.min(600, n)) : 0;
      input.value = String(syncOffset);
      chrome.storage.local.set({ syncOffset });
      addSystemMsg(
        syncOffset === 0
          ? "Offset cleared, following the room exactly"
          : `Offset set: your video sits ${Math.abs(syncOffset)}s ${syncOffset > 0 ? "ahead of" : "behind"} the room`
      );
      window.__wtCore?.setOffset?.(syncOffset);
      window.__wtCore?.resync?.();
    };

    input.addEventListener("change", () => commit(input.value));
    overlayPanel.querySelector("#wt-offset-up").addEventListener("click", (e) => {
      e.stopPropagation();
      commit(Number(input.value || 0) + 0.5);
    });
    overlayPanel.querySelector("#wt-offset-down").addEventListener("click", (e) => {
      e.stopPropagation();
      commit(Number(input.value || 0) - 0.5);
    });
    // The most useful way to set this is not to type a number: it is to line the picture up
    // by hand and then tell the extension that where you are now is correct.
    overlayPanel.querySelector("#wt-offset-measure").addEventListener("click", (e) => {
      e.stopPropagation();
      const drift = window.__wtCore?.getDrift?.();
      if (typeof drift !== "number") {
        addSystemMsg("No recent reading from the room yet. Give it a few seconds.");
        return;
      }
      commit(Math.round((syncOffset - drift) * 2) / 2);
    });
  }

  function wireHotkeyCapture() {
    const input = overlayPanel.querySelector("#wt-hotkey");
    const hint = overlayPanel.querySelector("#wt-hotkey-hint");
    // Single letters are how video players do their own shortcuts, so taking one means the
    // viewer's key does two things at once on every site they watch on.
    const COLLIDES = new Set(["f", "k", "j", "l", "c", "t", "i", "m", " "]);
    input.addEventListener("keydown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = e.key;
      if (["Shift", "Control", "Alt", "Meta", "Tab", "Escape", "Enter"].includes(key)) return;
      if (COLLIDES.has(key.toLowerCase())) {
        hint.textContent = `${describeHotkey(key)} is already a player shortcut. Pick something else.`;
        return;
      }
      hint.textContent = "";
      overlayHotkey = key;
      input.value = describeHotkey(key);
      chrome.storage.local.set({ overlayHotkey: key });
    });
  }

  function wireServerControls() {
    const input = overlayPanel.querySelector("#wt-server");
    overlayPanel.querySelector("#wt-server-save").addEventListener("click", (e) => {
      e.stopPropagation();
      const url = input.value.trim();
      if (url && !window.__wtConfig.isValidServerUrl(url)) {
        addSystemMsg("A server address has to start with wss://");
        return;
      }
      safePost({ type: "set-server-url", url });
      addSystemMsg(url ? "Connecting to that server" : "Back to the default server");
    });
    overlayPanel.querySelector("#wt-server-reset").addEventListener("click", (e) => {
      e.stopPropagation();
      input.value = "";
      safePost({ type: "set-server-url", url: "" });
      addSystemMsg("Back to the default server");
    });
  }

  function setupHotkeyListeners() {
    document.addEventListener("keydown", (e) => {
      if (!matchesHotkey(e)) return;
      if (e.repeat) return; // ignore key-repeat firing
      e.preventDefault();
      // preventDefault stops the BROWSER default. It does nothing about the page's own
      // key handler, so holding the overlay key on YouTube also toggled play/pause (space)
      // or native fullscreen (f) underneath the panel. Stop the event here.
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (overlayMode === "hold") {
        hotkeyHeld = true;
        showPanel();
      } else {
        // click mode: tap toggles
        togglePanel();
      }
    }, true);
    document.addEventListener("keyup", (e) => {
      if (!matchesHotkey(e)) return;
      if (overlayMode === "hold" && hotkeyHeld) {
        hotkeyHeld = false;
        hidePanel();
      }
    }, true);
    // React to settings changes from the popup live
    chrome.storage.onChanged.addListener(/** @param {any} changes */ (changes) => {
      if (changes.overlayMode) overlayMode = changes.overlayMode.newValue || "click";
      if (changes.overlayHotkey) overlayHotkey = changes.overlayHotkey.newValue || HOTKEY_DEFAULT;
      if (changes.voiceQuality) {
        voiceQuality = changes.voiceQuality.newValue === "voice" ? "voice" : "media";
        // If voice is currently active, the new constraint applies on next start.
        // Don't tear down a live call just because settings changed.
      }
    });
  }

  function showPanel() {
    createPanel();
    // Also reparent here, not only on the fullscreenchange event. The event is the normal
    // path, but if a browser fires it late, inconsistently, or not at all for a given kind
    // of fullscreen, the failure is total: the panel opens somewhere the viewer cannot see
    // and they conclude the button is broken. Checking again at the moment we open costs
    // nothing and makes that impossible.
    reparentPanel();
    overlayPanel.classList.add("wt-visible");
    safePost({ type: "get-state" });
    syncMemberCountDom();
  }

  // Site-specific selectors for where to inject the button
  const SITE_CONFIGS = {
    youtube: {
      match: () => location.hostname.includes("youtube.com"),
      controls: ".ytp-right-controls",
      position: "prepend",
    },
    netflix: {
      match: () => location.hostname.includes("netflix.com"),
      controls: ".watch-video--bottom-controls-container .PlayerControlsNeo__button-control-row, [data-uia='controls-standard']",
      position: "append",
    },
    amazon: {
      match: () => location.hostname.includes("amazon") || location.hostname.includes("primevideo"),
      controls: ".atvwebplayersdk-hideabletopbuttons-container, .webPlayerSDKContainer .topPanel",
      position: "append",
    },
    jiohotstar: {
      match: () => location.hostname.includes("hotstar") || location.hostname.includes("jiohotstar"),
      controls: ".bePfJE, .control-bar, [class*='controls-bar'], [class*='ControlBar']",
      position: "append",
    },
    disney: {
      match: () => location.hostname.includes("disneyplus"),
      controls: ".controls__right, .btm-media-overlays-container",
      position: "prepend",
    },
    hbo: {
      match: () => location.hostname.includes("max.com") || location.hostname.includes("hbomax"),
      controls: "[class*='PlayerControls'] [class*='Right'], .default-ltr-cache-1953ooj",
      position: "prepend",
    },
    generic: {
      match: () => true,
      controls: null,
      position: "append",
    },
  };

  function getSiteConfig() {
    for (const [name, config] of Object.entries(SITE_CONFIGS)) {
      if (name !== "generic" && config.match()) return config;
    }
    return SITE_CONFIGS.generic;
  }

  // Create the floating button
  function createButton() {
    if (overlayBtn) return overlayBtn;

    overlayBtn = document.createElement("button");
    overlayBtn.id = "wt-overlay-btn";
    overlayBtn.title = "Watch Together";
    overlayBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v-2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 00-3-3.87"/>
        <path d="M16 3.13a4 4 0 010 7.75"/>
      </svg>
    `;
    overlayBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      togglePanel();
    });

    return overlayBtn;
  }

  // Create the panel that opens when you click the button
  function createPanel() {
    if (overlayPanel) return overlayPanel;

    overlayPanel = document.createElement("div");
    overlayPanel.id = "wt-overlay-panel";
    overlayPanel.innerHTML = `
      <div class="wt-panel-header">
        <span class="wt-panel-title">Watch Together</span>
        <span class="wt-panel-status" id="wt-status">Offline</span>
        <button class="wt-panel-close" id="wt-close">&times;</button>
      </div>
      <div id="wt-view-landing" class="wt-view wt-active">
        <input type="text" id="wt-name" class="wt-input" placeholder="Your name" maxlength="30">
        <input type="text" id="wt-custom-name" class="wt-input" placeholder="Room name (optional, e.g. yash-and-anshul)" maxlength="32" autocomplete="off">
        <button class="wt-btn wt-btn-primary" id="wt-create">Create Room</button>
        <div class="wt-divider">or</div>
        <input type="text" id="wt-code" class="wt-input" placeholder="Room code or name" maxlength="32" style="letter-spacing:1px;text-align:center">
        <button class="wt-btn wt-btn-secondary" id="wt-join">Join Room</button>
      </div>
      <div id="wt-view-room" class="wt-view">
        <div class="wt-room-info">
          <span class="wt-room-code" id="wt-room-code"></span>
          <button class="wt-watchers" id="wt-members-toggle" aria-expanded="false" title="Who is here">
            <span id="wt-member-count">1</span> watching
            <svg class="wt-chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
        </div>
        <div class="wt-actions">
          <button class="wt-btn-small" id="wt-copy-code">Copy Code</button>
          <button class="wt-btn-small" id="wt-copy-link">Copy Link</button>
        </div>
        <div class="wt-members" id="wt-members" hidden></div>
        <div class="wt-voice-active" id="wt-voice-active"></div>
        <div class="wt-chat">
          <div class="wt-chat-messages" id="wt-messages"></div>
          <div class="wt-typing" id="wt-typing"></div>
          <div class="wt-chat-input-row">
            <input type="text" id="wt-chat-input" class="wt-input wt-chat-field" placeholder="Message..." maxlength="500">
            <button class="wt-send" id="wt-send">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
        </div>
        <details class="wt-advanced" id="wt-advanced">
          <summary class="wt-advanced-summary">
            <svg class="wt-chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="9 18 15 12 9 6"/></svg>
            Advanced
          </summary>
          <div class="wt-advanced-body">
            <div class="wt-sync-row">
              <span class="wt-sync-health" id="wt-sync-health" title="How far your video is from the room">Sync: checking...</span>
              <button class="wt-btn-small" id="wt-resync" title="Snap to the room's current position">Resync</button>
            </div>
            <div class="wt-adv-field" id="wt-mode-field">
              <span class="wt-adv-label">Who can control playback</span>
              <div class="wt-seg" id="wt-mode-seg">
                <button class="wt-seg-btn" data-mode="everyone">Everyone</button>
                <button class="wt-seg-btn" data-mode="host">Host only</button>
              </div>
              <span class="wt-adv-hint" id="wt-mode-hint"></span>
            </div>
            <div class="wt-adv-field">
              <span class="wt-adv-label">My video runs ahead of the room by</span>
              <div class="wt-offset">
                <button class="wt-step" id="wt-offset-down" title="Less">-</button>
                <input type="number" id="wt-offset" class="wt-input wt-offset-input" step="0.5" value="0">
                <span class="wt-offset-unit">s</span>
                <button class="wt-step" id="wt-offset-up" title="More">+</button>
                <button class="wt-btn-small" id="wt-offset-measure" title="Use the difference the room is showing right now">Use current</button>
              </div>
              <span class="wt-adv-hint">For when your copy is not identical to everyone else's: a different rip, a region cut, or a version without the adverts.</span>
            </div>
            <div class="wt-adv-field">
              <span class="wt-adv-label">Show this panel with</span>
              <input type="text" id="wt-hotkey" class="wt-input wt-hotkey-input" readonly placeholder="Click, then press a key">
              <span class="wt-adv-hint" id="wt-hotkey-hint"></span>
            </div>
            <div class="wt-adv-field">
              <span class="wt-adv-label">Sync server</span>
              <input type="text" id="wt-server" class="wt-input" placeholder="wss://..." spellcheck="false">
              <div class="wt-actions">
                <button class="wt-btn-small" id="wt-server-save">Save server</button>
                <button class="wt-btn-small" id="wt-server-reset">Use default</button>
              </div>
            </div>
            <div class="wt-actions">
              <button class="wt-btn-small" id="wt-pip" title="Picture-in-picture">Picture in picture</button>
              <button class="wt-btn-small" id="wt-mic" title="Toggle voice">
                <span id="wt-mic-label">Voice</span>
              </button>
            </div>
          </div>
        </details>
        <button class="wt-btn-leave" id="wt-leave">Leave</button>
      </div>
    `;

    document.body.appendChild(overlayPanel);
    trackFullscreenHost();

    wireProgressiveDisclosure();

    // Wire up events
    overlayPanel.querySelector("#wt-close").addEventListener("click", (e) => {
      e.stopPropagation();
      hidePanel();
    });
    overlayPanel.querySelector("#wt-create").addEventListener("click", (e) => {
      e.stopPropagation();
      createRoom();
    });
    overlayPanel.querySelector("#wt-join").addEventListener("click", (e) => {
      e.stopPropagation();
      joinRoom();
    });
    overlayPanel.querySelector("#wt-code").addEventListener("keydown", (e) => {
      if (e.key === "Enter") joinRoom();
    });

    const copyCodeBtn = overlayPanel.querySelector("#wt-copy-code");
    copyCodeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!currentRoom) { flashText(copyCodeBtn, "No room"); return; }
      const ok = await safeCopy(currentRoom);
      flashText(copyCodeBtn, ok ? "Copied!" : "Failed");
    });

    const copyLinkBtn = overlayPanel.querySelector("#wt-copy-link");
    copyLinkBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!currentRoom) { flashText(copyLinkBtn, "No room"); return; }
      let link;
      try {
        const url = new URL(location.href);
        url.searchParams.set("wt_room", currentRoom);
        link = url.toString();
      } catch {
        link = `${location.href}${location.href.includes("?") ? "&" : "?"}wt_room=${currentRoom}`;
      }
      const ok = await safeCopy(link);
      flashText(copyLinkBtn, ok ? "Copied!" : "Failed");
    });

    overlayPanel.querySelector("#wt-send").addEventListener("click", (e) => {
      e.stopPropagation();
      sendChat();
    });
    const chatInputEl = overlayPanel.querySelector("#wt-chat-input");
    chatInputEl.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Enter") return;
      // IME composition guard - emoji picker / IME insertion may keep input value
      // unfinalized; sending now would lose the typed content. Defer until composition ends.
      if (e.isComposing || e.keyCode === 229) {
        pendingEnterSend = true;
        return;
      }
      sendChat();
    });
    chatInputEl.addEventListener("compositionend", () => {
      if (pendingEnterSend) {
        pendingEnterSend = false;
        // Wait one tick so input.value reflects the final composed text
        setTimeout(sendChat, 0);
      }
    });
    chatInputEl.addEventListener("input", () => {
      noteLocalTyping(chatInputEl.value.length > 0);
    });
    overlayPanel.querySelector("#wt-leave").addEventListener("click", (e) => {
      e.stopPropagation();
      leaveRoom();
    });

    overlayPanel.querySelector("#wt-mic").addEventListener("click", (e) => {
      e.stopPropagation();
      if (voice.active) stopVoice(); else startVoice();
    });

    overlayPanel.querySelector("#wt-pip").addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        const v = document.querySelector("video");
        if (!v) { addSystemMsg("No video found on this page"); return; }
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else if (typeof v.requestPictureInPicture === "function") {
          await v.requestPictureInPicture();
        } else {
          addSystemMsg("Picture-in-picture not supported on this video");
        }
      } catch (err) {
        addSystemMsg("PiP blocked - try the player's own button");
        console.warn("[WatchTogether] PiP failed:", err);
      }
    });

    // Sync health readout. Drift is measured by content.js on every correction; we just
    // render it, so an out-of-sync viewer can see it and fix it instead of guessing.
    function startSyncHealth() {
      const el = overlayPanel.querySelector("#wt-sync-health");
      if (!el) return;
      setInterval(() => {
        if (!window.__wtCore?.isInRoom()) {
          el.textContent = "Sync: not in a room";
          el.className = "wt-sync-health";
          return;
        }
        const drift = window.__wtCore.getDrift();
        if (drift === null) {
          el.textContent = "Sync: in sync";
          el.className = "wt-sync-health wt-sync-good";
          return;
        }
        const abs = Math.abs(drift);
        const dir = drift > 0 ? "behind" : "ahead";
        if (abs < 0.5) {
          el.textContent = "Sync: in sync";
          el.className = "wt-sync-health wt-sync-good";
        } else if (abs < 1.5) {
          el.textContent = `Sync: ${abs.toFixed(1)}s ${dir}, correcting`;
          el.className = "wt-sync-health wt-sync-warn";
        } else {
          el.textContent = `Sync: ${abs.toFixed(1)}s ${dir}`;
          el.className = "wt-sync-health wt-sync-bad";
        }
      }, 1000);
    }

    overlayPanel.querySelector("#wt-resync").addEventListener("click", (e) => {
      e.stopPropagation();
      if (!window.__wtCore?.isInRoom()) { addSystemMsg("Not in a room"); return; }
      window.__wtCore.resync();
      addSystemMsg("Resyncing to the room...");
    });

    // Voice ships disabled (see VOICE_ENABLED). Hide its surfaces rather than deleting
    // them, so re-enabling is a one-line change.
    if (!VOICE_ENABLED) {
      const micBtn = overlayPanel.querySelector("#wt-mic");
      if (micBtn) micBtn.style.display = "none";
      const voiceBadge = overlayPanel.querySelector("#wt-voice-active");
      if (voiceBadge) voiceBadge.style.display = "none";
    }

    startSyncHealth();

    // Stop all events from reaching the video player
    overlayPanel.addEventListener("click", (e) => e.stopPropagation());
    overlayPanel.addEventListener("keydown", (e) => e.stopPropagation());
    overlayPanel.addEventListener("keyup", (e) => e.stopPropagation());
    overlayPanel.addEventListener("mousedown", (e) => e.stopPropagation());

    return overlayPanel;
  }

  function togglePanel() {
    createPanel();
    overlayPanel.classList.toggle("wt-visible");
    // Refresh state from background each time the panel is shown so a stale UI is impossible
    if (overlayPanel.classList.contains("wt-visible")) {
      safePost({ type: "get-state" });
      syncMemberCountDom();
    }
    // Load saved name
    chrome.storage.local.get(["userName"], (data) => {
      const nameInput = overlayPanel.querySelector("#wt-name");
      if (data.userName && nameInput && !nameInput.value) {
        nameInput.value = data.userName;
      }
    });
  }

  // One place that writes the connection pill, so every path that learns the truth can
  // say it without duplicating the DOM work.
  function setStatusDom(connected) {
    if (!overlayPanel) return;
    const statusEl = overlayPanel.querySelector("#wt-status");
    if (!statusEl) return;
    statusEl.textContent = connected ? "Live" : "Offline";
    statusEl.className = `wt-panel-status ${connected ? "wt-live" : ""}`;
  }

  // Renders the member list. Deliberately shows only what we genuinely know: inventing a
  // confident-looking status we cannot actually measure would be worse than showing none.
  function renderMembers() {
    if (!overlayPanel) return;
    const list = overlayPanel.querySelector("#wt-members");
    if (!list) return;
    list.textContent = "";

    const entries = [...membersById.entries()];
    // Put yourself first: it is the row people look for.
    entries.sort(([idA], [idB]) => (idA === myUserId ? -1 : idB === myUserId ? 1 : 0));

    for (const [id, m] of entries) {
      const isYou = id === myUserId;
      const row = document.createElement("div");
      row.className = "wt-member";

      const dot = document.createElement("span");
      dot.className = "wt-member-dot" + (m.inAd ? " wt-member-away" : "");
      row.appendChild(dot);

      const name = document.createElement("span");
      name.className = "wt-member-name";
      name.textContent = isYou ? `${m.userName || "You"} (you)` : m.userName || "Someone";
      row.appendChild(name);

      const state = document.createElement("span");
      state.className = "wt-member-state";
      if (m.inAd) {
        state.textContent = "ad break";
      } else if (isYou) {
        const drift = window.__wtCore?.getDrift?.();
        state.textContent =
          typeof drift !== "number" ? "watching"
          : Math.abs(drift) < 0.5 ? "in sync"
          : `${drift > 0 ? "behind" : "ahead"} ${Math.abs(drift).toFixed(1)}s`;
      } else {
        state.textContent = "watching";
      }
      row.appendChild(state);

      if (isYou && iAmHost) {
        const badge = document.createElement("span");
        badge.className = "wt-member-badge";
        badge.textContent = "host";
        row.appendChild(badge);
      }
      if (isYou && iAmLeader) {
        const badge = document.createElement("span");
        badge.className = "wt-member-badge";
        badge.title = "Your player is the one keeping everyone else in step";
        badge.textContent = "syncing";
        row.appendChild(badge);
      }
      list.appendChild(row);
    }

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wt-member-empty";
      empty.textContent = "Nobody else yet. Send them the code.";
      list.appendChild(empty);
    }
  }

  // Only the host can change the control mode, so show the rest of the room what the
  // setting is without pretending they can move it.
  function renderModeControl() {
    if (!overlayPanel) return;
    const seg = overlayPanel.querySelector("#wt-mode-seg");
    const hint = overlayPanel.querySelector("#wt-mode-hint");
    if (!seg) return;
    for (const btn of seg.querySelectorAll(".wt-seg-btn")) {
      const active = btn.dataset.mode === roomMode;
      btn.classList.toggle("wt-seg-on", active);
      btn.disabled = !iAmHost;
      btn.setAttribute("aria-pressed", String(active));
    }
    if (hint) {
      hint.textContent = iAmHost
        ? ""
        : roomMode === "host"
          ? "The host is driving. You can still chat."
          : "Anyone here can play, pause and seek.";
    }
  }

  function syncMemberCountDom() {
    if (!overlayPanel) return;
    const el = overlayPanel.querySelector("#wt-member-count");
    if (el) el.textContent = memberCount;
    renderMembers();
  }

  function hidePanel() {
    if (overlayPanel) overlayPanel.classList.remove("wt-visible");
  }

  function showView(name) {
    const landing = overlayPanel.querySelector("#wt-view-landing");
    const room = overlayPanel.querySelector("#wt-view-room");
    landing.classList.toggle("wt-active", name === "landing");
    room.classList.toggle("wt-active", name === "room");
  }

  function createRoom() {
    const nameInput = overlayPanel.querySelector("#wt-name");
    const customNameInput = overlayPanel.querySelector("#wt-custom-name");
    const btn = overlayPanel.querySelector("#wt-create");
    const name = nameInput.value.trim();
    const customName = customNameInput ? customNameInput.value.trim() : "";
    if (!name) { nameInput.focus(); return; }
    withInFlight("create", btn, () => {
      userName = name;
      chrome.storage.local.set({ userName: name });
      safePost({ type: "create-room", userName: name, videoUrl: location.href, customName });
      return new Promise((resolve) => setTimeout(resolve, 4000));
    });
  }

  function joinRoom() {
    const codeInput = overlayPanel.querySelector("#wt-code");
    const nameInput = overlayPanel.querySelector("#wt-name");
    const btn = overlayPanel.querySelector("#wt-join");
    const code = codeInput.value.trim().toUpperCase();
    const name = nameInput.value.trim();
    if (!code || code.length < 4) { codeInput.focus(); return; }
    if (!name) { nameInput.focus(); return; }
    withInFlight("join", btn, () => {
      userName = name;
      chrome.storage.local.set({ userName: name });
      safePost({ type: "join-room", roomCode: code, userName: name });
      return new Promise((resolve) => setTimeout(resolve, 4000));
    });
  }

  function leaveRoom() {
    const btn = overlayPanel.querySelector("#wt-leave");
    withInFlight("leave", btn, () => {
      stopVoice();
      voice.activePeerIds.clear();
      updateVoiceBadge();
      safePost({ type: "leave-room" });
      inRoom = false;
      currentRoom = null;
      showView("landing");
      overlayPanel.querySelector("#wt-messages").innerHTML = "";
      updateButtonState();
      return new Promise((resolve) => setTimeout(resolve, 500));
    });
  }

  function sendChat() {
    const input = overlayPanel.querySelector("#wt-chat-input");
    const text = input.value.trim();
    if (!text) return;
    if (!safePost({ type: "chat", message: text })) {
      addSystemMsg("Couldn't send - reconnecting");
      return;
    }
    addChatMsg(userName, text, true);
    input.value = "";
    noteLocalTyping(false); // clear "typing…" for everyone
  }

  function addChatMsg(name, text, isOwn = false) {
    const container = overlayPanel?.querySelector("#wt-messages");
    if (!container) return;
    const div = document.createElement("div");
    div.className = "wt-msg";
    const nameEl = document.createElement("span");
    nameEl.className = isOwn ? "wt-msg-name wt-own" : "wt-msg-name";
    nameEl.textContent = name;
    const textEl = document.createElement("span");
    textEl.className = "wt-msg-text";
    textEl.textContent = " " + text;
    div.appendChild(nameEl);
    div.appendChild(textEl);
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    while (container.children.length > 100) {
      container.removeChild(container.firstChild);
    }
  }

  function addSystemMsg(text) {
    const container = overlayPanel?.querySelector("#wt-messages");
    if (!container) return;
    // Same cap as chat. Without it, one peer toggling captions repeatedly grew this list
    // for the whole session: cc-state is relayed to everyone and rendered here every time.
    const div = document.createElement("div");
    div.className = "wt-msg wt-sys";
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    while (container.children.length > 100) {
      container.removeChild(container.firstChild);
    }
  }

  // ---------- Typing indicator ----------
  // Throttle outgoing typing events to once every TYPING_THROTTLE_MS, send a
  // final "stopped typing" after TYPING_IDLE_MS of no input changes.
  const TYPING_THROTTLE_MS = 1500;
  const TYPING_IDLE_MS = 3000;
  const typing = {
    lastSentAt: 0,
    lastSentValue: false,
    idleTimer: null,
    activePeers: new Map(), // userId -> { userName, expiresAt, timer }
  };

  function noteLocalTyping(hasContent) {
    const now = Date.now();
    const want = !!hasContent;
    if (want && (now - typing.lastSentAt > TYPING_THROTTLE_MS || !typing.lastSentValue)) {
      safePost({ type: "chat-typing", isTyping: true });
      typing.lastSentAt = now;
      typing.lastSentValue = true;
    }
    if (typing.idleTimer) clearTimeout(typing.idleTimer);
    if (want) {
      typing.idleTimer = setTimeout(() => {
        if (typing.lastSentValue) {
          safePost({ type: "chat-typing", isTyping: false });
          typing.lastSentValue = false;
        }
      }, TYPING_IDLE_MS);
    } else if (typing.lastSentValue) {
      // Input was cleared (e.g. message sent) - let peers know immediately
      safePost({ type: "chat-typing", isTyping: false });
      typing.lastSentValue = false;
    }
  }

  function handleRemoteTyping(msg) {
    if (!msg.userId || msg.userId === myUserId) return;
    if (msg.isTyping) {
      const existing = typing.activePeers.get(msg.userId);
      if (existing && existing.timer) clearTimeout(existing.timer);
      const timer = setTimeout(() => {
        typing.activePeers.delete(msg.userId);
        renderTypingIndicator();
      }, TYPING_IDLE_MS + 500);
      typing.activePeers.set(msg.userId, { userName: msg.userName, timer });
    } else {
      const existing = typing.activePeers.get(msg.userId);
      if (existing && existing.timer) clearTimeout(existing.timer);
      typing.activePeers.delete(msg.userId);
    }
    renderTypingIndicator();
  }

  function renderTypingIndicator() {
    if (!overlayPanel) return;
    const el = overlayPanel.querySelector("#wt-typing");
    if (!el) return;
    const names = Array.from(typing.activePeers.values()).map((p) => p.userName).filter(Boolean);
    if (names.length === 0) { el.textContent = ""; return; }
    if (names.length === 1) el.textContent = `${names[0]} is typing…`;
    else if (names.length === 2) el.textContent = `${names[0]} and ${names[1]} are typing…`;
    else el.textContent = `${names.length} people are typing…`;
  }

  function flashText(el, text) {
    if (!el) return;
    if (el._flashTimer) {
      clearTimeout(el._flashTimer);
      if (el._flashOrig != null) el.textContent = el._flashOrig;
    }
    el._flashOrig = el.textContent;
    el.textContent = text;
    el._flashTimer = setTimeout(() => {
      if (el._flashOrig != null) el.textContent = el._flashOrig;
      el._flashTimer = null;
      el._flashOrig = null;
    }, 1200);
  }

  function updateButtonState() {
    if (!overlayBtn) return;
    if (inRoom) {
      overlayBtn.classList.add("wt-active-room");
    } else {
      overlayBtn.classList.remove("wt-active-room");
    }
  }

  // Connect to background
  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: "overlay" });
    } catch {
      port = null;
      setTimeout(connectPort, 2000);
      return;
    }
    chrome.runtime.lastError;

    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case "room-created":
          settleInFlight("create");
          currentRoom = msg.roomCode;
          myUserId = msg.userId || myUserId;
          inRoom = true;
          memberCount = 1;
          iAmHost = true;
          roomMode = msg.mode || "everyone";
          membersById.clear();
          membersById.set(myUserId, { userName: userName || "You", inAd: false });
          renderModeControl();
          if (overlayPanel) {
            overlayPanel.querySelector("#wt-room-code").textContent = msg.roomCode;
            syncMemberCountDom();
            showView("room");
          }
          updateButtonState();
          addSystemMsg("Room created");
          break;

        case "room-joined":
          settleInFlight("create", "join");
          currentRoom = msg.roomCode;
          myUserId = msg.userId || myUserId;
          inRoom = true;
          memberCount = msg.members?.length || 1;
          iAmHost = !!msg.isHost;
          roomMode = msg.mode || "everyone";
          membersById.clear();
          for (const m of msg.members || []) membersById.set(m.id, { userName: m.userName, inAd: false });
          if (!membersById.has(myUserId)) membersById.set(myUserId, { userName: userName || "You", inAd: false });
          renderModeControl();
          if (overlayPanel) {
            overlayPanel.querySelector("#wt-room-code").textContent = msg.roomCode;
            syncMemberCountDom();
            showView("room");
          }
          updateButtonState();
          addSystemMsg(`Joined with ${memberCount} watching`);
          break;

        case "member-joined":
          memberCount = typeof msg.memberCount === "number" ? msg.memberCount : memberCount + 1;
          if (msg.userId) membersById.set(msg.userId, { userName: msg.userName, inAd: false });
          syncMemberCountDom();
          addSystemMsg(`${msg.userName} joined`);
          break;

        // The room ended somewhere else: the user left from the popup, or the party was
        // attached to a different tab. Nothing in this panel would ever have found out, so
        // it sat there showing a room code, a member count and a live chat box for a room
        // this tab is no longer in.
        case "room-ended":
          settleInFlight("create", "join", "leave");
          inRoom = false;
          currentRoom = null;
          memberCount = 1;
          membersById.clear();
          iAmHost = false;
          iAmLeader = false;
          stopVoice();
          voice.activePeerIds.clear();
          updateVoiceBadge();
          if (overlayPanel) {
            showView("landing");
            overlayPanel.querySelector("#wt-messages").innerHTML = "";
          }
          updateButtonState();
          break;

        case "member-left":
          memberCount = typeof msg.memberCount === "number" ? msg.memberCount : Math.max(1, memberCount - 1);
          if (msg.userId) membersById.delete(msg.userId);
          syncMemberCountDom();
          addSystemMsg(`${msg.userName} left`);
          // Clean up any lingering peer connection if they were on voice
          if (voice.peers.has(msg.userId)) {
            try { voice.peers.get(msg.userId).close(); } catch {}
            voice.peers.delete(msg.userId);
            removeAudioFor(msg.userId);
            voice.activePeerIds.delete(msg.userId);
            updateVoiceBadge();
          }
          break;

        case "chat":
          addChatMsg(msg.userName, msg.message);
          // Implicit "stopped typing" on incoming message
          handleRemoteTyping({ userId: msg.userId, userName: msg.userName, isTyping: false });
          break;

        case "chat-typing":
          handleRemoteTyping(msg);
          break;

        case "cc-state":
          // The on-page toast is shown by content.js; surface a chat system line too
          addSystemMsg(`${msg.userName || "Someone"} turned captions ${msg.active ? "ON" : "OFF"}`);
          break;

        case "voice-state":
          handleVoiceStateMsg(msg);
          break;

        case "voice-signal":
          handleVoiceSignal(msg);
          break;

        case "connection-status":
          setStatusDom(msg.connected);
          break;

        case "state":
          setStatusDom(msg.connected);
          if (msg.userId) myUserId = msg.userId;
          if (msg.currentRoom) {
            currentRoom = msg.currentRoom;
            inRoom = true;
            // The whole point of asking for state on open is that a stale panel is
            // impossible, but the member count was never read back, so a reinjected
            // content script sat on its default of 1 while the popup showed the truth.
            if (Array.isArray(msg.members) && msg.members.length) {
              memberCount = msg.members.length;
            } else if (typeof msg.memberCount === "number") {
              memberCount = msg.memberCount;
            }
            if (overlayPanel) {
              overlayPanel.querySelector("#wt-room-code").textContent = msg.currentRoom;
              showView("room");
            }
            syncMemberCountDom();
            updateButtonState();
          } else {
            inRoom = false;
          }
          break;

        // A message the background could not put on the wire. Silence here is what makes
        // the product feel broken: you typed, it looked sent, nobody ever saw it.
        case "send-failed":
          addSystemMsg(msg.message || "Not sent, still reconnecting.");
          break;

        // Who is doing what. This is what turns "it looks broken" into "Anshul is in an
        // ad break and will be back", which is the difference between trusting the thing
        // and closing it.
        case "presence": {
          const entry = membersById.get(msg.userId);
          const next = {
            userName: msg.userName || entry?.userName || "Someone",
            inAd: msg.state === "ad",
            state: msg.state || "watching",
            drift: typeof msg.drift === "number" ? msg.drift : null,
          };
          membersById.set(msg.userId, next);
          renderMembers();
          if (msg.userId !== myUserId) {
            if (next.inAd) addSystemMsg(`${next.userName} is in an ad break`);
            else if (entry && entry.inAd) addSystemMsg(`${next.userName} is back`);
          }
          break;
        }

        case "mode-changed":
          roomMode = msg.mode || "everyone";
          renderModeControl();
          addSystemMsg(
            roomMode === "host"
              ? "Only the host can control playback now"
              : "Everyone can control playback now"
          );
          break;

        case "host-transferred":
          iAmHost = !!msg.isHost;
          renderModeControl();
          renderMembers();
          if (iAmHost) addSystemMsg("You are the host now");
          break;

        case "heartbeat-role":
          iAmLeader = !!msg.isLeader;
          renderMembers();
          break;

        case "error":
          // Free every button waiting on an answer: this WAS the answer.
          settleInFlight("create", "join", "leave");
          addSystemMsg(msg.message);
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      // The relay just went away. Nothing else will tell the panel, so it used to keep
      // showing a green "Live" for the whole reconnect gap.
      setStatusDom(false);
      setTimeout(connectPort, 2000);
    });

    safePost({ type: "get-state" });
  }

  // Inject button into video player controls
  function injectButton() {
    if (document.getElementById("wt-overlay-btn")) return;

    const config = getSiteConfig();
    const btn = createButton();

    if (config.controls) {
      const controls = document.querySelector(config.controls);
      if (controls) {
        if (config.position === "prepend") {
          controls.insertBefore(btn, controls.firstChild);
        } else {
          controls.appendChild(btn);
        }
        return true;
      }
    }

    // Fallback: float the button over the video
    btn.classList.add("wt-floating");
    const video = document.querySelector("video");
    if (video) {
      const container = video.closest("[class*='player']") || video.parentElement;
      if (container) {
        /** @type {any} */ (container).style.position = /** @type {any} */ (container).style.position || "relative";
        container.appendChild(btn);
        return true;
      }
    }

    return false;
  }

  // Inject styles
  function injectStyles() {
    if (document.getElementById("wt-overlay-styles")) return;

    const style = document.createElement("style");
    style.id = "wt-overlay-styles";
    style.textContent = `
      #wt-overlay-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        background: transparent;
        border: none;
        color: #fff;
        cursor: pointer;
        opacity: 0.8;
        transition: opacity 0.15s, transform 0.15s;
        padding: 0;
        z-index: 2147483646;
        position: relative;
        flex-shrink: 0;
      }
      #wt-overlay-btn:hover { opacity: 1; transform: scale(1.1); }
      #wt-overlay-btn.wt-active-room { opacity: 1; }
      #wt-overlay-btn.wt-active-room::after {
        content: '';
        position: absolute;
        bottom: 4px;
        left: 50%;
        transform: translateX(-50%);
        width: 6px;
        height: 6px;
        background: #a78bfa;
        border-radius: 50%;
      }
      #wt-overlay-btn.wt-floating {
        position: absolute;
        top: 12px;
        right: 12px;
        background: rgba(0,0,0,0.6);
        border-radius: 8px;
        width: 40px;
        height: 40px;
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
      }

      #wt-overlay-panel {
        position: fixed;
        top: 60px;
        right: 16px;
        width: 300px;
        /* Zoom robustness. At 200% browser zoom the viewport is half as many CSS pixels
           wide, so a fixed 300px panel with a fixed offset can end up wider or taller than
           the screen with no way to reach the bottom of it. Cap against the viewport and
           let the body scroll instead. Everything here is in px on purpose: rem or em
           would inherit the host page's root font size, and sites set that to all sorts of
           things. */
        max-width: calc(100vw - 32px);
        max-height: calc(100vh - 76px);
        flex-direction: column;
        background: #1c1c1e;
        border-radius: 12px;
        box-shadow: 0 12px 48px rgba(0,0,0,0.5);
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
        color: #fff;
        overflow: hidden;
        display: none;
        -webkit-font-smoothing: antialiased;
      }
      /* flex, not block: the panel is a column with a header that stays put and a body
         that scrolls, which is what keeps it usable when the content is long or the
         viewer is zoomed in and the viewport is short. */
      #wt-overlay-panel.wt-visible { display: flex; animation: wt-slide-in 0.2s ease-out; }
      @keyframes wt-slide-in {
        from { opacity: 0; transform: translateY(-8px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .wt-panel-header {
        display: flex;
        align-items: center;
        padding: 12px 14px;
        border-bottom: 0.5px solid rgba(84,84,88,0.35);
        gap: 8px;
      }
      .wt-panel-title { font-size: 14px; font-weight: 700; flex: 1; }
      .wt-panel-status {
        font-size: 11px;
        font-weight: 500;
        color: rgba(235,235,245,0.4);
      }
      .wt-panel-status.wt-live { color: #30d158; }
      .wt-panel-close {
        background: none;
        border: none;
        color: rgba(235,235,245,0.4);
        font-size: 20px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
      }
      .wt-panel-close:hover { color: #fff; }

      .wt-view { display: none; padding: 14px; }
      .wt-view.wt-active { display: block; }

      .wt-input {
        width: 100%;
        padding: 10px 12px;
        border: none;
        border-radius: 8px;
        background: rgba(120,120,128,0.24);
        color: #fff;
        font-family: inherit;
        font-size: 14px;
        outline: none;
        margin-bottom: 8px;
        box-sizing: border-box;
      }
      .wt-input::placeholder { color: rgba(235,235,245,0.3); }
      .wt-input:focus { background: rgba(120,120,128,0.36); }

      .wt-btn {
        width: 100%;
        padding: 10px;
        border: none;
        border-radius: 8px;
        font-family: inherit;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: opacity 0.15s;
      }
      .wt-btn:hover { opacity: 0.85; }
      .wt-btn:active { transform: scale(0.98); }
      .wt-btn-primary {
        background: linear-gradient(135deg, #7c3aed, #a78bfa);
        color: #fff;
      }
      .wt-btn-secondary {
        background: rgba(120,120,128,0.24);
        color: #fff;
      }

      .wt-divider {
        text-align: center;
        font-size: 12px;
        color: rgba(235,235,245,0.3);
        margin: 10px 0;
      }

      /* The scrolling region, so a tall panel at high zoom stays reachable. */
      .wt-view {
        overflow-y: auto;
        overscroll-behavior: contain;
      }

      .wt-room-info {
        text-align: center;
        margin-bottom: 10px;
      }

      /* ---------- who is here ---------- */
      /* The member list is the single change that makes this feel trustworthy. A count
         answers "is anyone else there". It does not answer the question people actually
         ask when something looks wrong, which is "is it me, or is it them". */
      .wt-watchers {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        border: none;
        background: none;
        padding: 2px 4px;
        border-radius: 5px;
        font-family: inherit;
        font-size: 12px;
        color: rgba(235,235,245,0.5);
        cursor: pointer;
      }
      .wt-watchers:hover { color: rgba(235,235,245,0.8); background: rgba(120,120,128,0.18); }
      .wt-watchers .wt-chev { transition: transform 0.15s; }
      .wt-watchers.wt-open .wt-chev { transform: rotate(180deg); }

      .wt-members {
        margin: 0 0 10px;
        padding: 6px;
        border-radius: 8px;
        background: rgba(120,120,128,0.12);
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .wt-member {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 4px 6px;
        border-radius: 5px;
        font-size: 12px;
        line-height: 1.3;
      }
      .wt-member-dot {
        flex: 0 0 auto;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #30d158;
      }
      .wt-member-away { background: #ff9f0a; }
      .wt-member-name {
        flex: 1;
        color: rgba(235,235,245,0.9);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .wt-member-state {
        flex: 0 0 auto;
        font-size: 11px;
        color: rgba(235,235,245,0.45);
      }
      .wt-member-badge {
        flex: 0 0 auto;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.3px;
        text-transform: uppercase;
        padding: 2px 5px;
        border-radius: 4px;
        background: rgba(167,139,250,0.18);
        color: #a78bfa;
      }
      .wt-member-empty {
        padding: 6px;
        font-size: 11px;
        color: rgba(235,235,245,0.4);
        text-align: center;
      }

      /* ---------- everything else, one click away ---------- */
      /* Collapsed by default so the ordinary surface stays three things, and it remembers
         being opened so somebody who wants the detail opens it once and never again. */
      .wt-advanced {
        margin-top: 10px;
        border-top: 1px solid rgba(120,120,128,0.24);
        padding-top: 8px;
      }
      .wt-advanced-summary {
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        list-style: none;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.4px;
        text-transform: uppercase;
        color: rgba(235,235,245,0.45);
        padding: 4px 2px;
        user-select: none;
      }
      .wt-advanced-summary::-webkit-details-marker { display: none; }
      .wt-advanced-summary:hover { color: rgba(235,235,245,0.75); }
      .wt-advanced[open] .wt-advanced-summary .wt-chev { transform: rotate(90deg); }
      .wt-advanced-summary .wt-chev { transition: transform 0.15s; }
      .wt-advanced-body {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 8px 2px 2px;
      }
      .wt-adv-field { display: flex; flex-direction: column; gap: 5px; }
      .wt-adv-label {
        font-size: 11px;
        font-weight: 600;
        color: rgba(235,235,245,0.65);
      }
      .wt-adv-hint {
        font-size: 10px;
        line-height: 1.45;
        color: rgba(235,235,245,0.38);
      }

      .wt-seg {
        display: flex;
        gap: 2px;
        padding: 2px;
        border-radius: 7px;
        background: rgba(120,120,128,0.2);
      }
      .wt-seg-btn {
        flex: 1;
        padding: 5px 8px;
        border: none;
        border-radius: 5px;
        background: none;
        color: rgba(235,235,245,0.6);
        font-family: inherit;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
      }
      .wt-seg-btn.wt-seg-on { background: rgba(167,139,250,0.9); color: #fff; }
      .wt-seg-btn:disabled { cursor: default; opacity: 0.55; }

      .wt-offset { display: flex; align-items: center; gap: 4px; }
      .wt-offset-input {
        width: 62px;
        text-align: center;
        padding: 5px 4px;
        margin: 0;
      }
      .wt-offset-unit { font-size: 11px; color: rgba(235,235,245,0.45); }
      .wt-step {
        width: 24px;
        height: 26px;
        border: none;
        border-radius: 5px;
        background: rgba(120,120,128,0.24);
        color: #a78bfa;
        font-family: inherit;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
      }
      .wt-step:hover { background: rgba(120,120,128,0.36); }
      .wt-hotkey-input { text-align: center; margin: 0; }
      .wt-room-code {
        display: block;
        font-size: 24px;
        font-weight: 800;
        letter-spacing: 6px;
        color: #a78bfa;
      }
      .wt-watchers {
        font-size: 12px;
        color: rgba(235,235,245,0.5);
      }

      .wt-actions {
        display: flex;
        gap: 6px;
        margin-bottom: 10px;
      }
      .wt-btn-small {
        flex: 1;
        padding: 6px;
        border: none;
        border-radius: 6px;
        background: rgba(120,120,128,0.24);
        color: #a78bfa;
        font-family: inherit;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s;
      }
      .wt-btn-small:hover { background: rgba(120,120,128,0.36); }

      /* Sync health: the one number that says whether the party is actually together. */
      .wt-sync-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
      }
      .wt-sync-health {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 8px;
        border-radius: 6px;
        background: rgba(120,120,128,0.16);
        color: rgba(235,235,245,0.6);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .wt-sync-health::before {
        content: "";
        flex-shrink: 0;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: currentColor;
      }
      .wt-sync-good { background: rgba(48,209,88,0.14); color: #30d158; }
      .wt-sync-warn { background: rgba(255,159,10,0.14); color: #ff9f0a; }
      .wt-sync-bad  { background: rgba(255,69,58,0.14); color: #ff453a; }
      .wt-sync-row .wt-btn-small { flex: 0 0 auto; padding: 6px 10px; }

      #wt-mic.wt-mic-on {
        background: linear-gradient(135deg, #7c3aed, #a78bfa);
        color: #fff;
      }
      .wt-voice-active {
        text-align: center;
        font-size: 11px;
        color: #30d158;
        margin-bottom: 8px;
        min-height: 14px;
      }
      .wt-typing {
        font-size: 11px;
        font-style: italic;
        color: rgba(235,235,245,0.45);
        padding: 0 10px 4px;
        min-height: 14px;
        line-height: 14px;
      }

      .wt-chat {
        background: rgba(0,0,0,0.2);
        border-radius: 8px;
        overflow: hidden;
        margin-bottom: 8px;
      }
      .wt-chat-messages {
        height: 120px;
        overflow-y: auto;
        padding: 8px 10px;
        font-size: 13px;
      }
      .wt-chat-messages::-webkit-scrollbar { width: 0; }
      .wt-msg { margin-bottom: 6px; line-height: 1.4; word-break: break-word; }
      .wt-msg-name { font-weight: 600; font-size: 12px; color: rgba(235,235,245,0.5); }
      .wt-msg-name.wt-own { color: #a78bfa; }
      .wt-msg-text { font-size: 12px; color: rgba(235,235,245,0.7); }
      .wt-sys { font-size: 11px; color: rgba(235,235,245,0.3); text-align: center; padding: 3px 0; }

      .wt-chat-input-row {
        display: flex;
        border-top: 0.5px solid rgba(84,84,88,0.35);
      }
      .wt-chat-field {
        flex: 1;
        border-radius: 0;
        margin: 0;
        background: transparent;
        font-size: 13px;
        padding: 8px 10px;
      }
      .wt-send {
        padding: 8px 10px;
        background: none;
        border: none;
        color: #a78bfa;
        cursor: pointer;
        display: flex;
        align-items: center;
      }
      .wt-send:hover { opacity: 0.7; }

      .wt-btn-leave {
        width: 100%;
        padding: 8px;
        border: none;
        border-radius: 6px;
        background: none;
        color: #ff453a;
        font-family: inherit;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
      }
      .wt-btn-leave:hover { background: rgba(255,69,58,0.1); }
    `;
    document.head.appendChild(style);
  }

  // Keep the button in the player's controls, for as long as the page lives.
  //
  // The button is injected INTO the site's own control bar, which players rebuild from
  // scratch whenever the viewer changes how they are watching. On YouTube that is theatre
  // mode, the mini player, and fullscreen, all of which throw the control row away and
  // build a new one, taking our button with it. The old version gave up retrying after
  // thirty seconds, so switching to theatre mode ten minutes into a film left no way back
  // into the party except reloading the page.
  //
  // Note that theatre mode fires no fullscreenchange and no navigation: there is no event
  // to hook. So rather than chase each site's internals, just keep checking cheaply for as
  // long as the page is open. getElementById on a known id is one hash lookup.
  function watchForPlayer() {
    const ensureButton = () => {
      if (document.getElementById("wt-overlay-btn")) return;
      injectButton();
    };

    ensureButton();

    // YouTube mutates its DOM constantly, so this fires a great deal. Coalesce it: doing
    // the work on every mutation on a page like that is a real cost for something that
    // only needs to be true a moment later.
    let pending = null;
    const observer = new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        ensureButton();
      }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Backstop for players that rebuild their controls without touching anything the
    // observer is watching, and for the moment right after a fullscreen transition when
    // the control bar exists but is still being assembled.
    setInterval(ensureButton, 3000);
    document.addEventListener("fullscreenchange", () => setTimeout(ensureButton, 150), true);
    document.addEventListener("webkitfullscreenchange", () => setTimeout(ensureButton, 150), true);
  }

  // Init
  injectStyles();
  loadHotkeyConfig();
  setupHotkeyListeners();
  connectPort();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watchForPlayer);
  } else {
    watchForPlayer();
  }
})();
