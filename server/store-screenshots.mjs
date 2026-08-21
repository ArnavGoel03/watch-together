// Generate the Chrome Web Store screenshots from the extension actually running.
//
// Run: npm --prefix server run screenshots
//
// These have to be genuine captures rather than mockups, so this drives two real browser
// profiles against the real relay, creates a real room, joins it, and photographs the
// result. Two profiles because one profile is one member: a second tab in the same browser
// joins over the same socket and is not a second person.
//
// The page underneath is a neutral player, deliberately. Dressing it up as YouTube or
// Netflix would be someone else's trademark on our store listing.
//
// Store requirements this is built around:
//   1280x800, square corners, full bleed, no padding.
//   Displayed downscaled to 640x400, so every caption is large enough to survive that.

import puppeteer from "puppeteer";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const EXT = path.join(ROOT, "extension");
const OUT = path.join(ROOT, "assets", "store");
const W = 1280, H = 800;
const PORT = 9990;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A believable page for a video to sit on, owned by nobody.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0f0f11;color:#eaeaec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  .top{display:flex;align-items:center;gap:14px;padding:10px 20px;border-bottom:1px solid rgba(255,255,255,.07)}
  .logo{width:26px;height:26px;border-radius:7px;background:linear-gradient(180deg,#3a3a42,#25252b);border:1px solid rgba(255,255,255,.1)}
  .search{flex:1;max-width:440px;height:32px;border-radius:8px;background:#08080a;border:1px solid rgba(255,255,255,.08)}
  .body{display:grid;grid-template-columns:1fr 250px;gap:20px;padding:16px 20px}
  video{width:100%;height:auto;aspect-ratio:16/9;object-fit:cover;border-radius:12px;background:#000;display:block}
  h1{font-size:20px;font-weight:650;letter-spacing:-.02em;margin:14px 0 5px}
  .meta{font-size:13px;color:rgba(234,234,236,.5)}
  .rail{display:flex;flex-direction:column;gap:12px}
  .rec{display:flex;gap:10px}
  .thumb{width:110px;height:62px;border-radius:8px;background:linear-gradient(120deg,#232329,#16161a);flex:0 0 auto}
  .rl{height:9px;border-radius:5px;background:rgba(255,255,255,.09);margin-bottom:7px}
</style></head><body>
  <div class="top"><div class="logo"></div><div class="search"></div></div>
  <div class="body">
    <div>
      <video id="v" width="1000" preload="auto" poster="/still.jpg"><source src="/v.webm" type="video/webm"></video>
      <h1>The Lighthouse Keeper, episode 4</h1>
      <div class="meta">1.2M views  ·  Watching with 2 others</div>
    </div>
    <div class="rail">
      ${Array.from({length:7},()=>`<div class="rec"><div class="thumb"></div><div style="flex:1"><div class="rl" style="width:92%"></div><div class="rl" style="width:64%"></div></div></div>`).join("")}
    </div>
  </div></body></html>`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const video = fs.readFileSync(path.join(ROOT, "server", "fixtures", "test-video.webm"));
  const still = fs.readFileSync(path.join(ROOT, "server", "fixtures", "still.jpg"));

  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/still.jpg")) {
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": still.length });
      return res.end(still);
    }
    if (req.url.startsWith("/v.webm")) {
      res.writeHead(200, { "Content-Type": "video/webm", "Content-Length": video.length, "Accept-Ranges": "bytes" });
      return res.end(video);
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(PORT, r));

  const launch = () => puppeteer.launch({
    headless: "new",
    protocolTimeout: 120000,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
           "--no-first-run", "--mute-audio", "--hide-scrollbars",
           "--autoplay-policy=no-user-gesture-required"],
  });

  const host = await launch();
  const guest = await launch();

  const extId = async (b) => {
    for (let i = 0; i < 50; i++) {
      for (const t of b.targets()) if (t.url().startsWith("chrome-extension://")) return t.url().split("/")[2];
      await sleep(250);
    }
    throw new Error("extension never registered");
  };
  const hostId = await extId(host), guestId = await extId(guest);

  const openVideo = async (b) => {
    const p = await b.newPage();
    await p.setViewport({ width: W, height: H, deviceScaleFactor: 2 });
    await p.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await p.waitForSelector("video");
    await p.waitForFunction(() => document.querySelector("video").readyState >= 2, { timeout: 20000 });
    // Paused on a frame: a moving video makes the capture hang, and a still frame reads
    // better in a listing anyway.
    // Left unplayed on purpose: the poster stays visible, and a decoding video is what\n    // makes the capture hang.
    await p.waitForSelector("#wt-overlay-btn", { timeout: 20000 });
    return p;
  };

  const hostPage = await openVideo(host);
  // Opened for its side effect: the guest needs the video page loaded for the room to
  // have someone in it. The handle itself is never needed, the popup drives the guest.
  await openVideo(guest);

  // Create and join a real room, through the real popup, against the live relay.
  //
  // The popup is anchored over the user's tab in normal use. Opened as a tab it would
  // report ITSELF as the active tab and refuse to create a room, so chrome.tabs.query is
  // pointed at the video tab it is standing in for. Same trick the browser tests use.
  const popup = async (b, id, marker) => {
    const p = await b.newPage();
    await p.evaluateOnNewDocument((mark) => {
      const realQuery = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (info, cb) => {
        if (info && info.active && info.currentWindow) {
          return realQuery({}, (tabs) => {
            const t = tabs.find((x) => (x.url || "").includes(mark));
            cb(t ? [t] : []);
          });
        }
        return realQuery(info, cb);
      };
    }, marker);
    await p.setViewport({ width: 380, height: 640, deviceScaleFactor: 2 });
    await p.goto(`chrome-extension://${id}/popup/popup.html`, { waitUntil: "domcontentloaded" });
    await p.waitForSelector("#btnCreate");
    return p;
  };

  const settle = async (page, fn, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = await page.evaluate(fn).catch(() => "");
      if (v) return v;
      await sleep(250);
    }
    return "";
  };

  const hp = await popup(host, hostId, `localhost:${PORT}`);
  await hp.waitForFunction(() => !document.getElementById("btnCreate").disabled, { timeout: 20000 });
  await hp.evaluate(() => {
    document.getElementById("userName").value = "You";
    document.getElementById("btnCreate").click();
  });
  // #roomCode is the JOIN input; the code we were handed is #displayRoomCode.
  const code = await settle(hp, () => document.getElementById("displayRoomCode")?.textContent?.trim() || "");
  console.log("room created:", code || "(none)");
  if (!code) throw new Error("could not create a room, so the shots would show an empty panel");

  const gp = await popup(guest, guestId, `localhost:${PORT}`);
  await gp.evaluate((c) => {
    document.getElementById("userName").value = "Priya";
    document.getElementById("roomCode").value = c;
    document.getElementById("btnJoin").click();
  }, code);
  const joined = await settle(gp, () => document.getElementById("displayRoomCode")?.textContent?.trim() || "");
  console.log("guest joined:", joined || "(none)");
  await gp.close();
  await hp.close();
  await sleep(1500);

  // Caption band, so the point survives being downscaled to 640x400.
  const caption = (title, sub) => `(() => {
    const old = document.getElementById("wt-shot-caption"); if (old) old.remove();
    const d = document.createElement("div");
    d.id = "wt-shot-caption";
    d.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:2147483000;padding:22px 40px 34px;background:linear-gradient(180deg,rgba(8,8,10,.97) 0%,rgba(8,8,10,.86) 70%,rgba(8,8,10,0) 100%);font-family:-apple-system,BlinkMacSystemFont,sans-serif;pointer-events:none";
    d.innerHTML = '<div style="font-size:32px;font-weight:700;letter-spacing:-.028em;color:#f4f4f5;line-height:1.1">' + ${JSON.stringify(title)} + '</div>' +
                  '<div style="margin-top:9px;font-size:17px;color:rgba(244,244,245,.62)">' + ${JSON.stringify(sub)} + '</div>';
    document.body.appendChild(d);
  })()`;

  const shot = async (page, file, title, sub, prep) => {
    if (prep) await page.evaluate(prep);
    await page.evaluate(caption(title, sub));
    await sleep(700);
    await page.evaluate(() => { const v = document.querySelector("video"); if (v) v.pause(); });
    const out = path.join(OUT, file);
    await page.screenshot({ path: out, captureBeyondViewport: false });
    // Store wants exactly 1280x800; deviceScaleFactor 2 gives 2560x1600.
    console.log("  ", file);
    return out;
  };

  await hostPage.evaluate(() => document.getElementById("wt-overlay-btn")?.click());
  await sleep(1200);

  // Five shots, each carrying one of the things this does that the alternatives do not.
  // Generic claims ("sync your videos!") are what every listing in this category already
  // says; these are the reasons somebody would switch.

  await shot(hostPage, "01-in-sync.png",
    "Everyone stays in step",
    "Play, pause or skip. Whoever moves, the whole room follows.");

  await shot(hostPage, "02-ad-breaks.png",
    "Ad breaks stop scattering everyone",
    "Sit out your own adverts and land back exactly where the room is.",
    () => {
      const l = document.getElementById("wt-members");
      if (l && l.hasAttribute("hidden")) document.getElementById("wt-members-toggle").click();
    });

  await shot(hostPage, "03-who-is-where.png",
    "See exactly who is where",
    "Watching, buffering, or in an ad break. Per person, at a glance.");

  await shot(hostPage, "04-waits-for-you.png",
    "It waits for slow connections",
    "Nobody gets left behind buffering while everyone else carries on.",
    () => {
      const l = document.getElementById("wt-members");
      if (l && !l.hasAttribute("hidden")) document.getElementById("wt-members-toggle").click();
      const a = document.getElementById("wt-advanced"); if (a) a.open = true;
      const w = document.getElementById("wt-wait-slow"); if (w) w.checked = true;
      const f = document.getElementById("wt-wait-field");
      if (f) f.scrollIntoView({ block: "center" });
    });

  await shot(hostPage, "05-works-anywhere.png",
    "Works on any video site",
    "Not just one service. Anywhere with a player, and free.",
    () => {
      const a = document.getElementById("wt-advanced"); if (a) a.open = false;
      const p = document.getElementById("wt-overlay-panel"); if (p) p.classList.remove("wt-visible");
    });

  await host.close(); await guest.close(); server.close();

  // Normalise to the exact pixel size the store expects.
  console.log("\nCaptured at 2x; downscale to 1280x800 with:");
  console.log("  python3 scripts/resize-store-shots.py");
}

main().catch((e) => { console.error(e); process.exit(1); });
