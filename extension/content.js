// Content script — detects video elements and syncs playback

(function () {
  if (window.__watchTogetherLoaded) return;
  window.__watchTogetherLoaded = true;

  const DRIFT_IGNORE = 0.5;       // < this: do nothing
  const DRIFT_HARD_SEEK = 1.5;    // > this: hard seek
  const DRIFT_MAX_RATE_DELTA = 0.10; // up to ±10% playbackRate nudge
  const HEARTBEAT_INTERVAL = 5000; // 5 seconds
  const HEARTBEAT_COOLDOWN = 2000; // skip heartbeat for 2s after receiving/sending a sync
  const FULLSCREEN_GUARD_MS = 1500; // ignore video events for this long after fullscreenchange
  const NAV_POLL_MS = 1000;        // detect SPA URL changes
  const SUSPECT_JUMP_GRACE_MS = 1500; // protect against player remount jumping to 0

  let port = null;
  let activeVideo = null;
  let adapter = null;
  let isSyncing = false; // flag to prevent echo loops
  let heartbeatTimer = null;
  let inRoom = false;
  let currentRoom = null;
  let isHeartbeatLeader = false;
  let pendingPlaybackState = null; // for applying sync after video loads
  let lastSyncTime = 0; // timestamp of last sync event (sent or received)
  let lastBroadcastTime = 0; // last currentTime we sent — used to detect suspect jumps
  let lastBroadcastAt = 0;
  let serverClockOffset = 0; // (server epoch ms) - (local epoch ms), EWMA-smoothed
  let serverClockSamples = 0;
  let fullscreenGuardUntil = 0;
  let activeRateNudge = null;   // { normalRate, restoreTimer }
  let suppressNextNavigateUntil = 0; // when we just applied a remote nav, don't echo

  function isLiveStream(video) {
    if (!video) return false;
    const d = video.duration;
    return d === Infinity || d === Number.POSITIVE_INFINITY || (typeof d === "number" && d > 1e6);
  }

  function updateClockOffset(serverTime) {
    if (typeof serverTime !== "number") return;
    const sample = serverTime - Date.now();
    if (serverClockSamples === 0) {
      serverClockOffset = sample;
    } else {
      // EWMA: weight new sample at 15%, fast enough to converge after a few messages
      serverClockOffset = serverClockOffset * 0.85 + sample * 0.15;
    }
    serverClockSamples++;
  }

  function nowServer() {
    return Date.now() + serverClockOffset;
  }

  // Pick the right adapter for this site
  function getAdapter() {
    const host = window.location.hostname;
    if (host.includes("jiohotstar") || host.includes("hotstar")) {
      return window.__watchTogetherAdapters?.jiohotstar;
    }
    if (host.includes("netflix")) {
      return window.__watchTogetherAdapters?.netflix;
    }
    if (host.includes("youtube")) {
      return window.__watchTogetherAdapters?.youtube;
    }
    return window.__watchTogetherAdapters?.generic;
  }

  // Find the main video element on the page
  function findVideo() {
    if (adapter && adapter.findVideo) {
      return adapter.findVideo();
    }
    const videos = Array.from(document.querySelectorAll("video"));
    if (videos.length === 0) return null;
    if (videos.length === 1) return videos[0];
    return videos.reduce((best, v) => {
      const area = v.clientWidth * v.clientHeight;
      const bestArea = best.clientWidth * best.clientHeight;
      return area > bestArea ? v : best;
    });
  }

  // Attach event listeners to the video
  function attachVideoListeners(video) {
    if (!video || video === activeVideo) return;
    if (activeVideo) detachVideoListeners(activeVideo);
    activeVideo = video;
    // Reset the suspect-jump guard so a fresh element doesn't trip it before any real time accumulates
    lastBroadcastTime = 0;
    lastBroadcastAt = 0;

    const events = ["play", "pause", "seeked", "ratechange"];
    events.forEach((event) => {
      video.addEventListener(event, onVideoEvent);
    });

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

  function isAdPlaying() {
    // YouTube
    if (document.querySelector(".ad-showing, .ytp-ad-player-overlay")) return true;
    // JioHotstar — short duration video is usually an ad
    if (activeVideo && activeVideo.duration && activeVideo.duration < 30) {
      const host = window.location.hostname;
      if (host.includes("hotstar") || host.includes("jiohotstar")) return true;
    }
    return false;
  }

  function onVideoEvent(e) {
    if (isSyncing || !inRoom || isAdPlaying()) return;

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

    // Suspect-jump guard: a fresh seek to ~0 right after we knew the video was much further in
    // is almost always a player remount, not a real user seek. Drop it.
    const ct = video.currentTime;
    if ((action === "seek" || action === "play") && ct < 1.5) {
      const sinceLast = Date.now() - lastBroadcastAt;
      if (lastBroadcastTime > 5 && sinceLast < SUSPECT_JUMP_GRACE_MS) return;
    }

    const live = isLiveStream(video);

    lastSyncTime = Date.now();
    lastBroadcastTime = ct;
    lastBroadcastAt = Date.now();

    sendMsg({
      type: "sync",
      action,
      playing: !video.paused,
      // Live streams: don't propagate currentTime — DVR offsets differ per viewer.
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
          chrome.storage.local.set({
            pendingJoin: { roomCode: msg.roomCode, timestamp: Date.now() },
          });
        }
        connectToBackground();
      }
    }
  }

  // Cancel any in-flight rate nudge — used when a hard correction overrides it
  function cancelRateNudge(video) {
    if (!activeRateNudge) return;
    if (activeRateNudge.restoreTimer) clearTimeout(activeRateNudge.restoreTimer);
    if (video && Math.abs(video.playbackRate - activeRateNudge.normalRate) > 0.01) {
      isSyncing = true;
      try { video.playbackRate = activeRateNudge.normalRate; } catch {}
      setTimeout(() => { isSyncing = false; }, 200);
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

    isSyncing = true;
    try { video.playbackRate = targetRate; } catch {}
    setTimeout(() => { isSyncing = false; }, 200);

    activeRateNudge.restoreTimer = setTimeout(() => {
      if (video && Math.abs(video.playbackRate - targetRate) < 0.05) {
        isSyncing = true;
        try { video.playbackRate = normalRate; } catch {}
        setTimeout(() => { isSyncing = false; }, 200);
      }
      activeRateNudge = null;
    }, closeMs);
  }

  // Apply sync state from another user
  function applySync(msg) {
    if (msg && typeof msg.serverTime === "number") updateClockOffset(msg.serverTime);

    const video = activeVideo || findVideo();
    if (!video) {
      pendingPlaybackState = msg;
      // Clear stale pending state after 30s
      setTimeout(() => { if (pendingPlaybackState === msg) pendingPlaybackState = null; }, 30000);
      return;
    }
    if (!activeVideo) attachVideoListeners(video);

    // Wait for video to have metadata before seeking
    if (!video.duration || video.readyState < 1) {
      pendingPlaybackState = msg;
      video.addEventListener("loadedmetadata", function onMeta() {
        video.removeEventListener("loadedmetadata", onMeta);
        applySync(msg);
      });
      return;
    }

    const live = isLiveStream(video) || !!msg.isLive;
    const isHeartbeat = msg.type === "heartbeat";
    const normalRate = msg.playbackRate || 1;

    isSyncing = true;
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

    if (adapter && adapter.applyState) {
      // Adapter handles its own seeking; pass adjusted state
      adapter.applyState(video, { ...msg, currentTime: targetTime });
    } else {
      if (live) {
        // Live: never seek. Just sync play/pause/rate.
        if (normalRate && Math.abs(video.playbackRate - normalRate) > 0.01) {
          video.playbackRate = normalRate;
        }
      } else {
        const drift = targetTime - video.currentTime; // + means we're behind
        const absDrift = Math.abs(drift);
        if (absDrift < DRIFT_IGNORE) {
          // tiny — let it ride
        } else if (isHeartbeat && absDrift < DRIFT_HARD_SEEK) {
          // smooth correction via playbackRate nudge — no audio glitch
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
        video.play().catch(() => {});
      } else if (!msg.playing && !video.paused) {
        video.pause();
      }
    }

    setTimeout(() => {
      isSyncing = false;
    }, 300);
  }

  // Heartbeat — only the leader sends, everyone receives
  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      const video = activeVideo || findVideo();
      if (!video || !inRoom) return;

      // Skip heartbeat if a sync event happened recently — prevents overriding other users' actions
      if (Date.now() - lastSyncTime < HEARTBEAT_COOLDOWN) return;

      sendMsg({
        type: "heartbeat",
        playing: !video.paused,
        currentTime: video.currentTime,
        playbackRate: video.playbackRate,
      });
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
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
          break;

        case "heartbeat":
          // Ignore heartbeats if we just sent or received a sync — prevents overriding actions
          if (Date.now() - lastSyncTime < HEARTBEAT_COOLDOWN) break;
          applySync(msg);
          break;

        case "heartbeat-role":
          isHeartbeatLeader = msg.isLeader;
          break;

        case "room-created":
        case "room-joined":
          inRoom = true;
          currentRoom = msg.roomCode;
          if (typeof msg.serverTime === "number") updateClockOffset(msg.serverTime);
          adapter = getAdapter();
          console.log(`[WatchTogether] ${msg.type}: ${msg.roomCode}, inRoom=true`);
          const v = findVideo();
          if (v) {
            attachVideoListeners(v);
            console.log("[WatchTogether] Video element found and attached");
          } else {
            console.log("[WatchTogether] No video element found yet");
          }
          startHeartbeat();
          showNotification(
            msg.type === "room-created"
              ? `Room created: ${msg.roomCode}`
              : `Joined room: ${msg.roomCode}`
          );
          // If joining, apply the room's current playback state
          if (msg.type === "room-joined" && msg.playbackState) {
            applySync(msg.playbackState);
          }
          break;

        case "member-joined":
          showNotification(`${msg.userName} joined (${msg.memberCount} watching)`);
          break;

        case "member-left":
          showNotification(`${msg.userName} left (${msg.memberCount} watching)`);
          break;

        case "navigate":
          applyRemoteNavigate(msg);
          break;

        case "error":
          showNotification(`Error: ${msg.message}`);
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      // Suppress bfcache error
      if (chrome.runtime.lastError) {}
      port = null;
      setTimeout(connectToBackground, 1000);
    });
  }

  // On-page notification overlay
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
    setTimeout(() => {
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
    lastKnownUrl = location.href;
    if (!inRoom) return;
    // If we just received and applied a remote navigate, don't echo it back.
    if (Date.now() < suppressNextNavigateUntil) return;
    // Reset state — fresh video, fresh broadcast guard
    lastBroadcastTime = 0;
    lastBroadcastAt = 0;
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
    let target;
    try {
      const u = new URL(msg.url);
      // Append room code so even a fresh content-script context auto-rejoins
      if (currentRoom) u.searchParams.set("wt_room", currentRoom);
      target = u.toString();
    } catch {
      target = msg.url;
    }
    // Avoid a feedback loop: block our own URL-watcher from re-broadcasting after the redirect
    suppressNextNavigateUntil = Date.now() + 8000;
    showNotification(`${msg.fromUser || "Someone"} switched videos — joining…`);
    // Persist a join hint so auto-join picks up if the new page lacks the param
    if (currentRoom) {
      chrome.storage.local.set({
        pendingJoin: { roomCode: currentRoom, timestamp: Date.now() },
      });
    }
    setTimeout(() => { location.href = target; }, 250);
  }

  // Watch for dynamically loaded videos (SPA navigation) — debounced
  let mutationTimer = null;
  const observer = new MutationObserver(() => {
    if (mutationTimer) return;
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      if (!activeVideo || !document.contains(activeVideo)) {
        const v = findVideo();
        if (v && v !== activeVideo) {
          attachVideoListeners(v);
        }
      }
    }, 500);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // --- Auto-join via chrome.storage.local (bulletproof) ---
  // auto-join-extract.js writes { pendingJoin: { roomCode, timestamp } } to chrome.storage
  // We read it here, join the room, then clear it.

  function checkPendingJoin() {
    chrome.storage.local.get(["pendingJoin", "userName"], (data) => {
      if (!data.pendingJoin) return;
      if (inRoom) return;

      const { roomCode, timestamp } = data.pendingJoin;

      // Ignore stale joins (older than 2 minutes)
      if (Date.now() - timestamp > 120000) {
        chrome.storage.local.remove("pendingJoin");
        return;
      }

      console.log("[WatchTogether] Found pending join:", roomCode);

      // Clear it so other tabs don't also try to join
      chrome.storage.local.remove("pendingJoin");

      const name = data.userName || "User";
      showNotification(`Joining room ${roomCode}...`);
      sendMsg({ type: "join-room", roomCode, userName: name });
      console.log("[WatchTogether] Sent join-room as:", name);

      // Timeout fallback
      setTimeout(() => {
        if (!inRoom) {
          showNotification("Join timed out. Enter the code in the extension.");
        }
      }, 20000);
    });
  }

  // Initialize
  connectToBackground();

  // Try to find video on load
  setTimeout(() => {
    const v = findVideo();
    if (v) attachVideoListeners(v);
  }, 1000);

  // Check for pending join — retry until port is ready
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
