// Overlay — injects Watch Together UI directly into video player controls

(function () {
  if (window.__watchTogetherOverlayLoaded) return;
  window.__watchTogetherOverlayLoaded = true;

  let overlayBtn = null;
  let overlayPanel = null;
  let port = null;
  let inRoom = false;
  let currentRoom = null;
  let userName = "";
  let isConnected = false;

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
        <button class="wt-btn wt-btn-primary" id="wt-create">Create Room</button>
        <div class="wt-divider">or</div>
        <input type="text" id="wt-code" class="wt-input" placeholder="Room code" maxlength="6" style="text-transform:uppercase;letter-spacing:3px;text-align:center">
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
        </div>
        <div class="wt-chat">
          <div class="wt-chat-messages" id="wt-messages"></div>
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
    overlayPanel.querySelector("#wt-copy-code").addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(currentRoom);
      flashText(e.target, "Copied!");
    });
    overlayPanel.querySelector("#wt-copy-link").addEventListener("click", (e) => {
      e.stopPropagation();
      // Teleparty-style: video URL + room code. No server redirect.
      try {
        const url = new URL(location.href);
        url.searchParams.set("wt_room", currentRoom);
        navigator.clipboard.writeText(url.toString());
      } catch {
        navigator.clipboard.writeText(`${location.href}${location.href.includes("?") ? "&" : "?"}wt_room=${currentRoom}`);
      }
      flashText(e.target, "Copied!");
    });
    overlayPanel.querySelector("#wt-send").addEventListener("click", (e) => {
      e.stopPropagation();
      sendChat();
    });
    overlayPanel.querySelector("#wt-chat-input").addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") sendChat();
    });
    overlayPanel.querySelector("#wt-leave").addEventListener("click", (e) => {
      e.stopPropagation();
      leaveRoom();
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
    // Load saved name
    chrome.storage.local.get(["userName"], (data) => {
      const nameInput = overlayPanel.querySelector("#wt-name");
      if (data.userName && nameInput && !nameInput.value) {
        nameInput.value = data.userName;
      }
    });
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
    const name = overlayPanel.querySelector("#wt-name").value.trim();
    if (!name) return;
    userName = name;
    chrome.storage.local.set({ userName: name });
    if (port) port.postMessage({ type: "create-room", userName: name, videoUrl: location.href });
  }

  function joinRoom() {
    const code = overlayPanel.querySelector("#wt-code").value.trim().toUpperCase();
    const name = overlayPanel.querySelector("#wt-name").value.trim();
    if (!code || code.length < 4) return;
    if (!name) return;
    userName = name;
    chrome.storage.local.set({ userName: name });
    if (port) port.postMessage({ type: "join-room", roomCode: code, userName: name });
  }

  function leaveRoom() {
    if (port) port.postMessage({ type: "leave-room" });
    inRoom = false;
    currentRoom = null;
    showView("landing");
    overlayPanel.querySelector("#wt-messages").innerHTML = "";
    updateButtonState();
  }

  function sendChat() {
    const input = overlayPanel.querySelector("#wt-chat-input");
    const text = input.value.trim();
    if (!text) return;
    if (port) port.postMessage({ type: "chat", message: text });
    addChatMsg(userName, text, true);
    input.value = "";
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

  function flashText(el, text) {
    const orig = el.textContent;
    el.textContent = text;
    setTimeout(() => { el.textContent = orig; }, 1200);
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
          inRoom = true;
          if (overlayPanel) {
            overlayPanel.querySelector("#wt-room-code").textContent = msg.roomCode;
            showView("room");
          }
          updateButtonState();
          addSystemMsg("Room created");
          break;

        case "room-joined":
          currentRoom = msg.roomCode;
          inRoom = true;
          if (overlayPanel) {
            overlayPanel.querySelector("#wt-room-code").textContent = msg.roomCode;
            overlayPanel.querySelector("#wt-member-count").textContent = msg.members?.length || 1;
            showView("room");
          }
          updateButtonState();
          addSystemMsg(`Joined with ${msg.members?.length || 1} watching`);
          break;

        case "member-joined":
          if (overlayPanel) {
            overlayPanel.querySelector("#wt-member-count").textContent = msg.memberCount;
          }
          addSystemMsg(`${msg.userName} joined`);
          break;

        case "member-left":
          if (overlayPanel) {
            overlayPanel.querySelector("#wt-member-count").textContent = msg.memberCount;
          }
          addSystemMsg(`${msg.userName} left`);
          break;

        case "chat":
          addChatMsg(msg.userName, msg.message);
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

    port.postMessage({ type: "get-state" });
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
  connectPort();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watchForPlayer);
  } else {
    watchForPlayer();
  }
})();
