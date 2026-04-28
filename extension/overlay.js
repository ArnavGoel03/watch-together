// Overlay — injects Watch Together UI directly into video player controls

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
  let isConnected = false;
  let memberCount = 1;
  let pendingEnterSend = false; // true if user pressed Enter during IME composition
  const inFlight = new Set();

  // ---------- Hotkey config ----------
  // Two modes: "click" (current behavior, button click toggles) or "hold" (panel only
  // visible while configured key is held — push-to-show, like push-to-talk).
  const HOTKEY_DEFAULT = "\\"; // backslash — rarely used by sites, easy to reach on most layouts
  let overlayMode = "click";
  let overlayHotkey = HOTKEY_DEFAULT;
  let hotkeyHeld = false; // true while the configured hotkey is currently down

  // ---------- Voice mesh state ----------
  // WebRTC peer-to-peer audio. Server only relays SDP/ICE via voice-signal messages.
  const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
  // Voice quality modes:
  //   "media"  — DEFAULT. Echo cancellation OFF. Chrome does NOT switch the tab into the
  //              "communication" audio category, so the video's audio stays at full volume.
  //              Trade-off: people on speakers may hear themselves through their friend's mic.
  //   "voice"  — Echo cancellation ON. Better voice quality on speakers. Chrome ducks the
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
    // "media" — explicitly disable processing so Chrome stays in "playback" audio category
    return {
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    };
  }

  // Robust clipboard write — must run synchronously inside the click handler
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

  function withInFlight(key, btn, fn) {
    if (inFlight.has(key)) return;
    inFlight.add(key);
    if (btn) btn.disabled = true;
    Promise.resolve(fn()).finally(() => {
      inFlight.delete(key);
      if (btn) btn.disabled = false;
    });
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
  // Voice mesh — WebRTC peer-to-peer audio
  // ============================================================

  async function startVoice() {
    if (voice.active) return;
    try {
      voice.localStream = await navigator.mediaDevices.getUserMedia(micConstraints());
    } catch (err) {
      addSystemMsg("Mic access denied — enable it in site settings");
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
        // Other side will initiate when they see our voice-state — we just open the slot
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
    //    null handlers first — defensive against the close path firing late.
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
    badge.textContent = total > 0 ? `🎤 ${total} on voice` : "";
  }

  // ============================================================
  // Hotkey — tap to open (click mode) or hold to show (hold mode)
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
  // displayable key — letters, digits, or punctuation like "\\"). Modifier-only
  // hotkeys are not supported in V1 — just one key.
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

  function setupHotkeyListeners() {
    document.addEventListener("keydown", (e) => {
      if (!matchesHotkey(e)) return;
      if (e.repeat) return; // ignore key-repeat firing
      e.preventDefault();
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
    chrome.storage.onChanged.addListener((changes) => {
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
          <span class="wt-watchers"><span id="wt-member-count">1</span> watching</span>
        </div>
        <div class="wt-actions">
          <button class="wt-btn-small" id="wt-copy-code">Copy Code</button>
          <button class="wt-btn-small" id="wt-copy-link">Copy Link</button>
          <button class="wt-btn-small" id="wt-mic" title="Toggle voice">
            <span id="wt-mic-label">Voice</span>
          </button>
          <button class="wt-btn-small" id="wt-pip" title="Picture-in-picture">PiP</button>
        </div>
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
        <button class="wt-btn-leave" id="wt-leave">Leave</button>
      </div>
    `;

    document.body.appendChild(overlayPanel);

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
      // IME composition guard — emoji picker / IME insertion may keep input value
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
        addSystemMsg("PiP blocked — try the player's own button");
        console.warn("[WatchTogether] PiP failed:", err);
      }
    });

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

  function syncMemberCountDom() {
    if (!overlayPanel) return;
    const el = overlayPanel.querySelector("#wt-member-count");
    if (el) el.textContent = memberCount;
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
      addSystemMsg("Couldn't send — reconnecting");
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
    const div = document.createElement("div");
    div.className = "wt-msg wt-sys";
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
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
      // Input was cleared (e.g. message sent) — let peers know immediately
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
          currentRoom = msg.roomCode;
          myUserId = msg.userId || myUserId;
          inRoom = true;
          memberCount = 1;
          if (overlayPanel) {
            overlayPanel.querySelector("#wt-room-code").textContent = msg.roomCode;
            syncMemberCountDom();
            showView("room");
          }
          updateButtonState();
          addSystemMsg("Room created");
          break;

        case "room-joined":
          currentRoom = msg.roomCode;
          myUserId = msg.userId || myUserId;
          inRoom = true;
          memberCount = msg.members?.length || 1;
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
          syncMemberCountDom();
          addSystemMsg(`${msg.userName} joined`);
          break;

        case "member-left":
          memberCount = typeof msg.memberCount === "number" ? msg.memberCount : Math.max(1, memberCount - 1);
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
          isConnected = msg.connected;
          if (overlayPanel) {
            const statusEl = overlayPanel.querySelector("#wt-status");
            statusEl.textContent = msg.connected ? "Live" : "Offline";
            statusEl.className = `wt-panel-status ${msg.connected ? "wt-live" : ""}`;
          }
          break;

        case "state":
          isConnected = msg.connected;
          if (msg.userId) myUserId = msg.userId;
          if (msg.currentRoom) {
            currentRoom = msg.currentRoom;
            inRoom = true;
            if (overlayPanel) {
              overlayPanel.querySelector("#wt-room-code").textContent = msg.currentRoom;
              showView("room");
            }
            updateButtonState();
          }
          break;

        case "error":
          addSystemMsg(msg.message);
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {}
      port = null;
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
        container.style.position = container.style.position || "relative";
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
      #wt-overlay-panel.wt-visible { display: block; animation: wt-slide-in 0.2s ease-out; }
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

      .wt-room-info {
        text-align: center;
        margin-bottom: 10px;
      }
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

  // Watch for player to load (SPAs load video players dynamically)
  function watchForPlayer() {
    let injected = false;

    const tryInject = () => {
      if (!injected) {
        injected = injectButton();
      }
    };

    // Try immediately
    tryInject();

    // Watch for DOM changes
    const observer = new MutationObserver(() => {
      if (!document.getElementById("wt-overlay-btn")) {
        injected = false;
      }
      tryInject();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Also retry periodically for slow-loading players
    const retryInterval = setInterval(() => {
      if (!document.getElementById("wt-overlay-btn")) {
        injected = false;
        tryInject();
      }
    }, 2000);

    // Stop retrying after 30s
    setTimeout(() => clearInterval(retryInterval), 30000);
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
