// Explicit live-provider qualification, never part of the deterministic unit gate.
// Only fresh profiles and public content are used. Reports contain allowlisted facts.
import puppeteer from "puppeteer";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { waitForListening } from "./test-server.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROVIDER_URL = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
let relayUrl;
const started = Date.now();
const deadline = started + 115000;
const browsers = [];
const launchControllers = new Set();
let relay;
let stage = "setup";
let realPlayback = false;
let people = [];
const report = {
  schemaVersion: 1,
  provider: "YouTube",
  scope: "public-video-two-profile-baseline",
  outcome: "blocked",
  baselinePassed: false,
  blocker: null,
  versions: {
    extension: JSON.parse(readFileSync(resolve(ROOT, "extension/manifest.json"), "utf8")).version,
    puppeteer: JSON.parse(readFileSync(new URL("./node_modules/puppeteer/package.json", import.meta.url), "utf8")).version,
    node: process.versions.node,
    browser: null,
    platform: process.platform,
    architecture: process.arch,
  },
  participants: [],
  cases: Object.fromEntries([
    "content-playback", "extension-attached", "two-profile-membership", "play-pause-sync",
    "seek-sync", "relay-reconnect", "provider-ads", "episode-change", "provider-buffering",
    "operating-system-sleep", "cross-device",
  ].map((name) => [name, { status: "not-run" }])),
};

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
function emit() {
  report.elapsedMs = Date.now() - started;
  const json = JSON.stringify(report, null, 2) + "\n";
  if (process.env.WT_PROVIDER_REPORT) {
    const output = resolve(process.env.WT_PROVIDER_REPORT);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, json);
  }
  process.stdout.write(json);
}
function stopProcesses() {
  for (const controller of launchControllers) controller.abort();
  for (const browser of browsers) {
    const child = browser.process();
    if (child && child.exitCode === null) child.kill("SIGKILL");
  }
  if (relay && relay.exitCode === null) relay.kill("SIGKILL");
}
const watchdog = setTimeout(() => {
  report.blocker = { stage, reason: "total-budget-exhausted" };
  if (report.cases[stage]) report.cases[stage] = { status: "blocked", reason: "total-budget-exhausted" };
  stopProcesses();
  emit();
  process.exit(process.env.WT_PROVIDER_REQUIRE_PASS === "1" ? 1 : 0);
}, 115000);

async function bounded(operation, ms = 15000) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation-timeout")), Math.max(1, Math.min(ms, deadline - Date.now())));
      }),
    ]);
  } finally { clearTimeout(timer); }
}
async function until(predicate, ms = 10000) {
  const end = Math.min(deadline, Date.now() + ms);
  while (Date.now() < end) {
    if (await bounded(predicate, 4000)) return true;
    await delay(200);
  }
  return false;
}
function reasonFor(error) {
  const message = String(error?.message || "");
  if (/operation-timeout|timeout|timed out/i.test(message)) return "operation-timeout";
  if (/could not find chrome|browser was not found|executable.*does not exist/i.test(message)) return "browser-not-installed";
  if (/failed to launch|spawn|sandbox|SIGABRT|SIGTRAP|mach_port|crashpad/i.test(message)) return "browser-launch-rejected";
  if (/ERR_CERT/i.test(message)) return "network-certificate-rejected";
  if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_INTERNET|ERR_PROXY|fetch failed/i.test(message)) return "network-unavailable";
  if (/local-relay-not-selected/.test(message)) return "local-relay-not-selected";
  return "operation-failed";
}

async function launch() {
  const controller = new AbortController();
  launchControllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), 14500);
  try {
  const browser = await bounded(() => puppeteer.launch({
    signal: controller.signal,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: "new", timeout: 15000, protocolTimeout: 15000,
    args: [
      ...(process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
      `--disable-extensions-except=${resolve(ROOT, "extension")}`,
      `--load-extension=${resolve(ROOT, "extension")}`,
      "--no-first-run", "--no-default-browser-check", "--disable-default-apps",
      "--autoplay-policy=no-user-gesture-required", "--mute-audio", "--lang=en-US",
    ],
  }));
  browsers.push(browser);
  return browser;
  } finally { clearTimeout(timeout); }
}

async function observation(page) {
  return bounded(() => page.evaluate(() => {
    const video = document.querySelector("video");
    const player = document.querySelector("#movie_player");
    const errorText = document.querySelector(".ytp-error-content-wrap")?.textContent || "";
    const body = document.body?.innerText || "";
    const rawStatus = player?.getPlayerResponse?.()?.playabilityStatus?.status;
    const status = ["OK", "ERROR", "UNPLAYABLE", "LOGIN_REQUIRED", "LIVE_STREAM_OFFLINE"].includes(rawStatus) ? rawStatus : null;
    const finite = (value) => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
    return {
      videoCount: document.querySelectorAll("video").length,
      extensionAttached: !!document.querySelector("#wt-overlay-btn"),
      readyState: video?.readyState ?? null,
      networkState: video?.networkState ?? null,
      mediaErrorCode: video?.error?.code ?? null,
      currentTime: finite(video?.currentTime),
      durationSeconds: finite(video?.duration),
      paused: video?.paused ?? null,
      decodedFrames: video?.getVideoPlaybackQuality?.()?.totalVideoFrames ?? null,
      playerStatus: status,
      adPresent: !!document.querySelector("#movie_player.ad-showing, #movie_player.ad-interrupting"),
      error153: /\b153\b/.test(errorText),
      botChallenge: /sign in to confirm (you.re|you are) not a bot|unusual traffic/i.test(body),
      loginRequired: /sign in to (confirm your age|view this video)|age.restricted/i.test(body),
      consentRequired: location.hostname === "consent.youtube.com",
      playerErrorVisible: errorText.trim().length > 0,
    };
  }));
}
function playbackBlocker(evidence) {
  if (evidence.botChallenge) return "provider-bot-challenge";
  if (evidence.consentRequired) return "provider-consent-required";
  if (evidence.loginRequired || evidence.playerStatus === "LOGIN_REQUIRED") return "provider-login-required";
  if (evidence.error153) return "provider-player-error-153";
  if (evidence.mediaErrorCode === 4) return "media-source-not-supported";
  if (evidence.mediaErrorCode === 3) return "media-decoding-failed";
  if (evidence.adPresent) return "advertisement-prevents-content-qualification";
  if (evidence.playerErrorVisible || ["ERROR", "UNPLAYABLE"].includes(evidence.playerStatus)) return "provider-player-unavailable";
  if (!evidence.videoCount) return "provider-video-element-unavailable";
  return "content-time-did-not-progress";
}
async function openProvider(browser, role) {
  const participant = { role, navigationStatus: null, playbackProgressed: false };
  report.participants.push(participant);
  const page = await bounded(() => browser.newPage());
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(15000);
  const response = await bounded(() => page.goto(PROVIDER_URL, { waitUntil: "domcontentloaded", timeout: 15000 }));
  participant.navigationStatus = response?.status() ?? null;
  await bounded(() => page.evaluate(() => {
    const reject = [...document.querySelectorAll("button")].find((button) => /^reject all$/i.test(button.textContent.trim()));
    reject?.click();
  }));
  await until(async () => (await observation(page)).videoCount > 0, 5000);
  participant.before = await observation(page);
  participant.playRequest = await bounded(() => page.evaluate(async () => {
    const video = document.querySelector("video");
    if (!video) return "no-video";
    video.muted = true;
    try { await video.play(); return "fulfilled"; } catch { return "rejected"; }
  }), 5000).catch(() => "timed-out");
  participant.playbackProgressed = await until(async () => {
    participant.after = await observation(page);
    const a = participant.before;
    const b = participant.after;
    return !a.adPresent && !b.adPresent && b.readyState >= 2 && b.currentTime - a.currentTime > 0.75 && b.decodedFrames > a.decodedFrames;
  }, 8000);
  participant.after = await observation(page);
  if (!participant.playbackProgressed) participant.blocker = playbackBlocker(participant.after);
  return { browser, page, participant };
}

async function controller(person) {
  const target = await bounded(() => person.browser.waitForTarget((candidate) => candidate.type() === "service_worker" && candidate.url().startsWith("chrome-extension://"), { timeout: 10000 }));
  const popup = await bounded(() => person.browser.newPage());
  await bounded(() => popup.goto(`chrome-extension://${new URL(target.url()).hostname}/popup/popup.html`, { waitUntil: "domcontentloaded", timeout: 10000 }));
  await bounded(() => popup.evaluate((url) => {
    globalThis.qualificationPort = chrome.runtime.connect({ name: "popup" });
    globalThis.qualificationPort.postMessage({ type: "set-server-url", url });
  }, relayUrl));
  person.popup = popup;
  const selected = await until(async () => {
    const state = await request(person, { type: "get-state" }, "state");
    return state.serverUrl === relayUrl && state.connected;
  }, 8000);
  if (!selected) throw new Error("local-relay-not-selected");
  person.tabId = await bounded(() => popup.evaluate((url) => new Promise((done) => {
    chrome.tabs.query({}, (tabs) => done(tabs.find((tab) => tab.url === url)?.id));
  }), PROVIDER_URL));
  if (!Number.isInteger(person.tabId)) throw new Error("provider-tab-missing");
}
async function request(person, message, type) {
  return bounded(() => person.popup.evaluate((outbound, wanted) => new Promise((done) => {
    const port = globalThis.qualificationPort;
    const timer = setTimeout(() => { port.onMessage.removeListener(receive); done({ timeout: true }); }, 5000);
    function receive(inbound) {
      if (inbound.type !== wanted && inbound.type !== "error") return;
      clearTimeout(timer);
      port.onMessage.removeListener(receive);
      done(inbound);
    }
    port.onMessage.addListener(receive);
    port.postMessage(outbound);
  }), message, type), 6000);
}
async function requireCase(name, condition, evidence = {}) {
  report.cases[name] = { status: condition ? "passed" : "failed", ...evidence };
  if (!condition) throw new Error("qualification-assertion-failed");
}

try {
  stage = "browser-launch";
  const launches = await Promise.allSettled([launch(), launch()]);
  const rejected = launches.find((result) => result.status === "rejected");
  if (rejected) throw rejected.reason;
  report.versions.browser = (await bounded(() => browsers[0].version())).match(/\d+(?:\.\d+){1,3}/)?.[0] || null;
  stage = "provider-playback";
  const visits = await Promise.allSettled(browsers.map((browser, index) => openProvider(browser, index === 0 ? "host" : "guest")));
  const brokenVisit = visits.find((result) => result.status === "rejected");
  if (brokenVisit) throw brokenVisit.reason;
  people = visits.map((result) => result.value);
  if (!people.every((person) => person.participant.playbackProgressed)) {
    report.cases["content-playback"] = { status: "blocked" };
    report.blocker = { stage, reason: people.find((person) => !person.participant.playbackProgressed).participant.blocker };
  } else {
    realPlayback = true;
    await requireCase("content-playback", true);
    await requireCase("extension-attached", people.every((person) => person.participant.after.extensionAttached));
    stage = "local-relay";
    relay = fork(resolve(ROOT, "server/server.js"), [], {
      cwd: resolve(ROOT, "server"), silent: true,
      env: { ...process.env, PORT: "0", NODE_ENV: "test", SERVER_MOVED_URL: "", HOST_TOKEN_SECRET: randomBytes(32).toString("hex"), MAX_CONNECTIONS_PER_IP: "50" },
    });
    const port = await bounded(() => waitForListening(relay), 5000);
    relayUrl = `ws://localhost:${port}`;
    await Promise.all(people.map(controller));
    const [host, guest] = people;
    stage = "two-profile-membership";
    const created = await request(host, { type: "create-room", tabId: host.tabId, videoUrl: PROVIDER_URL, userName: "Host" }, "room-created");
    const joined = await request(guest, { type: "join-room", tabId: guest.tabId, roomCode: created.roomCode, userName: "Guest" }, "room-joined");
    await requireCase(stage, !!created.roomCode && joined.roomCode === created.roomCode && joined.members?.length === 2);
    await Promise.all(people.map((person) => bounded(() => person.page.bringToFront())));
    stage = "play-pause-sync";
    // Establish the opposite state before each assertion. Otherwise an already paused
    // guest could make a completely broken pause relay appear to pass.
    await bounded(() => host.page.evaluate(() => document.querySelector("video").pause()));
    await delay(350);
    await bounded(() => host.page.evaluate(() => document.querySelector("video").play()), 5000);
    const initiallyPlaying = await until(async () => {
      const states = await Promise.all(people.map((person) => observation(person.page)));
      return states.every((state) => state.paused === false && !state.adPresent);
    }, 8000);
    if (!initiallyPlaying) await requireCase(stage, false, { initialPlayPropagated: false });
    await bounded(() => host.page.evaluate(() => document.querySelector("video").pause()));
    const paused = await until(async () => (await observation(guest.page)).paused === true, 5000);
    await bounded(() => host.page.evaluate(() => document.querySelector("video").play()), 5000);
    const playing = await until(async () => (await observation(guest.page)).paused === false, 5000);
    await requireCase(stage, paused && playing, { pausePropagated: paused, playPropagated: playing });
    stage = "seek-sync";
    await bounded(() => host.page.evaluate(() => document.querySelector("video").pause()));
    await until(async () => (await observation(guest.page)).paused === true, 5000);
    const beforeSeek = await observation(host.page);
    const destination = beforeSeek.currentTime + 30 < beforeSeek.durationSeconds - 5 ? beforeSeek.currentTime + 30 : Math.max(1, beforeSeek.currentTime - 30);
    await bounded(() => host.page.evaluate((time) => { document.querySelector("video").currentTime = time; }, destination));
    const aligned = await until(async () => {
      const states = await Promise.all(people.map((person) => observation(person.page)));
      return states.every((state) => !state.adPresent && Math.abs(state.currentTime - destination) < 2) && Math.abs(states[0].currentTime - states[1].currentTime) < 2;
    }, 10000);
    const positions = await Promise.all(people.map((person) => observation(person.page)));
    await requireCase(stage, aligned, { driftSeconds: Math.abs(positions[0].currentTime - positions[1].currentTime) });
    stage = "relay-reconnect";
    await bounded(() => host.page.evaluate(() => document.querySelector("video").play()), 5000);
    const playingBeforeReconnect = await until(async () => {
      const states = await Promise.all(people.map((person) => observation(person.page)));
      return states.every((state) => state.paused === false);
    }, 5000);
    // Require the new socket's acknowledgement, not the cached get-state membership.
    const resumed = await request(guest, { type: "set-server-url", url: relayUrl }, "room-joined");
    const rejoined = resumed.roomCode === created.roomCode && resumed.userId !== joined.userId;
    await bounded(() => host.page.evaluate(() => document.querySelector("video").pause()));
    const recovered = await until(async () => (await observation(guest.page)).paused, 5000);
    await requireCase(stage, playingBeforeReconnect && rejoined && recovered, { playingBeforeReconnect, membershipRestored: rejoined, pausePropagated: recovered });
    report.outcome = "partial";
    report.baselinePassed = true;
  }
} catch (error) {
  report.outcome = realPlayback && stage !== "local-relay" ? "failed" : "blocked";
  report.blocker = { stage, reason: reasonFor(error) };
  if (realPlayback && Date.now() < deadline - 4000) {
    const finalStates = await Promise.allSettled(people.map((person) => observation(person.page)));
    for (let i = 0; i < finalStates.length; i++) {
      const state = finalStates[i];
      if (state.status !== "fulfilled") continue;
      people[i].participant.failureObservation = state.value;
      if (state.value.adPresent || state.value.botChallenge || state.value.loginRequired || state.value.consentRequired || state.value.playerErrorVisible || state.value.mediaErrorCode || state.value.readyState < 2) {
        report.outcome = "blocked";
        report.blocker = { stage, reason: playbackBlocker(state.value) };
      }
    }
  }
  if (report.cases[stage] && report.cases[stage].status !== "passed") {
    report.cases[stage] = { ...report.cases[stage], status: report.outcome === "failed" ? "failed" : "blocked", reason: report.blocker.reason };
  }
} finally {
  // close() can hang on a decoding tab. Bound teardown and reap the child either way.
  await Promise.allSettled(browsers.map((browser) => bounded(() => browser.close(), 1500)));
  stopProcesses();
  clearTimeout(watchdog);
}

emit();
if (report.outcome === "failed" || (process.env.WT_PROVIDER_REQUIRE_PASS === "1" && !report.baselinePassed)) process.exitCode = 1;
