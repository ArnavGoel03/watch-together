// Real Firefox MV2 qualification through Puppeteer's WebDriver BiDi transport.
// Two profiles are required: two tabs would share one background and one room member.
import test from "node:test";
import assert from "node:assert/strict";
import puppeteer from "puppeteer";
import { getInstalledBrowsers } from "@puppeteer/browsers";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { waitForListening } from "./test-server.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ADDON_ID = "watch-together@extension";
// installExtension returns the add-on ID, not Firefox's generated URL hostname.
const UUID = "5ca14d20-7b85-4a65-94e1-c2741c215e02";
const POPUP_URL = `moz-extension://${UUID}/popup/popup.html`;
let RELAY_URL;
let popupSequence = 0;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function firefoxExecutable() {
  if (process.env.FIREFOX_EXECUTABLE_PATH) return process.env.FIREFOX_EXECUTABLE_PATH;
  const { cacheDirectory } = await puppeteer.configuration();
  const installed = await getInstalledBrowsers({ cacheDir: cacheDirectory });
  // The current stable patch can be newer than Puppeteer's pinned default revision.
  const stable = installed.filter((browser) => browser.browser === "firefox" && browser.buildId.startsWith("stable_") && existsSync(browser.executablePath));
  stable.sort((a, b) => b.buildId.localeCompare(a.buildId, "en", { numeric: true }));
  assert.ok(stable.length, "Install Firefox first: npx --prefix server puppeteer browsers install firefox@stable");
  return stable[0].executablePath;
}

async function poll(check, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

async function openPopup(browser, marker) {
  const video = (await browser.pages()).find((page) => new URL(page.url()).searchParams.get("tab") === marker);
  assert.ok(video, `No video tab for ${marker}`);
  const id = String(++popupSequence);
  const expectedUrl = `${POPUP_URL}?wt_test_marker=${marker}&wt_test_id=${id}`;
  const launcher = await browser.newPage();
  try {
    // BiDi refuses direct navigation to extension schemes. Have the installed extension
    // create its own page, then attach automation to that already-open browsing context.
    await launcher.goto(`${new URL(video.url()).origin}/__wt_open_popup?marker=${marker}&id=${id}`, { waitUntil: "domcontentloaded", timeout: 10000 });
    const target = await browser.waitForTarget((candidate) => candidate.url() === expectedUrl, { timeout: 10000 });
    const page = await target.page();
    assert.ok(page, "Firefox did not expose the extension popup browsing context");
    page.setDefaultTimeout(10000);
    await page.waitForSelector("#btnCreate");
    return page;
  } finally {
    await launcher.close();
  }
}

function popupTabLookup() {
  // A real toolbar popup sees the underlying video; this document is opened as a tab.
  // Run this adaptation before the unchanged production popup script initializes.
  const marker = new URL(location.href).searchParams.get("wt_test_marker");
  const query = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = (info, callback) => {
    if (info?.active && info.currentWindow) {
      return query({}, (tabs) => callback(tabs.filter((tab) => tab.url?.includes(`tab=${marker}`)).slice(0, 1)));
    }
    return query(info, callback);
  };
}

function popupLauncher() {
  if (location.pathname !== "/__wt_open_popup") return;
  const params = new URL(location.href).searchParams;
  chrome.runtime.sendMessage({ type: "firefox-test-open-popup", marker: params.get("marker"), id: params.get("id") }, () => { void chrome.runtime.lastError; });
}

function popupBridge(fixtureOrigin) {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== "firefox-test-open-popup" || !sender.url || new URL(sender.url).origin !== fixtureOrigin) return false;
    if (!["host", "guest"].includes(message.marker) || !/^\d+$/.test(message.id)) return false;
    const url = new URL(chrome.runtime.getURL("popup/popup.html"));
    url.searchParams.set("wt_test_marker", message.marker);
    url.searchParams.set("wt_test_id", message.id);
    chrome.tabs.create({ url: url.href }, () => respond({ ok: !chrome.runtime.lastError }));
    return true;
  });
}

async function backgroundState(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "test-probe" });
    const timer = setTimeout(() => { port.disconnect(); reject(new Error("No background state")); }, 5000);
    port.onMessage.addListener((message) => {
      if (message.type !== "state") return;
      clearTimeout(timer);
      port.disconnect();
      resolve(message);
    });
    port.postMessage({ type: "get-state" });
  }));
}

test("Firefox extension qualification", { timeout: 90000 }, async (t) => {
  const browsers = [];
  let fixtureServer = null;
  let relay = null;
  let staging = null;
  t.after(async () => {
    await Promise.allSettled(browsers.map(async (browser) => {
      try { await Promise.race([browser.close(), delay(5000).then(() => { throw new Error("Browser close timed out"); })]); }
      finally { if (browser.process()?.exitCode === null) browser.process().kill("SIGKILL"); }
    }));
    if (relay) {
      relay.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => relay.once("exit", resolve)), delay(1000)]);
      if (relay.exitCode === null) relay.kill("SIGKILL");
    }
    if (fixtureServer) { fixtureServer.closeAllConnections(); await new Promise((resolve) => fixtureServer.close(resolve)); }
    if (staging) await rm(staging, { recursive: true, force: true });
  });

  console.info("Firefox: starting local relay and media fixture");
  relay = fork(path.join(ROOT, "server/server.js"), [], {
    cwd: path.join(ROOT, "server"),
    env: { ...process.env, PORT: "0", MAX_CONNECTIONS_PER_IP: "50", RATE_LIMIT_MAX: "500" },
    silent: true,
  });
  RELAY_URL = `ws://localhost:${await waitForListening(relay)}`;

  const videoBytes = await readFile(path.join(ROOT, "server/fixtures/test-video.webm"));
  fixtureServer = createServer((req, res) => {
    if (!req.url.startsWith("/video.webm")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end('<!doctype html><html><head><title>Firefox video fixture</title></head><body><video id="v" src="/video.webm" width="640" height="360" controls preload="auto"></video></body></html>');
      return;
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), videoBytes.length - 1) : videoBytes.length - 1;
    if (start > end || start >= videoBytes.length) { res.writeHead(416); res.end(); return; }
    const headers = { "Content-Type": "video/webm", "Content-Length": end - start + 1, "Accept-Ranges": "bytes" };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${videoBytes.length}`;
    res.writeHead(range ? 206 : 200, headers);
    res.end(videoBytes.subarray(start, end + 1));
  });
  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  const videoOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;

  await mkdir(path.join(ROOT, "dist"), { recursive: true });
  staging = await mkdtemp(path.join(ROOT, "dist/.firefox-test-"));
  await cp(path.join(ROOT, "extension"), staging, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(staging, "manifest.firefox.json"), "utf8"));
  // These three small drivers exist only in the disposable test package. They open and
  // anchor the real popup; room actions and assertions still exercise production code.
  manifest.background.scripts.push("firefox-test-bridge.js");
  manifest.content_scripts.push({ matches: ["http://127.0.0.1/*"], js: ["firefox-test-launcher.js"], run_at: "document_idle" });
  await writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(staging, "firefox-test-bridge.js"), `(${popupBridge.toString()})(${JSON.stringify(videoOrigin)});`);
  await writeFile(path.join(staging, "firefox-test-launcher.js"), `(${popupLauncher.toString()})();`);
  await writeFile(path.join(staging, "popup/firefox-test-popup.js"), `(${popupTabLookup.toString()})();`);
  const popupPath = path.join(staging, "popup/popup.html");
  const popupHtml = await readFile(popupPath, "utf8");
  assert.ok(popupHtml.includes('<script src="popup.js"></script>'));
  await writeFile(popupPath, popupHtml.replace('<script src="popup.js"></script>', '<script src="firefox-test-popup.js"></script>\n  <script src="popup.js"></script>'));
  // Only relay configuration changes in this disposable copy. An unconfigured profile
  // must never open a production socket before the test has time to save its settings.
  const configPath = path.join(staging, "config.js");
  const config = await readFile(configPath, "utf8");
  const pattern = /const SERVER_URLS = \[[\s\S]*?\];/;
  assert.match(config, pattern);
  await writeFile(configPath, config.replace(pattern, `const SERVER_URLS = [${JSON.stringify(RELAY_URL)}];`));

  console.info("Firefox: launching two profiles and installing the real MV2 package");
  const executablePath = await firefoxExecutable();
  // Install sequentially so a failed second launch still leaves the first in cleanup.
  for (let index = 0; index < 2; index++) {
    const browser = await puppeteer.launch({
      browser: "firefox",
      headless: true,
      timeout: 15000,
      protocolTimeout: 15000,
      executablePath,
      extraPrefsFirefox: {
        "extensions.webextensions.uuids": JSON.stringify({ [ADDON_ID]: UUID }),
        "media.autoplay.default": 0,
        "media.autoplay.blocking_policy": 0,
        "media.block-autoplay-until-in-foreground": false,
      },
    });
    browsers.push(browser);
    assert.equal(await browser.installExtension(staging), ADDON_ID);
  }

  const pages = [];
  for (const [index, browser] of browsers.entries()) {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(`${videoOrigin}/?tab=${index ? "guest" : "host"}`, { waitUntil: "load", timeout: 10000 });
    await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
    await page.waitForSelector("#wt-overlay-btn");
    pages.push(page);
  }
  const [hostPage, guestPage] = pages;
  let roomCode;

  await t.test("MV2 background, content scripts and popup create and join a room", async () => {
    const hostPopup = await openPopup(browsers[0], "host");
    await poll(async () => (await backgroundState(hostPopup)).connected, "Firefox relay connection");
    assert.equal((await backgroundState(hostPopup)).serverUrl, RELAY_URL);
    await hostPopup.type("#userName", "Firefox host");
    await hostPopup.click("#btnCreate");
    await hostPopup.waitForSelector("#view-room.active");
    roomCode = await hostPopup.$eval("#displayRoomCode", (el) => el.textContent.trim());
    assert.match(roomCode, /^[A-Z0-9]{6}$/);
    await hostPopup.close();
    const guestPopup = await openPopup(browsers[1], "guest");
    await poll(async () => (await backgroundState(guestPopup)).connected, "Firefox guest relay connection");
    assert.equal((await backgroundState(guestPopup)).serverUrl, RELAY_URL);
    await guestPopup.type("#userName", "Firefox guest");
    await guestPopup.type("#roomCode", roomCode);
    await guestPopup.click("#btnJoin");
    await guestPopup.waitForSelector("#view-room.active");
    assert.equal(await guestPopup.$eval("#displayRoomCode", (el) => el.textContent.trim()), roomCode);
    await guestPopup.close();
  });

  console.info("Firefox: verifying seek, play and pause across both real players");
  await t.test("two Firefox profiles synchronize seek, play and pause", async () => {
    await hostPage.bringToFront();
    await hostPage.evaluate(async () => { const video = document.querySelector("video"); video.currentTime = 30; await video.play(); });
    await guestPage.waitForFunction(() => { const v = document.querySelector("video"); return !v.paused && v.currentTime >= 29; });
    const times = await Promise.all(pages.map((page) => page.$eval("video", (video) => video.currentTime)));
    assert.ok(Math.abs(times[0] - times[1]) < 2, `Playback drift: ${JSON.stringify(times)}`);
    await hostPage.evaluate(() => document.querySelector("video").pause());
    await guestPage.waitForFunction(() => document.querySelector("video").paused);
    await guestPage.evaluate(() => { document.querySelector("video").currentTime = 65; });
    await hostPage.waitForFunction(() => Math.abs(document.querySelector("video").currentTime - 65) < 1);
  });

  console.info("Firefox: verifying popup roundtrip and keyboard access");
  await t.test("popup reconnects to background state and overlay supports keyboard dismissal", async () => {
    const popup = await openPopup(browsers[0], "host");
    await popup.waitForSelector("#view-room.active");
    assert.equal(await popup.$eval("#displayRoomCode", (el) => el.textContent.trim()), roomCode);
    assert.equal((await backgroundState(popup)).members.length, 2);
    if (process.env.WT_SCREENSHOTS_DIR) {
      await mkdir(process.env.WT_SCREENSHOTS_DIR, { recursive: true });
      await popup.screenshot({ path: path.join(process.env.WT_SCREENSHOTS_DIR, "firefox-popup.png") });
    }
    await popup.close();
    await hostPage.bringToFront();
    await hostPage.click("#wt-overlay-btn");
    await hostPage.waitForSelector('#wt-overlay-panel.wt-visible[role="dialog"]');
    assert.equal(await hostPage.evaluate(() => document.activeElement.id), "wt-close");
    await hostPage.keyboard.press("Escape");
    assert.equal(await hostPage.$eval("#wt-overlay-panel", (el) => el.classList.contains("wt-visible")), false);
    assert.equal(await hostPage.evaluate(() => document.activeElement.id), "wt-overlay-btn");
  });
});
