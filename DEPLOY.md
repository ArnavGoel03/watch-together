# Watch Together — Deployment Guide

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

## Step 2: Update the Extension

Edit `extension/background.js` line 4:
```js
const DEFAULT_SERVER_URL = "wss://YOUR-SERVER-URL-HERE";
```

## Step 3: Publish to Chrome Web Store

1. Zip the `extension/` folder:
   ```bash
   cd extension && zip -r ../watch-together-extension.zip . -x "manifest.firefox.json" "background-firefox.js"
   ```
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
