# Watch Together

[![Server status](https://img.shields.io/website?url=https%3A%2F%2Fwatch-together-server-acwi.onrender.com%2Fhealth&up_message=up&down_message=down&label=server)](https://watch-together-server-acwi.onrender.com/health)
[![Latest release](https://img.shields.io/github/v/release/ArnavGoel03/watch-together?label=release)](https://github.com/ArnavGoel03/watch-together/releases/latest)

Sync video playback across any number of devices worldwide. Works on any website with an HTML5 video player — together in real time.

## How It Works

```
User A (any browser)          Sync Server (Render)          User B (any browser)
     │                              │                              │
     │  play/pause/seek ──────────► │ ──────────► play/pause/seek  │
     │                              │                              │
     │  ◄────────────── heartbeat   │   heartbeat ──────────────►  │
     │        (drift correction)    │      (drift correction)      │
     │                              │                              │
     │  chat message ──────────────►│──────────────► chat message  │
     │                              │                              │
```

1. One user creates a room — gets a 6-character code
2. Others join with the code or a shareable link
3. Anyone plays, pauses, seeks, or changes speed — it syncs to everyone instantly
4. Built-in chat for talking while watching
5. Host-only mode available — restrict controls to one person

## Features

- **Real-time sync** — play, pause, seek, playback rate all sync across devices
- **Equal control** — everyone can control playback (or switch to host-only mode)
- **In-player overlay** — Watch Together button injected directly into YouTube, Netflix, JioHotstar, Disney+, HBO Max, Amazon Prime Video controls
- **Share links** — `https://youtube.com/watch?v=xyz&wt_room=ABC123` — paste and join
- **Auto-join** — share link opens the video and joins the room automatically
- **Text chat** — built into the popup and overlay
- **Drift correction** — heartbeat every 5 seconds keeps everyone within 0.5 seconds
- **Ad detection** — skips sync during YouTube and JioHotstar ads
- **Works everywhere** — any site with an HTML5 `<video>` element

## Architecture

```
watch-together/
├── server/                    # Node.js WebSocket sync server
│   ├── server.js              # Main server — rooms, sync, chat, host mode
│   ├── server.test.js         # 59 server tests (vitest)
│   ├── browser.test.js        # Puppeteer browser integration tests
│   ├── package.json
│   ├── Dockerfile
│   └── render.yaml            # One-click Render deployment
│
├── extension/                 # Chrome extension (Manifest V3)
│   ├── manifest.json          # MV3 manifest — permissions, content scripts
│   ├── manifest.firefox.json  # Firefox MV2 manifest
│   ├── background.js          # Service worker — WebSocket connection, message routing
│   ├── background-firefox.js  # Firefox background script
│   ├── auto-join-extract.js   # Runs at document_start — captures wt_room param
│   ├── content.js             # Video detection, sync apply, heartbeat, auto-join
│   ├── overlay.js             # In-player UI — button + panel in video controls
│   ├── adapters/              # Site-specific video player adapters
│   │   ├── generic.js         # Default HTML5 video adapter
│   │   ├── youtube.js         # YouTube player + ad detection
│   │   ├── netflix.js         # Netflix player buttons
│   │   └── jiohotstar.js      # JioHotstar player + ad skip
│   ├── popup/                 # Extension popup UI
│   │   ├── popup.html
│   │   ├── popup.css          # Apple-style dark theme
│   │   └── popup.js
│   └── icons/
│
├── privacy-policy.html        # Hosted on GitHub Pages
├── store-listing.md           # Chrome Web Store listing copy
└── DEPLOY.md                  # Deployment guide
```

## Tech Stack

| Component | Technology |
|---|---|
| **Server** | Node.js + `ws` (WebSocket) |
| **Extension** | Chrome Manifest V3 |
| **Communication** | WebSocket (persistent connection) |
| **Hosting** | Render (free tier + keep-alive) |
| **Testing** | Vitest + Puppeteer |
| **CI** | Render auto-deploy on push |

## Server

Single Node.js process. All state is in memory — rooms are ephemeral.

### Key design decisions

- **WebSocket relay** — chosen over WebRTC for reliability behind firewalls
- **Heartbeat leader election** — only one user per room sends heartbeats to avoid N^2 message storm
- **Heartbeat cooldown** — 2-second cooldown after sync events prevents heartbeats from overriding user actions
- **Host mode** — server-enforced, not client-side. Sync messages from non-hosts are rejected
- **Host transfer** — when host leaves in host mode, ownership transfers to next member and mode switches to "everyone"

### Security

- Per-IP connection limit (10 max)
- Rate limiting (20 messages/second per user)
- Input sanitization on all user data
- URL validation — only `http://` and `https://` allowed (blocks `javascript:` injection)
- XSS headers on join page (`X-Frame-Options: DENY`, CSP)
- `/room/` endpoint doesn't leak video URLs or member counts
- No `/stats` endpoint — room codes not enumerable
- Dead connection detection via WebSocket ping/pong every 30 seconds
- Room TTL — auto-cleanup after 12 hours of inactivity
- Graceful shutdown — notifies all clients on restart

### Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `PORT` | 3000 | Server port |
| `MAX_ROOM_MEMBERS` | 50 | Max users per room |
| `MAX_ROOMS` | 10000 | Max concurrent rooms |
| `ROOM_TTL_HOURS` | 12 | Room expiry |
| `RATE_LIMIT_MAX` | 20 | Messages per second per user |
| `MAX_CONNECTIONS_PER_IP` | 10 | WebSocket connections per IP |

## Extension

### Content scripts (load order)

1. **`auto-join-extract.js`** (`document_start`) — captures `?wt_room=CODE` from URL before the page's JS can strip it, stores in `chrome.storage.local`
2. **`adapters/*.js`** (`document_idle`) — register site-specific video player adapters
3. **`content.js`** (`document_idle`) — finds video elements, attaches event listeners, sends/receives sync, handles auto-join
4. **`overlay.js`** (`document_idle`) — injects Watch Together button into video player controls

### Sync flow

```
User presses play
    → content.js onVideoEvent()
    → port.postMessage({ type: "sync", action: "play", ... })
    → background.js receives
    → WebSocket sends to server
    → server broadcasts to all other members
    → other users' background.js receives
    → broadcasts to content.js via port
    → content.js applySync()
    → video.play() + video.currentTime = ...
```

### Auto-join flow (share link)

```
Share link: https://youtube.com/watch?v=xyz&wt_room=ABC123

1. auto-join-extract.js (document_start)
   → reads ?wt_room from URL
   → writes to chrome.storage.local({ pendingJoin: { roomCode, timestamp } })
   → cleans URL

2. content.js (document_idle)
   → reads chrome.storage.local("pendingJoin")
   → sends join-room to background
   → background connects WebSocket + joins room
   → server sends room-joined with playback state
   → content.js applies playback state to video
```

### Port management

Each content script and overlay connects a separate port to the background service worker. Ports are keyed by `"tabId:portName"` (e.g., `"123:content"`, `"123:overlay"`) to prevent collision.

### MV3 lifecycle

Chrome can kill the service worker after 30 seconds of inactivity. On restart:
- `currentRoom` and `userId` are restored from `chrome.storage.local`
- WebSocket reconnects with exponential backoff
- Auto-rejoin the room on reconnect

## Testing

### Server tests (59 tests, ~12 seconds)

```bash
cd server && npm test
```

| Category | Tests |
|---|---|
| Static checks | 3 — syntax validation, manifest, no hardcoded localhost |
| HTTP endpoints | 5 — health, room lookup, redirects, security headers |
| Room lifecycle | 7 — create, join, leave, disconnect, rejoin |
| Sync core | 11 — play/pause/seek/rate, no echo, late joiner, validation |
| Sync stress | 5 — 50 rapid events, alternating users, 10 simultaneous users |
| Host mode | 16 — block/allow, toggle, rapid toggle, host leaves, late joiner |
| Heartbeat | 3 — leader assignment, leader-only broadcast, reassignment |
| Chat | 3 — broadcast, truncation, empty rejection |
| Security | 3 — rate limiting, bad input, data leak prevention |
| End-to-end | 3 — full session, late joiner, guest churn |

### Browser tests (Puppeteer)

```bash
cd server && npm run test:browser
```

Launches real Chrome with the extension loaded. Tests room creation, two-tab sync, overlay injection, and auto-join.

## Deployment

### Server (Render)

Already deployed at `wss://watch-together-server-acwi.onrender.com`. Auto-deploys on push to `main`.

Self-ping keep-alive every 13 minutes prevents Render free tier sleep.

### Extension

**Chrome/Edge/Brave/Opera:**
```bash
cd extension && zip -r ../watch-together.zip . -x "manifest.firefox.json" "background-firefox.js"
```
Upload to [Chrome Web Store Developer Console](https://chrome.google.com/webstore/devconsole).

**Firefox:**
Rename `manifest.firefox.json` → `manifest.json`, `background-firefox.js` → `background.js`, zip, upload to [Firefox Add-ons](https://addons.mozilla.org/developers/).

### Privacy Policy

Hosted at: https://arnavgoel03.github.io/watch-together/privacy-policy.html

## Browser Support

| Browser | How |
|---|---|
| Chrome | Manifest V3 extension |
| Edge | Same extension (Chromium) |
| Brave | Same extension (Chromium) |
| Opera | Same extension (Chromium) |
| Firefox | Separate MV2 manifest |
| Safari | Safari Web Extension wrapper (same codebase) |

## Supported Sites

Works on any site with an HTML5 `<video>` element. Site-specific adapters for:

- YouTube (ad detection, player selectors)
- Netflix (custom play/pause buttons)
- JioHotstar (ad skip, player selectors)
- Disney+, HBO Max, Amazon Prime Video, Hulu, Twitch (generic adapter)

## License

MIT
