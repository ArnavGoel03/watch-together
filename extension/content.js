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

  function onVideoEvent(e) {
    if (isSyncing || !inRoom) return;

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
        connectToBackground();
      }
    }
  }

  // Apply sync state from another user
  function applySync(msg) {
    const video = activeVideo || findVideo();
    if (!video) {
      // Video not ready yet — save state and apply when video loads
      pendingPlaybackState = msg;
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
      setTimeout(connectToBackground, 2000);
      return;
    }

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
          const v = findVideo();
          if (v) attachVideoListeners(v);
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

  // Watch for dynamically loaded videos (SPA navigation)
  const observer = new MutationObserver(() => {
    if (!activeVideo || !document.contains(activeVideo)) {
      const v = findVideo();
      if (v && v !== activeVideo) {
        attachVideoListeners(v);
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Check for auto-join from share link (URL contains ?wt_room=CODE)
  function checkAutoJoin() {
    const params = new URLSearchParams(window.location.search);
    const roomCode = params.get("wt_room");
    if (!roomCode || !port) return;

    // Get saved name from chrome.storage (not localStorage)
    chrome.storage.local.get(["userName"], (data) => {
      const name = data.userName || "User";
      sendMsg({ type: "join-room", roomCode: roomCode.toUpperCase(), userName: name });

      // Clean the URL param so it doesn't re-join on refresh
      const url = new URL(window.location.href);
      url.searchParams.delete("wt_room");
      window.history.replaceState({}, "", url.toString());
    });
  }

  // Initialize
  connectToBackground();

  // Try to find video on load
  setTimeout(() => {
    const v = findVideo();
    if (v) attachVideoListeners(v);
  }, 1000);

  // Check for auto-join — retry a few times since video pages load slowly
  function tryAutoJoin(attempts) {
    if (attempts <= 0) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.get("wt_room")) return;
    if (port) {
      checkAutoJoin();
    } else {
      setTimeout(() => tryAutoJoin(attempts - 1), 1000);
    }
  }
  setTimeout(() => tryAutoJoin(5), 1500);
})();
