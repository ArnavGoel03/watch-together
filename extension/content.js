// Content script - detects video elements and syncs playback

(function () {
  if (window.__watchTogetherLoaded) return;
  window.__watchTogetherLoaded = true;

  const DRIFT_IGNORE = 0.5;       // < this: do nothing
  const DRIFT_HARD_SEEK = 1.5;    // > this: hard seek
  const DRIFT_MAX_RATE_DELTA = 0.10; // up to ±10% playbackRate nudge
  // The heartbeat is essentially the entire running cost of this product. Every other
  // message is user-driven and rare; this one fires forever, per room, whether or not
  // anything is happening. Cloudflare bills incoming WebSocket messages (at 20:1), so the
  // lever that matters is how MANY messages are sent, not how big they are: shrinking the
  // JSON saves nothing, sending fewer beats saves everything.
  //
  // Three things follow from that, and all three also make the product better rather than
  // merely cheaper: a paused room has no position to correct, a room of one has nobody to
  // correct against, and a room that has been in sync for a while does not need to be told
  // every five seconds. So the interval backs off while things are calm and snaps straight
  // back to 5s the moment drift shows up or anyone touches the video.
  const HEARTBEAT_INTERVAL = 5000;  // the floor: while drift is live or a seek just landed
  // The ceiling deliberately sits under the server's LEADER_STALE_MS (15s). Back off past
  // that and the stale-leader watchdog starts demoting a leader who is perfectly healthy
  // and merely quiet, and the room churns leaders instead of watching a film.
  const HEARTBEAT_MAX_INTERVAL = 12000;
  const HEARTBEAT_CALM_TICKS = 3;   // consecutive in-sync beats before we start easing off
  const HEARTBEAT_COOLDOWN = 2000; // skip heartbeat for 2s after receiving/sending a sync
  const FULLSCREEN_GUARD_MS = 1500; // ignore video events for this long after fullscreenchange
  const NAV_POLL_MS = 1000;        // detect SPA URL changes
  const SUSPECT_JUMP_GRACE_MS = 1500; // protect against player remount jumping to 0

  let port = null;
  let activeVideo = null;
  let adapter = null;
  let lastApplied = null; // the state the last remote sync wrote, so echoes can be told from real actions
  let heartbeatTimer = null;
  let heartbeatInterval = 5000;   // current gap, widened while the room stays in sync
  let calmTicks = 0;              // consecutive beats with no drift worth correcting
  let roomMemberCount = 1;        // no point heartbeating to an empty room
  let inRoom = false;
  let currentRoom = null;
  let pendingPlaybackState = null; // for applying sync after video loads
  let metadataWaiter = null; // at most one loadedmetadata listener in flight
  let lastSyncTime = 0; // timestamp of last sync event (sent or received)
  let lastBroadcastTime = 0; // last currentTime we sent - used to detect suspect jumps
  let serverClockOffset = 0; // (server epoch ms) - (local epoch ms), EWMA-smoothed
  let serverClockSamples = 0;
  let fullscreenGuardUntil = 0;
  let activeRateNudge = null;   // { normalRate, restoreTimer }
  let suppressNextNavigateUntil = 0; // when we just applied a remote nav, don't echo
  let pendingNavigateTimer = null; // one in-flight remote redirect; a newer navigate replaces it
  let lastDrift = 0;    // seconds behind (+) or ahead (-) the room, from the last correction
  let lastDriftAt = 0;  // when we last measured it; drift older than a few seconds is stale
  let lastAttachedElement = null; // identity, so re-binding the same node is not a "remount"
  let attachedAt = 0;   // when we last bound a genuinely NEW video element
  let awaitingGesture = false; // autoplay policy blocked a remote play; the viewer must click

  function isLiveStream(video) {
    if (!video) return false;
    const d = video.duration;
    return d === Infinity || d === Number.POSITIVE_INFINITY || (typeof d === "number" && d > 1e6);
  }

  // A sample this far from the running estimate is not drift, it is the local clock
  // having moved: a laptop waking from sleep, or an NTP correction landing mid-party.
  // Easing towards it at 15% a message would leave every seek target wrong for a minute.
  const CLOCK_RESET_THRESHOLD_MS = 30000;

  function updateClockOffset(serverTime) {
    if (typeof serverTime !== "number" || !isFinite(serverTime)) return;
    const sample = serverTime - Date.now();
    if (!isFinite(sample)) return;
    if (serverClockSamples === 0 || Math.abs(sample - serverClockOffset) > CLOCK_RESET_THRESHOLD_MS) {
      serverClockOffset = sample;
      serverClockSamples = 1;
      return;
    }
    // EWMA: weight new sample at 15%, fast enough to converge after a few messages
    serverClockOffset = serverClockOffset * 0.85 + sample * 0.15;
    serverClockSamples++;
  }

  function nowServer() {
    return Date.now() + serverClockOffset;
  }

  // Pick the right adapter for this site
  // Anchored to the registrable domain, not a substring. `host.includes("netflix")`
  // also matched netflix-fanhub.example.com, which would then be driven by Netflix's
  // player selectors and synthetic clicks instead of the generic adapter that would
  // actually have worked.
  function hostMatches(host, domains) {
    return domains.some((d) => host === d || host.endsWith("." + d));
  }

  function getAdapter() {
    const host = window.location.hostname.toLowerCase();
    const all = window.__watchTogetherAdapters || {};
    if (hostMatches(host, ["hotstar.com", "jiohotstar.com"])) return all.jiohotstar;
    if (hostMatches(host, ["netflix.com"])) return all.netflix;
    if (hostMatches(host, ["youtube.com", "youtu.be", "youtube-nocookie.com"])) return all.youtube;
    return all.generic;
  }

  // Find the main video element on the page
  // A muted autoplay background video is decoration, not the show. It is often laid out
  // before the real player is, so a pure largest-area contest can hand the party a
  // looping hero banner and never recover.
  function isDecorative(v) {
    if (!v) return true;
    if (v.offsetParent === null && v.clientHeight === 0) return true; // not laid out
    return v.muted && (v.autoplay || v.loop) && !v.controls;
  }

  function pickLargest(videos) {
    return videos.reduce((best, v) =>
      v.clientWidth * v.clientHeight > best.clientWidth * best.clientHeight ? v : best
    );
  }

  function findVideo() {
    if (adapter && adapter.findVideo) {
      const fromAdapter = adapter.findVideo();
      if (fromAdapter) return fromAdapter;
    }
    const videos = Array.from(document.querySelectorAll("video"));
    if (videos.length === 0) return null;
    if (videos.length === 1) return videos[0];
    const real = videos.filter((v) => !isDecorative(v));
    return pickLargest(real.length ? real : videos);
  }

  // Attach event listeners to the video
  function attachVideoListeners(video) {
    if (!video || video === activeVideo) return;
    if (activeVideo) detachVideoListeners(activeVideo);
    const isNewElement = video !== lastAttachedElement;
    activeVideo = video;
    lastAttachedElement = video;
    // Only a genuinely different element is a remount. Re-binding the same node after an
    // SPA navigation must not re-arm the jump guard, or a real rewind right afterwards
    // gets eaten.
    if (isNewElement) attachedAt = Date.now();
    // Reset the suspect-jump guard so a fresh element doesn't trip it before any real time accumulates
    lastBroadcastTime = 0;

    const events = ["play", "pause", "seeked", "ratechange"];
    events.forEach((event) => {
      video.addEventListener(event, onVideoEvent);
    });

    setupCCDetection(video);

    // If we have a pending playback state, apply it now
    if (pendingPlaybackState) {
      applySync(pendingPlaybackState);
      pendingPlaybackState = null;
    }
  }

  function detachVideoListeners(video) {
    if (!video) return;
    const events = ["play", "pause", "seeked", "ratechange"];
    events.forEach((event) => {
      video.removeEventListener(event, onVideoEvent);
    });
  }

  // Fullscreen transitions on YouTube/Netflix often remount the video element,
  // which fires spurious play/seeked events at currentTime=0. Suppress them.
  function onFullscreenChange() {
    fullscreenGuardUntil = Date.now() + FULLSCREEN_GUARD_MS;
  }
  document.addEventListener("fullscreenchange", onFullscreenChange, true);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange, true);

  // ---------- Closed-caption sync ----------
  // Watch the video's text tracks and (for YouTube) the subtitles button.
  // Whenever CC visibility flips, broadcast a cc-state event so peers can
  // see a "Yash turned captions ON" presence toast.
  let lastCCState = null;
  let ccObserver = null;
  let ccButtonPoll = null;

  function setupCCDetection(video) {
    if (!video) return;
    // Every re-attach used to add another 5s poller, and a URL change nulls activeVideo
    // even when the player reuses the same element, so a night of autoplay-next left one
    // live interval per video watched, all polling forever.
    if (ccButtonPoll) { clearInterval(ccButtonPoll); ccButtonPoll = null; }
    if (ccObserver) { ccObserver.disconnect(); ccObserver = null; }
    // HTML5 textTracks (works on YouTube, generic <video>, etc.)
    if (video.textTracks) {
      const onTrackChange = () => checkCCState();
      for (const t of video.textTracks) {
        try { t.addEventListener("cuechange", onTrackChange); } catch {}
        try { t.addEventListener("change", onTrackChange); } catch {}
      }
      try {
        video.textTracks.addEventListener("addtrack", (e) => {
          try { e.track.addEventListener("change", onTrackChange); } catch {}
          checkCCState();
        });
      } catch {}
    }
    // YouTube-specific: observe the subtitles button's aria-pressed
    if (location.hostname.includes("youtube.com")) {
      const watchBtn = () => {
        const btn = document.querySelector(".ytp-subtitles-button");
        if (!btn) return;
        if (ccObserver) ccObserver.disconnect();
        ccObserver = new MutationObserver(() => checkCCState());
        ccObserver.observe(btn, { attributes: true, attributeFilter: ["aria-pressed"] });
      };
      watchBtn();
      // Re-find the button if YouTube remounts it (theater mode, etc.)
      ccButtonPoll = setInterval(watchBtn, 5000);
    }
    // Initial state
    setTimeout(checkCCState, 500);
  }

  function checkCCState() {
    if (!inRoom || !activeVideo) return;
    let active = false;
    try {
      if (activeVideo.textTracks) {
        for (let i = 0; i < activeVideo.textTracks.length; i++) {
          if (activeVideo.textTracks[i].mode === "showing") { active = true; break; }
        }
      }
    } catch {}
    // Augment with YouTube's button - sometimes textTracks lag the UI
    if (!active && location.hostname.includes("youtube.com")) {
      const btn = document.querySelector(".ytp-subtitles-button");
      if (btn && btn.getAttribute("aria-pressed") === "true") active = true;
    }
    if (active !== lastCCState) {
      lastCCState = active;
      sendMsg({ type: "cc-state", active });
    }
  }

  // ---------- Sync labels ----------
  // Show a small transient toast in the corner when a remote sync event
  // comes in: "Yash paused" / "Anshul seeked". 1.5s lifespan.
  let syncLabelTimer = null;
  function showSyncLabel(userName, action) {
    if (!userName || !action) return;
    const verb =
      action === "play" ? "played"
      : action === "pause" ? "paused"
      : action === "seek" ? "seeked"
      : action === "ratechange" ? "changed speed"
      : action;
    let el = document.getElementById("wt-sync-label");
    if (!el) {
      el = document.createElement("div");
      el.id = "wt-sync-label";
      el.style.cssText = `
        position: fixed;
        bottom: 80px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483646;
        background: rgba(0,0,0,0.78);
        color: #fff;
        padding: 6px 14px;
        border-radius: 16px;
        font: 500 13px -apple-system, sans-serif;
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.18s;
      `;
      document.body.appendChild(el);
    }
    el.textContent = `${userName} ${verb}`;
    el.style.opacity = "1";
    // Held here rather than bolted onto the DOM node: an expando on an element the host
    // page also owns is somebody else's property to trip over.
    clearTimeout(syncLabelTimer);
    syncLabelTimer = setTimeout(() => { el.style.opacity = "0"; }, 1500);
  }

  // Ad markers used by the common web players. Cheap to test and covers most of the web
  // without needing a per-site adapter.
  const AD_SELECTORS = [
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
  ];

  // The longest stable duration we have seen on this page: our best guess at the actual
  // show's length. Ads reuse the same <video> element with a tiny duration, so a sudden
  // collapse from (say) 3600s to 15s is a near-certain ad, on any player, including ones
  // we have never heard of.
  let contentDuration = 0;
  const AD_MAX_DURATION = 60;       // ads longer than this are rare
  const AD_DURATION_RATIO = 3;      // content must be at least 3x the ad to trust the signal
  const AD_WEDGE_MAX_MS = 180000;   // no real ad break runs this long

  function noteContentDuration(video) {
    if (!video) return;
    const d = video.duration;
    if (!isFinite(d) || d <= AD_MAX_DURATION) return;
    if (d > contentDuration) {
      contentDuration = d;
      durationLearnedAt = Date.now();
    }
  }

  function adMarkerPresent() {
    for (const sel of AD_SELECTORS) {
      if (document.querySelector(sel)) return true;
    }
    return false;
  }

  function isAdPlaying() {
    if (adMarkerPresent()) return true;

    const video = activeVideo;
    if (!video) return false;
    const d = video.duration;
    if (!isFinite(d) || d <= 0) return false;

    // Universal: the element's duration collapsed far below the known content length.
    if (
      contentDuration > AD_MAX_DURATION * 1.5 &&
      d <= AD_MAX_DURATION &&
      contentDuration / d >= AD_DURATION_RATIO
    ) {
      return true;
    }

    // JioHotstar serves ads before we ever learn the content duration, so keep the
    // original site-specific fallback for the cold-start case.
    if (d < 30 && !contentDuration) {
      const host = window.location.hostname;
      if (host.includes("hotstar") || host.includes("jiohotstar")) return true;
    }
    return false;
  }

  // Ads are per-viewer: your 30s pre-roll is not your friend's. So an ad is not a "pause
  // the room" event, it is a "drop out, then catch back up" event. Everyone sits out their
  // own ads and snaps back to the room's true position when theirs ends.
  let adActive = false;
  let adSince = 0;
  // After a navigation we have not yet learned the new video's length, so the
  // duration-collapse test compares the new content against the OLD show and calls a
  // short clip an ad. Give the page a moment to tell us how long it actually is; until
  // then only a real ad marker counts.
  let durationLearnedAt = 0;
  const AD_HEURISTIC_WARMUP_MS = 5000;

  function updateAdState() {
    noteContentDuration(activeVideo);
    let nowAd = adMarkerPresent() || (Date.now() - durationLearnedAt > AD_HEURISTIC_WARMUP_MS && isAdPlaying());

    // Safety valve. The duration heuristic can be wrong: a genuinely short video that
    // follows a long one on the same page looks exactly like an ad, and being wrong here
    // means sync is silently dead for the rest of the session. No real ad break runs for
    // three minutes, so if we still believe one is running and no player has actually said
    // so, we are the ones who are wrong. Forget the content length and rejoin the room.
    if (nowAd && adActive && !adMarkerPresent() && Date.now() - adSince > AD_WEDGE_MAX_MS) {
      contentDuration = 0;
      nowAd = false;
    }

    if (nowAd === adActive) return;
    adActive = nowAd;
    adSince = nowAd ? Date.now() : 0;

    if (!inRoom) return;
    if (nowAd) {
      showNotification("Ad playing, sync paused");
    } else {
      showNotification("Ad over, resyncing...");
      requestResync();
    }
  }
  // <all_urls> means this file runs in every tab the user has open. Ten querySelector
  // calls twice a second in each of them, forever, is a battery cost paid by people who
  // are not even in a party. Only look while it can matter.
  setInterval(() => { if (inRoom) updateAdState(); }, 500);

  // Applying a remote sync makes the video fire the very same events a viewer would, so for
  // a short window afterwards we ignore them. Ignore only the ones that match what we just
  // wrote, though. A blanket "drop everything for 300ms" also drops a viewer who really did
  // seek or pause in that window: their player moves, the room never hears about it, and the
  // two sit out of step until the next heartbeat drags one of them back.
  const ECHO_WINDOW_MS = 1000;
  const ECHO_SEEK_EPSILON = 1.0; // a seek we performed lands within a frame or two of its target

  function isSyncEcho(action, video) {
    if (!lastApplied || Date.now() - lastApplied.at > ECHO_WINDOW_MS) return false;
    if (action === "play") return lastApplied.playing === true;
    if (action === "pause") return lastApplied.playing === false;
    if (action === "seek") return Math.abs(video.currentTime - lastApplied.currentTime) < ECHO_SEEK_EPSILON;
    if (action === "ratechange") {
      // Drift correction retunes the rate constantly, so most rate changes are ours. But
      // "always ours" also swallowed a viewer reaching for 1.25x in the same instant, and
      // their choice then silently never reached the room. Ours is the rate we last wrote.
      const wrote = lastApplied.rate;
      return typeof wrote === "number" && Math.abs(video.playbackRate - wrote) < 0.01;
    }
    return false;
  }

  function onVideoEvent(e) {
    if (!inRoom || isAdPlaying()) return;

    // Skip events triggered by fullscreen transitions (player often remounts the video,
    // firing play/seeked at currentTime=0 which would yank everyone else to the start)
    if (Date.now() < fullscreenGuardUntil) return;

    const video = e.target;
    const action =
      e.type === "play"
        ? "play"
        : e.type === "pause"
          ? "pause"
          : e.type === "seeked"
            ? "seek"
            : "ratechange";

    // There used to be a second, coarser guard in front of this: a boolean set while a
    // remote sync was being applied and cleared 200-300ms later. It cleared faster than the
    // 1s window this function implements, so a seek that took longer than that (a big file,
    // a slow CDN) escaped it entirely and came back to the room as a fresh "someone seeked".
    // isSyncEcho stands alone: it matches what we actually wrote, and when.
    if (isSyncEcho(action, video)) return;

    // Suspect-jump guard: a seek to ~0 in the first moments after a NEW video element was
    // bound is a player remount, not a viewer. Keyed to the remount itself, because the
    // old timing-only version could not tell a remount from someone pausing at t=500 and
    // deliberately dragging back to the start a second later, and silently ate the rewind.
    const ct = video.currentTime;
    if ((action === "seek" || action === "play") && ct < 1.5) {
      const sinceAttach = Date.now() - attachedAt;
      if (lastBroadcastTime > 5 && sinceAttach < SUSPECT_JUMP_GRACE_MS) return;
    }

    const live = isLiveStream(video);

    lastSyncTime = Date.now();
    quickenHeartbeat();
    lastBroadcastTime = ct;

    sendMsg({
      type: "sync",
      action,
      playing: !video.paused,
      // Live streams: don't propagate currentTime - DVR offsets differ per viewer.
      currentTime: live ? 0 : ct,
      playbackRate: video.playbackRate,
      isLive: live,
    });
  }

  function sendMsg(msg) {
    if (port) {
      try {
        port.postMessage(msg);
      } catch {
        // Re-store pending join so it retries after reconnect
        if (msg.type === "join-room" && msg.roomCode) {
          // consented: the user already asked to join this one, we are only retrying.
          chrome.storage.local.set({
            pendingJoin: { roomCode: msg.roomCode, timestamp: Date.now(), consented: true },
          });
        }
        connectToBackground();
      }
    }
  }

  // Cancel any in-flight rate nudge - used when a hard correction overrides it
  function cancelRateNudge(video) {
    if (!activeRateNudge) return;
    if (activeRateNudge.restoreTimer) clearTimeout(activeRateNudge.restoreTimer);
    if (video && Math.abs(video.playbackRate - activeRateNudge.normalRate) > 0.01) {
      try { video.playbackRate = activeRateNudge.normalRate; } catch {}
    }
    activeRateNudge = null;
  }

  // Smoothly close drift via playbackRate nudge instead of seeking.
  // drift > 0 means we're behind (need to speed up).
  function nudgePlaybackRate(video, drift, normalRate) {
    const sign = drift > 0 ? 1 : -1;
    const magnitude = Math.min(DRIFT_MAX_RATE_DELTA, Math.abs(drift) * 0.10);
    const targetRate = normalRate * (1 + sign * magnitude);
    const closeMs = (Math.abs(drift) / Math.abs(sign * magnitude * normalRate)) * 1000;

    if (activeRateNudge && activeRateNudge.restoreTimer) {
      clearTimeout(activeRateNudge.restoreTimer);
    }
    activeRateNudge = { normalRate, restoreTimer: null };

    try { video.playbackRate = targetRate; } catch {}

    activeRateNudge.restoreTimer = setTimeout(() => {
      if (video && Math.abs(video.playbackRate - targetRate) < 0.05) {
        try { video.playbackRate = normalRate; } catch {}
      }
      activeRateNudge = null;
    }, closeMs);
  }

  // Ask the room where it actually is and snap to it. Used on session resume, after an
  // ad, on reconnect, on tab wake, and by the manual resync control.
  // Two URLs point at the same video if they differ only by our own join hint or a hash.
  function normalizeUrl(raw) {
    try {
      const u = new URL(raw);
      u.searchParams.delete("wt_room");
      u.hash = "";
      return u.toString().replace(/\/$/, "");
    } catch {
      return String(raw || "");
    }
  }

  function requestResync() {
    if (!inRoom) return;
    sendMsg({ type: "request-state" });
  }

  // Apply sync state from another user
  function applySync(msg) {
    if (msg && typeof msg.serverTime === "number") updateClockOffset(msg.serverTime);

    // While an ad is on screen the <video> element IS the ad, not the show. Seeking or
    // playing it would scrub the ad, and its timeline is meaningless to the room. Sit the
    // ad out; updateAdState resyncs us the moment it ends.
    if (inRoom && isAdPlaying()) return;

    const video = activeVideo || findVideo();
    if (!video) {
      pendingPlaybackState = msg;
      // Clear stale pending state after 30s
      setTimeout(() => { if (pendingPlaybackState === msg) pendingPlaybackState = null; }, 30000);
      return;
    }
    if (!activeVideo) attachVideoListeners(video);

    // Wait for video to have metadata before seeking. One listener, ever: each call used
    // to add its own, so three messages arriving during a slow load meant three seeks
    // firing back to back the moment metadata landed, which reads as a stutter.
    if (!video.duration || video.readyState < 1) {
      pendingPlaybackState = msg;
      if (!metadataWaiter) {
        metadataWaiter = function onMeta() {
          video.removeEventListener("loadedmetadata", onMeta);
          metadataWaiter = null;
          const latest = pendingPlaybackState;
          pendingPlaybackState = null;
          if (latest) applySync(latest);
        };
        video.addEventListener("loadedmetadata", metadataWaiter);
      }
      return;
    }

    const live = isLiveStream(video) || !!msg.isLive;
    const isHeartbeat = msg.type === "heartbeat";
    const normalRate = msg.playbackRate || 1;

    lastSyncTime = Date.now();

    // Compensate for network/server delay using clock offset (corrects for skewed system clocks)
    let targetTime = msg.currentTime;
    if (!live && msg.playing && msg.timestamp) {
      const elapsedSec = (nowServer() - msg.timestamp) / 1000;
      targetTime += Math.max(0, elapsedSec) * normalRate;
      if (video.duration && isFinite(video.duration) && targetTime > video.duration) {
        targetTime = video.duration - 0.5;
      }
    }

    // Remember what we are about to write so the events it provokes can be told apart from
    // a viewer doing something of their own in the same moment.
    lastApplied = { currentTime: targetTime, playing: !!msg.playing, rate: normalRate, at: Date.now() };

    if (adapter && adapter.applyState) {
      // Adapter handles its own seeking; pass adjusted state
      adapter.applyState(video, { ...msg, currentTime: targetTime });
    } else {
      if (live) {
        // Live: never seek. Just sync play/pause/rate.
        if (normalRate && Math.abs(video.playbackRate - normalRate) > 0.01) {
          video.playbackRate = normalRate;
        }
      } else if (msg.action === "ratechange") {
        // Somebody chose 1.25x. That says nothing about position, and treating it as a
        // position update meant any drift the room happened to be carrying at that moment
        // turned into a jump cut for everyone.
        if (normalRate && Math.abs(video.playbackRate - normalRate) > 0.01) {
          cancelRateNudge(video);
          video.playbackRate = normalRate;
        }
      } else {
        const drift = targetTime - video.currentTime; // + means we're behind
        const absDrift = Math.abs(drift);
        lastDrift = drift;
        lastDriftAt = Date.now();
        if (absDrift < DRIFT_IGNORE) {
          // tiny - let it ride
        } else if (isHeartbeat && absDrift < DRIFT_HARD_SEEK) {
          // smooth correction via playbackRate nudge - no audio glitch
          nudgePlaybackRate(video, drift, normalRate);
        } else {
          // user action OR large drift: hard seek
          cancelRateNudge(video);
          video.currentTime = targetTime;
        }
        if (normalRate && Math.abs(video.playbackRate - normalRate) > 0.01 && !activeRateNudge) {
          video.playbackRate = normalRate;
        }
      }
      if (msg.playing && video.paused) {
        video.play().then(clearGesturePrompt).catch((err) => {
          // Autoplay policy: a remote play() carries no user gesture, so on a tab the
          // viewer has never interacted with the browser simply refuses. This used to be
          // swallowed whole: everyone else was watching, this person's video sat there,
          // and nothing on screen said why. Ask for the one click that unblocks it.
          if (err && err.name === "NotAllowedError") showGesturePrompt();
        });
      } else if (!msg.playing && !video.paused) {
        video.pause();
        clearGesturePrompt();
      }
    }

  }

  // Heartbeat - only the leader sends, everyone receives.
  // Self-rescheduling rather than a fixed interval, so the gap can widen while nothing is
  // happening and collapse back to the floor the instant it matters.
  function startHeartbeat() {
    stopHeartbeat();
    calmTicks = 0;
    heartbeatInterval = HEARTBEAT_INTERVAL;
    scheduleHeartbeat();
  }

  function scheduleHeartbeat() {
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      sendHeartbeat();
      if (inRoom) scheduleHeartbeat();
    }, heartbeatInterval);
  }

  // Something changed, or someone did something. Whatever we thought about this room being
  // calm is no longer true.
  function quickenHeartbeat() {
    calmTicks = 0;
    if (heartbeatInterval === HEARTBEAT_INTERVAL) return;
    heartbeatInterval = HEARTBEAT_INTERVAL;
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
      scheduleHeartbeat();
    }
  }

  function sendHeartbeat() {
    const video = activeVideo || findVideo();
    if (!video || !inRoom) return;

    // Nobody to stay in sync WITH. A room of one still exists (people come back to it),
    // it just has no reason to be talking to itself every five seconds.
    if (roomMemberCount < 2) return;

    // A paused room's position is not moving, so there is nothing to correct. The pause
    // itself was already broadcast as a sync, and pressing play broadcasts again. The
    // server knows to leave a paused room's leader alone rather than treating the silence
    // as a frozen tab.
    if (video.paused) return;

    // Skip heartbeat if a sync event happened recently - prevents overriding other users' actions
    if (Date.now() - lastSyncTime < HEARTBEAT_COOLDOWN) return;

    // An ad is a different video on the same element. Broadcasting its currentTime
    // would drag the whole room back to the ad's timeline (near 0), so stay quiet
    // until the show is back. updateAdState catches us up when it ends.
    if (isAdPlaying()) return;

    sendMsg({
      type: "heartbeat",
      playing: !video.paused,
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
    });

    // Ease off only while the room is demonstrably in sync. Any real drift resets this.
    const driftIsStale = Date.now() - lastDriftAt > 30000;
    const inSync = driftIsStale || Math.abs(lastDrift) < DRIFT_IGNORE;
    if (!inSync) {
      quickenHeartbeat();
      return;
    }
    calmTicks++;
    if (calmTicks >= HEARTBEAT_CALM_TICKS) {
      heartbeatInterval = Math.min(HEARTBEAT_MAX_INTERVAL, Math.round(heartbeatInterval * 1.5));
    }
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // Connect to background service worker
  function connectToBackground() {
    try {
      port = chrome.runtime.connect({ name: "content" });
    } catch {
      port = null;
      setTimeout(connectToBackground, 2000);
      return;
    }

    // Suppress back/forward cache port errors
    chrome.runtime.lastError;

    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case "sync":
          applySync(msg);
          if (msg.fromUser && msg.action) showSyncLabel(msg.fromUser, msg.action);
          break;

        case "cc-state":
          showNotification(`${msg.userName || "Someone"} turned captions ${msg.active ? "ON" : "OFF"}`);
          break;

        case "heartbeat":
          // Ignore heartbeats if we just sent or received a sync - prevents overriding actions
          if (Date.now() - lastSyncTime < HEARTBEAT_COOLDOWN) break;
          applySync(msg);
          break;

        // The background gates heartbeat sending, so there is nothing for the page to do
        // with this beyond not treating it as an unknown message.
        case "heartbeat-role":
          break;

        case "room-created":
        case "room-joined":
          inRoom = true;
          currentRoom = msg.roomCode;
          if (Array.isArray(msg.members)) roomMemberCount = Math.max(1, msg.members.length);
          if (typeof msg.serverTime === "number") updateClockOffset(msg.serverTime);
          adapter = getAdapter();
          {
            const v = findVideo();
            if (v) attachVideoListeners(v);
          }
          startHeartbeat();

          // The party tab just came back from a full page load. If it landed somewhere
          // other than where the room is, the user switched app (YouTube to Netflix, say):
          // a cross-site jump tears down the content script, so the in-page URL watcher
          // never saw it and nobody told the room. Tell it now, and everyone follows.
          // Only on a resume: a fresh joiner sitting on some unrelated page must follow the
          // room, not drag the room onto their page.
          if (msg.resumed && msg.videoUrl && normalizeUrl(msg.videoUrl) !== normalizeUrl(location.href)) {
            sendMsg({ type: "navigate", url: location.href, onResume: true });
          }

          showNotification(
            msg.resumed
              ? `Back in room ${msg.roomCode}`
              : msg.type === "room-created"
                ? `Room created: ${msg.roomCode}`
                : `Joined room: ${msg.roomCode}`
          );
          // If joining, apply the room's current playback state
          if (msg.type === "room-joined" && msg.playbackState) {
            applySync(msg.playbackState);
          }
          break;

        case "member-joined":
          if (typeof msg.memberCount === "number") roomMemberCount = msg.memberCount;
          quickenHeartbeat(); // someone new has to be caught up promptly
          showNotification(`${msg.userName} joined (${msg.memberCount} watching)`);
          break;

        case "member-left":
          if (typeof msg.memberCount === "number") roomMemberCount = msg.memberCount;
          showNotification(`${msg.userName} left (${msg.memberCount} watching)`);
          break;

        case "navigate":
          applyRemoteNavigate(msg);
          break;

        // This tab is not the party any more: the user left the room, or attached the
        // party to a different tab. Nothing else would tell us, and a tab that still
        // thinks it is in a room keeps a live overlay up and keeps trying to drive sync.
        case "room-ended":
          inRoom = false;
          currentRoom = null;
          stopHeartbeat();
          showNotification(msg.reason === "moved" ? "The party moved to another tab" : "Left the room");
          break;

        // The socket dropped and came back. We may have missed every sync in between,
        // so do not trust our position: re-fetch the room's.
        case "connection-status":
          if (msg.connected && inRoom) requestResync();
          break;

        case "error":
          showNotification(`Error: ${msg.message}`);
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      // Suppress bfcache error
      // Reading lastError is what clears it. A back/forward-cache teardown sets it, and an
      // unread lastError prints a console error for something the user did not do.
      void chrome.runtime.lastError;
      port = null;
      setTimeout(connectToBackground, 1000);
    });
  }

  // A small centred card the viewer can act on. Used for the two moments where the
  // extension needs a real click and cannot fake one: the browser refusing a remote play
  // without a user gesture, and an invite link asking to put you in a stranger's room.
  // Monochrome, no host-page CSS inherited, above every player chrome.
  function showActionCard(id, title, detail, actionLabel, onAction) {
    dismissActionCard(id);
    const card = document.createElement("div");
    card.id = id;
    card.style.cssText = `
      all: initial;
      position: fixed;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      z-index: 2147483647;
      background: rgba(20,20,22,0.96);
      color: #fff;
      padding: 20px 22px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.14);
      box-shadow: 0 18px 60px rgba(0,0,0,0.55);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      text-align: center;
      max-width: 330px;
    `;
    const h = document.createElement("div");
    h.textContent = title;
    h.style.cssText = "all:initial;display:block;font-family:inherit;color:#fff;font-size:15px;font-weight:600;margin-bottom:6px;";
    const p2 = document.createElement("div");
    p2.textContent = detail;
    p2.style.cssText = "all:initial;display:block;font-family:inherit;color:rgba(235,235,245,0.6);font-size:13px;line-height:1.45;margin-bottom:14px;";
    const row = document.createElement("div");
    row.style.cssText = "all:initial;display:flex;gap:8px;justify-content:center;";
    const go = document.createElement("button");
    go.textContent = actionLabel;
    go.style.cssText = "all:initial;font-family:inherit;cursor:pointer;background:#7c3aed;color:#fff;font-size:13px;font-weight:600;padding:9px 18px;border-radius:8px;";
    const no = document.createElement("button");
    no.textContent = "Not now";
    no.style.cssText = "all:initial;font-family:inherit;cursor:pointer;background:rgba(255,255,255,0.1);color:rgba(235,235,245,0.75);font-size:13px;font-weight:500;padding:9px 14px;border-radius:8px;";
    go.addEventListener("click", () => { dismissActionCard(id); onAction(); });
    no.addEventListener("click", () => dismissActionCard(id));
    row.appendChild(go);
    row.appendChild(no);
    card.appendChild(h);
    card.appendChild(p2);
    card.appendChild(row);
    (document.body || document.documentElement).appendChild(card);
    return card;
  }

  function dismissActionCard(id) {
    const existing = document.getElementById(id);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  const GESTURE_CARD_ID = "wt-gesture-prompt";

  function showGesturePrompt() {
    if (awaitingGesture) return;
    awaitingGesture = true;
    showActionCard(
      GESTURE_CARD_ID,
      "Click to start watching",
      "Your browser blocks playback that you did not start yourself. One click and you are back in sync with the room.",
      "Play",
      () => {
        awaitingGesture = false;
        const v = activeVideo || findVideo();
        if (v) v.play().catch(() => {});
        requestResync();
      }
    );
  }

  function clearGesturePrompt() {
    if (!awaitingGesture) return;
    awaitingGesture = false;
    dismissActionCard(GESTURE_CARD_ID);
  }

  // On-page notification overlay
  let notificationTimer = null;
  function showNotification(text) {
    let container = document.getElementById("wt-notification");
    if (!container) {
      container = document.createElement("div");
      container.id = "wt-notification";
      container.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 2147483647;
        background: rgba(0, 0, 0, 0.85);
        color: #fff;
        padding: 12px 20px;
        border-radius: 8px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px;
        max-width: 300px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        transition: opacity 0.3s;
        pointer-events: none;
      `;
      document.body.appendChild(container);
    }
    container.textContent = text;
    container.style.opacity = "1";
    // One timer, restarted. Two notifications a second apart used to leave the first
    // one's timer running, so the second vanished after two seconds instead of three.
    clearTimeout(notificationTimer);
    notificationTimer = setTimeout(() => {
      container.style.opacity = "0";
    }, 3000);
  }

  // --- SPA Navigation detection ---
  // Detect when the user changes videos within the same site (e.g. YouTube next-up,
  // Netflix next episode) and broadcast a navigate event so the room stays in sync.
  let lastKnownUrl = location.href;
  function checkUrlChange() {
    if (location.href === lastKnownUrl) return;
    const oldUrl = lastKnownUrl;
    const wasSameVideo = normalizeUrl(oldUrl) === normalizeUrl(location.href);
    lastKnownUrl = location.href;
    // Clicking a chapter marker, or "copy link at current time", rewrites the URL through
    // the History API without changing the video at all. The receiving side normalises
    // before comparing; the sending side did not, so that rewrite broadcast a navigate
    // and hard-reloaded every peer's tab off a video nobody had left.
    if (wasSameVideo) return;
    // New video, new content length. Carrying the old one over would make a short clip
    // that follows a long film look like a permanent ad. Relearn it from scratch.
    contentDuration = 0;
    if (!inRoom) return;
    // If we just received and applied a remote navigate, don't echo it back.
    if (Date.now() < suppressNextNavigateUntil) return;
    // Reset state - fresh video, fresh broadcast guard
    lastBroadcastTime = 0;
    cancelRateNudge(activeVideo);
    activeVideo = null;
    pendingPlaybackState = null;
    console.log("[WatchTogether] URL changed:", oldUrl, "→", location.href);
    sendMsg({ type: "navigate", url: location.href });
  }
  setInterval(checkUrlChange, NAV_POLL_MS);
  window.addEventListener("popstate", () => setTimeout(checkUrlChange, 50));

  // Apply a remote navigate by hard-redirecting the tab. Background preserves the room
  // membership across page loads, and the new page's content script will resume sync.
  function applyRemoteNavigate(msg) {
    if (!msg || !msg.url) return;

    // This is a remote tab-redirect primitive: whoever is in the room decides where this
    // browser goes next. `javascript:` and `data:` both parse cleanly through new URL(),
    // and a javascript: URL assigned to location.href runs in whatever origin the viewer
    // currently has open, not ours. The relay filters schemes too, but Settings lets
    // anyone repoint the extension at any relay, so the server is not a control we own.
    // Refuse anything that is not an ordinary web page, here, on the client.
    if (!window.__wtConfig || !window.__wtConfig.isSafeNavigateUrl(msg.url)) {
      console.warn("[WatchTogether] Refused a navigate to a non-web URL");
      return;
    }

    let target;
    try {
      const u = new URL(msg.url);
      // Append room code so even a fresh content-script context auto-rejoins
      if (currentRoom) u.searchParams.set("wt_room", currentRoom);
      target = u.toString();
    } catch {
      return;
    }

    // Already where the room wants us: cancel any redirect still pending. This is the
    // tiebreaker when two people switch apps at the same instant. The server now echoes
    // every navigate back to its sender and delivers them in the order it settled on, so
    // the last one wins for everyone: whoever sent the losing URL first gets told to
    // redirect, then immediately gets the winning URL (which is their own current page) and
    // cancels that redirect. Without this, they would follow the stale one and strand there.
    if (normalizeUrl(target) === normalizeUrl(location.href)) {
      if (pendingNavigateTimer) { clearTimeout(pendingNavigateTimer); pendingNavigateTimer = null; }
      return;
    }

    // Avoid a feedback loop: block our own URL-watcher from re-broadcasting after the redirect
    suppressNextNavigateUntil = Date.now() + 8000;
    showNotification(`${msg.fromUser || "Someone"} switched videos - joining…`);
    // Persist a join hint so auto-join picks up if the new page lacks the param
    if (currentRoom) {
      // consented: we are already in this room, this is the room moving, not an invite.
      chrome.storage.local.set({
        pendingJoin: { roomCode: currentRoom, timestamp: Date.now(), consented: true },
      });
    }
    // A newer navigate supersedes an older one, so only ever hold one pending redirect.
    if (pendingNavigateTimer) clearTimeout(pendingNavigateTimer);
    pendingNavigateTimer = setTimeout(() => { pendingNavigateTimer = null; location.href = target; }, 250);
  }

  // Watch for dynamically loaded videos (SPA navigation) - debounced
  let mutationTimer = null;
  const observer = new MutationObserver(() => {
    if (mutationTimer) return;
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      rebindIfVideoChanged();
    }, 500);
  });

  // Players do not always remove the element they are replacing. Netflix and YouTube both
  // leave the old <video> attached but inert while a new one takes over, and the old
  // "only look if activeVideo left the DOM" test never fired, so the party kept listening
  // to a dead element and nothing worked again until the next full navigation.
  function rebindIfVideoChanged() {
    if (!activeVideo || !document.contains(activeVideo)) {
      const v = findVideo();
      if (v && v !== activeVideo) attachVideoListeners(v);
      return;
    }
    if (document.querySelectorAll("video").length < 2) return;
    const best = findVideo();
    if (!best || best === activeVideo) return;
    // Only defect to a clearly better candidate: the one on screen, while ours is not.
    const oursDead = isDecorative(activeVideo) || activeVideo.readyState === 0;
    if (oursDead) attachVideoListeners(best);
  }
  // Cheap backstop for players that swap the element without touching the DOM around it.
  setInterval(() => { if (inRoom) rebindIfVideoChanged(); }, 3000);

  observer.observe(document.body, { childList: true, subtree: true });

  // --- Auto-join via chrome.storage.local (bulletproof) ---
  // auto-join-extract.js writes { pendingJoin: { roomCode, timestamp } } to chrome.storage
  // We read it here, join the room, then clear it.

  function checkPendingJoin() {
    chrome.storage.local.get(["pendingJoin", "userName"], /** @param {any} data */ (data) => {
      if (!data.pendingJoin) return;

      const { roomCode, timestamp } = data.pendingJoin;

      // Clear the hint first, unconditionally. It is a one-shot: consumed or not, it must
      // not outlive this check. A hint left behind because we were already in the room is
      // live bait for the next tab the user opens (the content script runs everywhere),
      // and that tab would yank the party binding away from the actual video.
      chrome.storage.local.remove("pendingJoin");

      if (inRoom) return;
      if (Date.now() - timestamp > 120000) return; // stale, older than 2 minutes
      if (!window.__wtConfig || !window.__wtConfig.isJoinableCode(roomCode)) return;

      const name = data.userName || "User";

      const join = () => {
        showNotification(`Joining room ${roomCode}...`);
        sendMsg({ type: "join-room", roomCode, userName: name });
        // Timeout fallback
        setTimeout(() => {
          if (!inRoom) {
            showNotification("Join timed out. Enter the code in the extension.");
          }
        }, 20000);
      };

      // A hint we wrote ourselves, because the room moved and we are following it, needs
      // no permission: the user is already in that room. A hint that came off a page's
      // ?wt_room= parameter is different. This content script runs on <all_urls>, so ANY
      // page could hand out a code, and joining silently makes whoever sent the link a
      // peer, with a peer's power to move this tab. That is one click's worth of consent.
      if (data.pendingJoin.consented === true) {
        join();
        return;
      }

      showActionCard(
        "wt-join-consent",
        `Join room ${roomCode}?`,
        "This link is inviting you into a watch party. Whoever is in the room can play, pause and change what this tab is showing.",
        "Join room",
        join
      );
    });
  }

  // A backgrounded tab gets its timers throttled and a sleeping laptop stops the video
  // clock entirely, so on the way back we are silently behind by however long we were
  // gone. Come back, ask the room where it is, snap to it.
  let hiddenSince = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenSince = Date.now();
      return;
    }
    const away = hiddenSince ? Date.now() - hiddenSince : 0;
    hiddenSince = 0;
    if (inRoom && away > 5000) requestResync();
  });

  // Network came back. The socket reconnects on its own; make sure playback does too.
  window.addEventListener("online", () => {
    if (inRoom) setTimeout(requestResync, 1500);
  });

  // Shared handle for overlay.js. Both run in the same content-script world, so the
  // overlay can read sync health and force a resync without a background round trip.
  window.__wtCore = {
    resync: requestResync,
    isInRoom: () => inRoom,
    // Drift goes stale fast: report null rather than a number the user would misread.
    getDrift: () => (Date.now() - lastDriftAt > 12000 ? null : lastDrift),
  };

  // Initialize
  connectToBackground();

  // Try to find video on load
  setTimeout(() => {
    const v = findVideo();
    if (v) attachVideoListeners(v);
  }, 1000);

  // Check for pending join - retry until port is ready
  let joinCheckCount = 0;
  const joinCheck = setInterval(() => {
    joinCheckCount++;
    if (port && !inRoom) {
      checkPendingJoin();
    }
    if (inRoom || joinCheckCount > 30) {
      clearInterval(joinCheck);
    }
  }, 1000);

  // Also check on storage changes (for SPA navigation)
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.pendingJoin && changes.pendingJoin.newValue && !inRoom && port) {
      checkPendingJoin();
    }
  });
})();
