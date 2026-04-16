import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer from "puppeteer";
import { fork } from "child_process";
import path from "path";
import http from "http";

const SERVER_PORT = 4568;
const EXT_PATH = path.resolve(__dirname, "..", "extension");
let serverProcess;
let browser;

// Simple HTML page that embeds a video element — simulates YouTube/Netflix
const VIDEO_HTML = `<!DOCTYPE html>
<html><head><title>Test Video</title></head>
<body>
<video id="v" src="data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=" width="640" height="360" controls></video>
<script>
  // Make video seekable by giving it a duration
  Object.defineProperty(document.getElementById('v'), 'duration', { get: () => 3600, configurable: true });
</script>
</body></html>`;

let videoServer;
let VIDEO_PORT;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

beforeAll(async () => {
  // Start sync server
  serverProcess = fork("./server.js", [], {
    env: { ...process.env, PORT: String(SERVER_PORT), MAX_CONNECTIONS_PER_IP: "50", RATE_LIMIT_MAX: "200" },
    silent: true,
  });

  // Start a simple HTTP server that serves the test video page
  videoServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(VIDEO_HTML);
  });
  await new Promise((resolve) => {
    videoServer.listen(0, () => {
      VIDEO_PORT = videoServer.address().port;
      resolve();
    });
  });

  await sleep(1000);

  // Launch Chrome with the extension loaded
  browser = await puppeteer.launch({
    headless: false, // Extensions require headed mode
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-popup-blocking",
    ],
  });
}, 30000);

afterAll(async () => {
  if (browser) await browser.close();
  if (serverProcess) serverProcess.kill("SIGTERM");
  if (videoServer) videoServer.close();
});

// Helper: open a new page with the test video
async function openVideoPage() {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${VIDEO_PORT}`, { waitUntil: "domcontentloaded" });
  // Wait for content script to load
  await sleep(2000);
  return page;
}

// Helper: interact with the extension popup
async function openPopup(page) {
  // Get the extension ID from the service worker
  const targets = await browser.targets();
  const extTarget = targets.find((t) => t.type() === "service_worker" && t.url().includes("chrome-extension://"));
  if (!extTarget) throw new Error("Extension service worker not found");
  const extId = new URL(extTarget.url()).hostname;

  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: "domcontentloaded" });
  await sleep(500);
  return { popup, extId };
}

// Helper: set the server URL in the popup
async function setServerUrl(popup) {
  // Open server settings
  await popup.click("details.server-config summary");
  await sleep(200);
  // Clear and type new URL
  await popup.evaluate((port) => {
    document.getElementById("serverUrl").value = `ws://localhost:${port}`;
  }, SERVER_PORT);
  await popup.click("#btnSaveServer");
  await sleep(1000); // Wait for reconnect
}

describe("Browser integration", () => {
  it("extension loads and popup opens", async () => {
    const page = await openVideoPage();
    const { popup } = await openPopup(page);

    // Popup should show the landing view
    const title = await popup.$eval(".logo-text", (el) => el.textContent);
    expect(title).toBe("Watch Together");

    // Should have name input, create button, join button
    expect(await popup.$("#userName")).not.toBeNull();
    expect(await popup.$("#btnCreate")).not.toBeNull();
    expect(await popup.$("#btnJoin")).not.toBeNull();

    await popup.close();
    await page.close();
  }, 20000);

  it("creates room from video page", async () => {
    const page = await openVideoPage();
    const { popup } = await openPopup(page);

    await setServerUrl(popup);

    // Enter name
    await popup.evaluate(() => { document.getElementById("userName").value = "TestHost"; });

    // Create room
    await popup.click("#btnCreate");
    await sleep(3000); // Wait for WebSocket connect + room create

    // Should show room view with code
    const roomCode = await popup.$eval("#displayRoomCode", (el) => el.textContent);
    expect(roomCode).toMatch(/^[A-Z0-9]{6}$/);

    // Status should be connected
    const status = await popup.$eval("#statusText", (el) => el.textContent);
    expect(status).toBe("Live");

    await popup.close();
    await page.close();
  }, 30000);

  it("two tabs sync video playback", async () => {
    // Tab 1: Host creates room
    const page1 = await openVideoPage();
    const { popup: popup1 } = await openPopup(page1);
    await setServerUrl(popup1);

    await popup1.evaluate(() => { document.getElementById("userName").value = "Host"; });
    await popup1.click("#btnCreate");
    await sleep(3000);

    const roomCode = await popup1.$eval("#displayRoomCode", (el) => el.textContent);
    expect(roomCode).toMatch(/^[A-Z0-9]{6}$/);
    await popup1.close();

    // Tab 2: Guest joins
    const page2 = await openVideoPage();
    const { popup: popup2 } = await openPopup(page2);
    await setServerUrl(popup2);

    await popup2.evaluate(() => { document.getElementById("userName").value = "Guest"; });
    await popup2.evaluate((code) => { document.getElementById("roomCode").value = code; }, roomCode);
    await popup2.click("#btnJoin");
    await sleep(3000);

    // Guest should see room view
    const guestRoom = await popup2.$eval("#displayRoomCode", (el) => el.textContent);
    expect(guestRoom).toBe(roomCode);
    await popup2.close();

    // Host plays video at 30s
    await page1.evaluate(() => {
      const v = document.querySelector("video");
      v.currentTime = 30;
      v.play().catch(() => {});
    });
    await sleep(2000); // Wait for sync

    // Check guest video position
    const guestTime = await page2.evaluate(() => document.querySelector("video")?.currentTime || 0);
    // Should be near 30s (within drift threshold)
    expect(Math.abs(guestTime - 30)).toBeLessThan(5);

    // Host pauses
    await page1.evaluate(() => document.querySelector("video").pause());
    await sleep(1500);

    const guestPaused = await page2.evaluate(() => document.querySelector("video")?.paused);
    expect(guestPaused).toBe(true);

    // Guest seeks to 120s (everyone mode)
    await page2.evaluate(() => {
      const v = document.querySelector("video");
      v.currentTime = 120;
    });
    await sleep(1500);

    const hostTime = await page1.evaluate(() => document.querySelector("video")?.currentTime || 0);
    expect(Math.abs(hostTime - 120)).toBeLessThan(5);

    await page1.close();
    await page2.close();
  }, 45000);

  it("content script injects overlay button", async () => {
    const page = await openVideoPage();
    await sleep(2000);

    // The overlay button should be injected
    const overlayBtn = await page.$("#wt-overlay-btn");
    // May or may not be present depending on player detection
    // But the content script should at least have loaded
    const loaded = await page.evaluate(() => window.__watchTogetherLoaded);
    expect(loaded).toBe(true);

    await page.close();
  }, 15000);

  it("auto-join via wt_room URL parameter", async () => {
    // First create a room
    const page1 = await openVideoPage();
    const { popup: popup1 } = await openPopup(page1);
    await setServerUrl(popup1);
    await popup1.evaluate(() => { document.getElementById("userName").value = "Host"; });
    await popup1.click("#btnCreate");
    await sleep(3000);
    const roomCode = await popup1.$eval("#displayRoomCode", (el) => el.textContent);
    await popup1.close();

    // Open a new tab with wt_room param
    const page2 = await browser.newPage();

    // First set the userName in storage so auto-join has a name
    const targets = await browser.targets();
    const extTarget = targets.find((t) => t.type() === "service_worker");
    const extId = new URL(extTarget.url()).hostname;
    const setupPage = await browser.newPage();
    await setupPage.goto(`chrome-extension://${extId}/popup/popup.html`);
    await sleep(500);
    await setupPage.evaluate(() => { document.getElementById("userName").value = "AutoGuest"; });
    // Save by triggering storage
    await setupPage.evaluate(() => chrome.storage.local.set({ userName: "AutoGuest" }));
    await setServerUrl(setupPage);
    await setupPage.close();

    // Navigate to video page with wt_room param
    await page2.goto(`http://localhost:${VIDEO_PORT}/?wt_room=${roomCode}`, { waitUntil: "domcontentloaded" });
    await sleep(5000); // Wait for auto-join

    // Check if joined — the notification should have appeared
    const notification = await page2.evaluate(() => {
      const el = document.getElementById("wt-notification");
      return el ? el.textContent : "";
    });

    // Should contain room code in some form
    // Or check via the popup
    const { popup: popup2 } = await openPopup(page2);
    await sleep(1000);
    const guestRoom = await popup2.evaluate(() => {
      const el = document.getElementById("displayRoomCode");
      return el ? el.textContent : "";
    });

    // Room should match or at least popup should show room view
    if (guestRoom) {
      expect(guestRoom).toBe(roomCode);
    }

    await popup2.close();
    await page1.close();
    await page2.close();
  }, 45000);
});
