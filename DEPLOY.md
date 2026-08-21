# Watch Together: Deployment Guide

## Step 1: Deploy the Server (free, 5 minutes)

Your server must be publicly accessible so users worldwide can connect. Pick one:

### Option A: Render (recommended, free tier)

1. Push the `server/` folder to a GitHub repo
2. Go to https://render.com → New Web Service
3. Connect your repo, set root directory to `server/`
4. Settings:
   - Build command: `npm ci --production`
   - Start command: `node server.js`
5. Click Deploy
6. Your URL will be like: `wss://watch-together-server.onrender.com`

### Option B: Railway (free tier)

1. Go to https://railway.app → New Project → Deploy from GitHub
2. Select your repo, set root to `server/`
3. Railway auto-detects Node.js
4. Your URL will be like: `wss://watch-together-server.up.railway.app`

### Option C: Fly.io (free tier)

```bash
cd server
fly launch
fly deploy
```

### Option D: Docker (any VPS)

```bash
cd server
docker build -t watch-together .
docker run -p 3000:3000 watch-together
```

### Keeping a free-tier server awake

Render's free tier sleeps after about 15 minutes of no traffic, and the first connection
after that pays a cold start. There used to be a self-ping in `server.js` meant to prevent
this; it pinged `http://localhost` from inside the container, which never reaches Render's
front door and therefore never reset the idle timer. It has been removed rather than left
in place looking like it worked.

To actually keep it warm, point something external at the public health endpoint every
10 to 13 minutes: cron-job.org and UptimeRobot both do this on a free plan, as does a
scheduled GitHub Action.

```
GET https://YOUR-SERVER-URL/health
```

Cloudflare has no equivalent problem: Durable Objects hibernate and wake on the next
message, with no cold-start penalty of this kind.

## Step 2: Point the Extension at Your Server

The server URL lives in exactly ONE place: `extension/config.js`.

```js
const SERVER_URLS = [
  "wss://your-server-url-here",
];
```

It is a list, in priority order, not a single value. If the first relay does not answer,
the extension moves to the next one on its own.

### Moving to a different backend later, without a store update

This is the important part. The server can be redeployed in seconds; the extension cannot,
because it has to clear Chrome Web Store review and then wait for browsers to auto-update.
So the OLD server is what migrates your users.

1. Stand up the new relay and confirm it works.
2. On the OLD server, set `SERVER_MOVED_URL` to the new `wss://` address and restart it.
3. Every client that connects is told to move, remembers the new address, and reconnects
   there. Nothing is stranded, and no release is involved.
4. At your leisure, add the new URL to `SERVER_URLS` in `config.js` so fresh installs go
   straight to it, and ship that whenever you next have a release to make.

A user who has set their own server in Settings always keeps it: their explicit choice
outranks anything a server tells the extension.

## Step 3: Publish to Chrome Web Store

1. Build the packages:
   ```bash
   npm run package
   ```
   This writes `dist/watch-together-chrome-v<version>.zip` and the Firefox equivalent. It
   refuses to produce a package that is missing a file its manifest references, or that
   carries anything that should never ship. Do not zip the folder by hand: the command
   that used to be documented here shipped local editor directories into the store.
2. Go to https://chrome.google.com/webstore/devconsole
3. Pay the one-time $5 developer fee
4. Click "New Item" → upload the zip
5. Fill in:
   - **Category**: Social & Communication
   - **Language**: English (add Hindi for Indian audience)
   - **Description**: Use the text from `store-listing.md`
   - **Screenshots**: Take screenshots of the popup and a synced video
   - **Privacy policy**: Host `privacy-policy.html` somewhere (GitHub Pages works)
6. Submit for review (takes 1-3 business days)

## Step 4: Publish to Firefox Add-ons

1. Rename `manifest.firefox.json` to `manifest.json` (backup the MV3 one)
2. Replace `background.js` with `background-firefox.js`
3. Zip and upload to https://addons.mozilla.org/developers/
4. Submit for review

## Step 5: Publish to Edge Add-ons

1. Use the same Chrome zip (Edge supports MV3)
2. Go to https://partner.microsoft.com/dashboard/microsoftedge
3. Upload and submit

## Why You Can't Use Your Local Machine

Your home computer:
- Has a private IP behind a router (not reachable from the internet)
- IP address changes periodically (dynamic IP from ISP)
- Goes to sleep / shuts down
- Firewall blocks incoming connections

Cloud servers (Render/Railway) give you:
- A permanent public URL
- 24/7 uptime
- SSL/WSS (required by browsers for secure WebSocket)
- Free tier is enough for thousands of users
