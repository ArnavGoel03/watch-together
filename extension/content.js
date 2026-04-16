// Content script — detects video elements and syncs playback

(function () {
  if (window.__watchTogetherLoaded) return;
  window.__watchTogetherLoaded = true;

  const DRIFT_THRESHOLD = 0.5; // seconds — correct if drift exceeds this
  const HEARTBEAT_INTERVAL = 5000; // 5 seconds

  let port = null;
  let activeVideo = null;
  let adapter = null;
  let isSyncing = false; // flag to prevent echo loops
  let heartbeatTimer = null;
  let inRoom = false;
  let isHeartbeatLeader = false;
  let pendingPlaybackState = null; // for applying sync after video loads

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

    const video = e.target;
    const action =
      e.type === "play"
        ? "play"
        : e.type === "pause"
          ? "pause"
          : e.type === "seeked"
            ? "seek"
            : "ratechange";

    sendMsg({
      type: "sync",
      action,
      playing: !video.paused,
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
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

  // Apply sync state from another user
  function applySync(msg) {
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

    isSyncing = true;

    // Compensate for network/server delay if timestamp is available
    let targetTime = msg.currentTime;
    if (msg.playing && msg.timestamp) {
      const elapsedSec = (Date.now() - msg.timestamp) / 1000;
      targetTime += elapsedSec * (msg.playbackRate || 1);
      // Don't seek past end
      if (video.duration && targetTime > video.duration) {
        targetTime = video.duration - 0.5;
      }
    }

    if (adapter && adapter.applyState) {
      adapter.applyState(video, { ...msg, currentTime: targetTime });
    } else {
      if (Math.abs(video.currentTime - targetTime) > DRIFT_THRESHOLD) {
        video.currentTime = targetTime;
      }
      if (msg.playbackRate && video.playbackRate !== msg.playbackRate) {
        video.playbackRate = msg.playbackRate;
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
          applySync(msg);
          break;

        case "heartbeat-role":
          isHeartbeatLeader = msg.isLeader;
          break;

        case "room-created":
        case "room-joined":
          inRoom = true;
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
