// Browser integration tests. This is the only layer that runs the extension the way a
// user does: real Chrome, real content script, real background worker, real popup, real
// server. Everything else in this repo tests one side of a wire.
//
// Three things this harness has to get right, all of them learned the hard way:
//   1. Two participants need TWO browsers. One profile has one background worker, so it
//      has one WebSocket, one userId and one room. A second tab in the same browser is
//      not a second person: it joins over the same socket and evicts the first one. The
//      host and the guest here are separate Chrome instances, which is what two people
//      watching together actually are.
//   2. Puppeteer cannot open a real toolbar popup, so the popup is opened as a tab. A page
//      that is itself a tab reports ITSELF as the active tab, which is not what a real
//      popup sees. chrome.tabs.query is stubbed in the popup page (and only there) to
//      point at the video tab it stands in for. Nothing else is mocked.
//   3. A video element with no real media cannot seek or play, so position assertions
//      would pass or fail for reasons unrelated to sync. The fixture is a real 10-minute
//      VP9 file (VP9 because Chromium always has it), served with range support.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import puppeteer from "puppeteer";
import { existsSync } from "node:fs";
import { fork } from "child_process";
import path from "path";
import fs from "fs";
import http from "http";

const SERVER_PORT = 4568;
const EXT_PATH = path.resolve(__dirname, "..", "extension");
const VIDEO_FILE = path.resolve(__dirname, "fixtures", "test-video.webm");

let serverProcess;
let hostBrowser;
let guestBrowser;
let videoServer;
let VIDEO_PORT;

const VIDEO_HTML = `<!DOCTYPE html>
<html><head><title>Test Video</title></head>
<body><video id="v" src="/video.webm" width="640" height="360" controls preload="auto"></video></body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll instead of sleeping a fixed guess: sync is fast when it works, and a fixed sleep
// either wastes seconds or flakes.
async function waitUntil(fn, { timeout = 10000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  return last;
}

// Which Chrome to drive.
//
// It has to be Chrome for Testing, which is what puppeteer downloads. Stable-channel
// Chrome no longer honours --load-extension from the command line, and the way it refuses
// is silent: the browser starts, the page loads, the video plays, and no content script is
// ever injected. Every assertion here then fails on a timeout that looks like a sync bug
// rather than a browser that never loaded the extension. Hours went into that once.
//
// So: no falling back to the Chrome in /Applications. If puppeteer's download is missing or
// broken, install it rather than substituting a browser that cannot run this test:
//   npx --prefix server puppeteer browsers install chrome
// On macOS an unzip that mishandles the app bundle's symlinks leaves the binary present but
// its Frameworks directory absent, and launching dies in dlopen. Re-extracting the official
// zip with `ditto -x -k` fixes it.
function resolveChromePath() {
  // Honoured only when set deliberately, and only if it exists.
  const explicit = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  return undefined; // puppeteer's own Chrome for Testing
}

// Chrome's sandbox cannot start in a CI container, and the failure is a raw crash dump
// rather than a message about sandboxing. --disable-dev-shm-usage covers the other classic
// container problem: /dev/shm is small there, and Chrome runs out of it mid-test.
const CI_ARGS = process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : [];

function launchBrowser() {
  return puppeteer.launch({
    executablePath: resolveChromePath(),
    headless: "new",
    args: [
      ...CI_ARGS,
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-popup-blocking",
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
    ],
  });
}

beforeAll(async () => {
  serverProcess = fork("./server.js", [], {
    env: { ...process.env, PORT: String(SERVER_PORT), MAX_CONNECTIONS_PER_IP: "50", RATE_LIMIT_MAX: "500" },
    silent: true,
  });

  const videoBytes = fs.readFileSync(VIDEO_FILE);
  videoServer = http.createServer((req, res) => {
    if (req.url.startsWith("/video.webm")) {
      // Range support, or the element never becomes seekable.
      const range = req.headers.range;
      if (range) {
        const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
        const start = parseInt(startStr, 10) || 0;
        const end = endStr ? parseInt(endStr, 10) : videoBytes.length - 1;
        res.writeHead(206, {
          "Content-Type": "video/webm",
          "Content-Range": `bytes ${start}-${end}/${videoBytes.length}`,
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
        });
        res.end(videoBytes.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "video/webm",
        "Content-Length": videoBytes.length,
        "Accept-Ranges": "bytes",
      });
      res.end(videoBytes);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(VIDEO_HTML);
  });
  await new Promise((resolve) => videoServer.listen(0, resolve));
  VIDEO_PORT = videoServer.address().port;

  await sleep(1000);
  [hostBrowser, guestBrowser] = await Promise.all([launchBrowser(), launchBrowser()]);
}, 90000);

afterAll(async () => {
  if (hostBrowser) await hostBrowser.close();
  if (guestBrowser) await guestBrowser.close();
  if (serverProcess) serverProcess.kill("SIGTERM");
  if (videoServer) videoServer.close();
});

async function extensionId(browser) {
  const target = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
    { timeout: 15000 }
  );
  return new URL(target.url()).hostname;
}

// Each video tab carries a marker in its URL so the popup that stands in for it can find
// exactly that tab, even with several open.
async function openVideoPage(browser, marker) {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${VIDEO_PORT}/?tab=${marker}`, { waitUntil: "load" });
  await page.waitForSelector("video");
  // Wait for real media, not just the element: currentTime does not move without it.
  await page.waitForFunction(
    () => {
      const v = document.querySelector("video");
      return v && v.readyState >= 1 && v.duration > 0;
    },
    { timeout: 15000 }
  );
  // The overlay is injected by the content script, so its presence proves the content
  // script is alive and attached in this tab.
  await page.waitForSelector("[id^='wt-'], [class^='wt-']", { timeout: 10000 });
  return page;
}

async function openPopupFor(browser, marker) {
  const extId = await extensionId(browser);
  const popup = await browser.newPage();
  await popup.evaluateOnNewDocument((mark) => {
    const realQuery = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (info, cb) => {
      if (info && info.active && info.currentWindow) {
        // A real popup is anchored over the user's tab. This one IS a tab, so left alone
        // it would report itself. Hand it the video tab it is standing in for.
        return realQuery({}, (tabs) => {
          const t = tabs.find((x) => (x.url || "").includes(`tab=${mark}`));
          cb(t ? [t] : []);
        });
      }
      return realQuery(info, cb);
    };
  }, marker);
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: "domcontentloaded" });
  await popup.waitForSelector("#btnCreate");
  return popup;
}

// The extension holds exactly one room at a time, and it holds it in the background, not
// in the page. Without this, the next test opens its popup straight into the previous
// test's room and every assertion after that measures the wrong session.
async function leaveRoom(browser) {
  const extId = await extensionId(browser);
  const p = await browser.newPage();
  await p.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: "domcontentloaded" });
  await p.evaluate(
    () =>
      new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: "popup" });
        port.postMessage({ type: "leave-room" });
        setTimeout(resolve, 400);
      })
  );
  await p.close();
}

async function closeAllPages(browser) {
  for (const p of await browser.pages()) {
    if (p.url() !== "about:blank") await p.close().catch(() => {});
  }
}

// Point the extension at the server this test started, and PROVE it took.
//
// This used to be fire-and-forget, and when a later change tightened the popup's URL
// validation to wss-only it silently rejected ws://localhost. The extension quietly stayed
// on the production relay, so this whole suite spent its runs creating real rooms on the
// live server. It passed, too, right up until it started tripping production rate limits,
// at which point the failure looked like a sync bug. A test that does not verify what it is
// testing against is not testing what you think.
async function setServerUrl(popup) {
  const target = `ws://localhost:${SERVER_PORT}`;
  await popup.evaluate((url) => {
    document.getElementById("serverUrl").value = url;
    document.getElementById("btnSaveServer").click();
  }, target);
  await sleep(800);

  const stored = await popup.evaluate(
    () => new Promise((r) => chrome.storage.local.get(["serverUrl"], (d) => r(d.serverUrl || "")))
  );
  if (stored !== target) {
    throw new Error(
      `The extension did not accept the test server URL (stored ${JSON.stringify(stored)}, wanted ${target}). ` +
        `Refusing to run: these tests would otherwise be driving the production relay.`
    );
  }
}

// The popup only enables Create once it believes it is over a real video tab.
async function createRoom(popup, name) {
  // Landing view, not the room view: if the popup opened straight into an existing room,
  // the code read below would be the old room's and the test would silently pass on it.
  await popup.waitForSelector("#view-landing.active", { timeout: 10000 });
  await popup.waitForFunction(() => !document.getElementById("btnCreate").disabled, { timeout: 10000 });
  await popup.evaluate((n) => {
    document.getElementById("userName").value = n;
    document.getElementById("btnCreate").click();
  }, name);
  return waitUntil(async () => popup.$eval("#displayRoomCode", (el) => el.textContent.trim()).catch(() => ""), {
    timeout: 12000,
  });
}

async function joinRoom(popup, name, code) {
  await popup.waitForSelector("#view-landing.active", { timeout: 10000 });
  await popup.evaluate(
    (n, c) => {
      document.getElementById("userName").value = n;
      document.getElementById("roomCode").value = c;
      document.getElementById("btnJoin").click();
    },
    name,
    code
  );
  return waitUntil(async () => popup.$eval("#displayRoomCode", (el) => el.textContent.trim()).catch(() => ""), {
    timeout: 12000,
  });
}

const videoTime = (page) => page.evaluate(() => document.querySelector("video").currentTime);
const videoPaused = (page) => page.evaluate(() => document.querySelector("video").paused);

// Chrome suspends video-only playback in a background tab, so whoever is about to act has
// to be the tab in front. That is also what actually happens: people drive the video they
// are looking at.
async function driveVideo(page, fn) {
  await page.bringToFront();
  await page.evaluate(fn);
}

describe("Browser integration", () => {
  afterEach(async () => {
    await Promise.all([leaveRoom(hostBrowser), leaveRoom(guestBrowser)]);
    await Promise.all([closeAllPages(hostBrowser), closeAllPages(guestBrowser)]);
  });

  it("extension loads and the popup opens", async () => {
    await openVideoPage(hostBrowser, "solo");
    const popup = await openPopupFor(hostBrowser, "solo");

    expect(await popup.$eval(".logo-text", (el) => el.textContent)).toBe("Watch Together");
    expect(await popup.$("#userName")).not.toBeNull();
    expect(await popup.$("#btnCreate")).not.toBeNull();
    expect(await popup.$("#btnJoin")).not.toBeNull();
  }, 40000);

  it("the content script attaches to the page and injects its overlay", async () => {
    const page = await openVideoPage(hostBrowser, "inject");
    const injected = await page.evaluate(() => Boolean(document.querySelector("[id^='wt-'], [class^='wt-']")));
    expect(injected).toBe(true);
  }, 40000);

  it("creates a room from a video page", async () => {
    await openVideoPage(hostBrowser, "create");
    const popup = await openPopupFor(hostBrowser, "create");
    await setServerUrl(popup);

    const code = await createRoom(popup, "TestHost");
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    expect(await popup.$eval("#statusText", (el) => el.textContent)).toBe("Live");
  }, 60000);

  it("two people sync play, pause and seek", async () => {
    const hostPage = await openVideoPage(hostBrowser, "host");
    const hostPopup = await openPopupFor(hostBrowser, "host");
    await setServerUrl(hostPopup);
    const code = await createRoom(hostPopup, "Host");
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    await hostPopup.close();

    const guestPage = await openVideoPage(guestBrowser, "guest");
    const guestPopup = await openPopupFor(guestBrowser, "guest");
    await setServerUrl(guestPopup);
    expect(await joinRoom(guestPopup, "Guest", code)).toBe(code);
    await guestPopup.close();

    // The host seeks and plays. The guest should land on the same position.
    await driveVideo(hostPage, () => {
      const v = document.querySelector("video");
      v.currentTime = 30;
      return v.play().catch(() => {});
    });
    const converged = await waitUntil(async () => Math.abs((await videoTime(guestPage)) - 30) < 5);
    expect(converged, `guest sat at ${await videoTime(guestPage)}s while the host was at 30s`).toBe(true);

    // The host pauses. The guest should stop too.
    await driveVideo(hostPage, () => document.querySelector("video").pause());
    const paused = await waitUntil(async () => (await videoPaused(guestPage)) === true);
    expect(paused, "guest kept playing after the host paused").toBe(true);

    // Everyone mode: the guest can drive as well.
    await driveVideo(guestPage, () => {
      document.querySelector("video").currentTime = 120;
    });
    const hostFollowed = await waitUntil(async () => Math.abs((await videoTime(hostPage)) - 120) < 5);
    expect(hostFollowed, `host sat at ${await videoTime(hostPage)}s while the guest was at 120s`).toBe(true);
  }, 120000);

  // The member list is the change that makes this feel trustworthy. A count answers "is
  // anyone else there". It does not answer the question people actually ask when something
  // looks wrong, which is "is it me, or is it them".
  it("the overlay shows who is in the room, by name", async () => {
    const hostPage = await openVideoPage(hostBrowser, "wholist-host");
    const hostPopup = await openPopupFor(hostBrowser, "wholist-host");
    await setServerUrl(hostPopup);
    const code = await createRoom(hostPopup, "Alice");
    await hostPopup.close();

    const guestPopup = await openPopupFor(guestBrowser, "wholist-guest");
    await setServerUrl(guestPopup);
    expect(await joinRoom(guestPopup, "Bob", code)).toBe(code);
    await guestPopup.close();

    // Open the panel and reveal the list, the way a viewer would.
    await hostPage.waitForSelector("#wt-overlay-btn", { timeout: 15000 });
    await hostPage.evaluate(() => document.getElementById("wt-overlay-btn").click());
    await hostPage.waitForSelector("#wt-members-toggle", { timeout: 10000 });
    await hostPage.evaluate(() => {
      const list = document.getElementById("wt-members");
      if (list.hasAttribute("hidden")) document.getElementById("wt-members-toggle").click();
    });

    const listed = await waitUntil(async () => {
      const names = await hostPage.evaluate(() =>
        [...document.querySelectorAll("#wt-members .wt-member-name")].map((e) => e.textContent)
      );
      return names.length >= 2 && names.some((n) => n.includes("Bob"));
    });
    const names = await hostPage.evaluate(() =>
      [...document.querySelectorAll("#wt-members .wt-member-name")].map((e) => e.textContent)
    );
    expect(listed, `member list showed ${JSON.stringify(names)}`).toBe(true);
    // You are always first, and always marked, so the row you care about is findable.
    expect(names[0]).toMatch(/\(you\)/);
  }, 120000);

  // Everything past the three things most people need lives behind one disclosure, and it
  // has to actually contain the things a power user came looking for.
  it("advanced controls are collapsed for a first-time viewer but complete", async () => {
    // Both disclosures deliberately REMEMBER being opened, which is the whole point: a
    // power user opens them once and never thinks about it again. So to see what a
    // FIRST-TIME viewer sees, this uses the guest profile, which never opens them: the
    // member-list test above drives the host profile, and that preference is now stored
    // there. Clearing the preference directly is not an option, because chrome.storage
    // does not exist in the main world that page.evaluate runs in, and opening an
    // extension page to reach it makes that page nominate itself as the party tab.
    const page = await openVideoPage(guestBrowser, "advanced");
    await page.waitForSelector("#wt-overlay-btn", { timeout: 15000 });
    await page.evaluate(() => document.getElementById("wt-overlay-btn").click());
    await page.waitForSelector("#wt-advanced", { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 400)); // the stored preference is read async

    const state = await page.evaluate(() => {
      const adv = document.getElementById("wt-advanced");
      const inside = (sel) => !!adv.querySelector(sel);
      return {
        closed: !adv.open,
        membersHidden: document.getElementById("wt-members").hasAttribute("hidden"),
        has: {
          syncHealth: inside("#wt-sync-health"),
          resync: inside("#wt-resync"),
          controlMode: inside("#wt-mode-seg"),
          offset: inside("#wt-offset"),
          hotkey: inside("#wt-hotkey"),
          server: inside("#wt-server"),
        },
      };
    });
    expect(state.closed, "the drawer must start closed").toBe(true);
    expect(state.membersHidden, "and the member list must start collapsed").toBe(true);
    for (const [name, present] of Object.entries(state.has)) {
      expect(present, `${name} should live in the advanced drawer`).toBe(true);
    }
  }, 60000);

  it("a session survives the party tab reloading", async () => {
    // The host drives, so the room has a real position to come back to.
    const hostPage = await openVideoPage(hostBrowser, "rhost");
    const hostPopup = await openPopupFor(hostBrowser, "rhost");
    await setServerUrl(hostPopup);
    const code = await createRoom(hostPopup, "Host");
    await hostPopup.close();

    const guestPage = await openVideoPage(guestBrowser, "rguest");
    const guestPopup = await openPopupFor(guestBrowser, "rguest");
    await setServerUrl(guestPopup);
    expect(await joinRoom(guestPopup, "Guest", code)).toBe(code);
    await guestPopup.close();

    await driveVideo(hostPage, () => {
      const v = document.querySelector("video");
      v.currentTime = 90;
      return v.play().catch(() => {});
    });
    expect(await waitUntil(async () => Math.abs((await videoTime(guestPage)) - 90) < 6)).toBe(true);

    // A reload tears the content script down completely. The background has to hand the
    // room back and pull the position, or the session is over as far as the user is
    // concerned. This is the whole point of the v1.1.0 persistence work.
    await guestPage.reload({ waitUntil: "load" });
    await guestPage.waitForFunction(
      () => {
        const v = document.querySelector("video");
        return v && v.duration > 0;
      },
      { timeout: 15000 }
    );

    const popupAfter = await openPopupFor(guestBrowser, "rguest");
    const stillIn = await waitUntil(
      async () => popupAfter.$eval("#displayRoomCode", (el) => el.textContent.trim()).catch(() => ""),
      { timeout: 12000 }
    );
    expect(stillIn, "the reloaded tab lost the room").toBe(code);

    // And it should be back at the room's position, not at zero.
    const resumed = await waitUntil(async () => (await videoTime(guestPage)) > 60, { timeout: 15000 });
    expect(resumed, `the tab came back at ${await videoTime(guestPage)}s instead of near 90s`).toBe(true);
  }, 120000);
});

// The panel used to be appended to document.body and left there. A fullscreen video is
// painted in the browser's top layer and only elements INSIDE the fullscreen element are
// painted with it, so from the moment anyone went fullscreen (which is how people actually
// watch) the entire panel was invisible: chat, member count, sync health, the Leave button.
// The button kept working, because it is injected into the player's own controls, which
// made it look like clicking it did nothing.
describe("Overlay panel", () => {
  it("opens, and follows the video into fullscreen", async () => {
    const page = await openVideoPage(hostBrowser, "fs");

    await page.waitForSelector("#wt-overlay-btn", { timeout: 15000 });
    await page.evaluate(() => document.getElementById("wt-overlay-btn").click());
    await page.waitForSelector("#wt-overlay-panel", { timeout: 10000 });

    const before = await page.evaluate(() => ({
      exists: !!document.getElementById("wt-overlay-panel"),
      parent: document.getElementById("wt-overlay-panel").parentElement.tagName,
    }));
    expect(before.exists).toBe(true);
    expect(before.parent).toBe("BODY");

    const after = await page.evaluate(async () => {
      const host = document.querySelector("#player") || document.body.firstElementChild || document.body;
      await host.requestFullscreen();
      // Headless Chrome sets document.fullscreenElement for a programmatic request but does
      // not always emit the event a real user interaction would, so fire it explicitly. The
      // point of the assertion is that the extension REACTS to it correctly; whether Chrome
      // emits it in headless is Chrome's business, not this extension's.
      document.dispatchEvent(new Event("fullscreenchange", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const panel = document.getElementById("wt-overlay-panel");
      return {
        wentFullscreen: !!document.fullscreenElement,
        insideFullscreenElement: !!(document.fullscreenElement && document.fullscreenElement.contains(panel)),
      };
    });
    expect(after.wentFullscreen).toBe(true);
    expect(after.insideFullscreenElement).toBe(true);

    // And back out again, so leaving fullscreen does not strand it inside a hidden element.
    const restored = await page.evaluate(async () => {
      await document.exitFullscreen();
      document.dispatchEvent(new Event("fullscreenchange", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      return document.getElementById("wt-overlay-panel").parentElement.tagName;
    });
    expect(restored).toBe("BODY");
  });
});
