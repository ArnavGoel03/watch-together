// Load the marketing site the way Vercel will serve it, and check the hero demo works.
//
// This exists because of a specific failure. An earlier CSP on this site blocked its own
// stylesheet and script: every request returned 200, the page looked served, and the only
// symptom was that nothing moved. A check that fetches HTML cannot see that, so this one
// applies the real vercel.json headers, runs a browser against them, and fails on any
// console error or blocked request.
//
// Run: node scripts/check-site.mjs

import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Puppeteer is already installed under server/ for the browser tests and the store
// screenshots. Resolving it from there rather than adding it to the root avoids a second
// several-hundred-megabyte Chromium download for one check.
const require = createRequire(new URL("../server/package.json", import.meta.url));
const puppeteer = require("puppeteer");

const ROOT = fileURLToPath(new URL("../site", import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const config = JSON.parse(await readFile(join(ROOT, "vercel.json"), "utf8"));
const globalHeaders = Object.fromEntries(
  config.headers.find((h) => h.source === "/(.*)").headers.map((h) => [h.key, h.value]),
);

function serve() {
  const server = createServer(async (req, res) => {
    // cleanUrls: /privacy resolves to privacy.html, the same as in production.
    let path = normalize(decodeURIComponent(req.url.split("?")[0]));
    if (path === "/") path = "/index.html";
    if (!extname(path)) path += ".html";
    try {
      const body = await readFile(join(ROOT, path));
      res.writeHead(200, { ...globalHeaders, "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, globalHeaders);
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const problems = [];
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--window-size=1280,900"],
  defaultViewport: { width: 1280, height: 900 },
});

try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    const request = window.requestAnimationFrame;
    window.__siteFrames = 0;
    window.requestAnimationFrame = (callback) => request.call(window, (now) => {
      window.__siteFrames++;
      callback(now);
    });
  });

  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // The embed's own frame is a third party we do not control; its internal noise is
    // not this site's problem. Anything from our own origin is.
    if (/youtube|ytimg|ERR_BLOCKED_BY_CLIENT|net::ERR_/i.test(text)) return;
    problems.push(`console error: ${text}`);
  });
  page.on("requestfailed", (r) => {
    if (r.url().startsWith(base)) problems.push(`request failed: ${r.url()} ${r.failure()?.errorText}`);
  });
  page.on("response", (r) => {
    if (r.url().startsWith(base) && r.status() >= 400) problems.push(`${r.status()} for ${r.url()}`);
  });

  await page.goto(`${base}/`, { waitUntil: "networkidle2", timeout: 20000 });
  if (await page.evaluate(() => window.__siteFrames) !== 0) problems.push("idle demo scheduled animation frames before play");

  // The stylesheet and script must have actually APPLIED, not merely returned 200.
  const applied = await page.evaluate(() => ({
    styled: getComputedStyle(document.querySelector(".stage")).position !== "static"
      || getComputedStyle(document.querySelector(".screens")).display === "grid",
    scripted: typeof document.querySelector("[data-start]")?.onclick !== "undefined"
      && document.querySelectorAll(".track").length === 2,
  }));
  if (!applied.styled) problems.push("stylesheet did not apply: the CSP is blocking the site's own CSS");

  // The container once reset section padding to zero. Check actual geometry so a
  // valid stylesheet cannot silently bring that cramped layout back.
  const evidence = fileURLToPath(new URL("../.firecrawl/site-layout/", import.meta.url));
  await mkdir(evidence, { recursive: true });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewport({ width, height: 1000 });
    const layout = await page.evaluate(() => {
      const sections = [...document.querySelectorAll("header.wrap, main > section.wrap")];
      const bounds = [...document.querySelectorAll("nav, h1, h2, .card, .screen, .stage-controls, .privacy-intro, .privacy ul, footer")];
      return {
        spaced: sections.every((el) => parseFloat(getComputedStyle(el).paddingTop) >= 64
          && parseFloat(getComputedStyle(el).paddingBottom) >= 64),
        contained: bounds.every((el) => {
          const r = el.getBoundingClientRect();
          return r.left >= -1 && r.right <= innerWidth + 1;
        }),
        footer: parseFloat(getComputedStyle(document.querySelector("footer")).paddingTop) >= 24,
      };
    });
    for (const [check, passed] of Object.entries(layout)) {
      if (!passed) problems.push(`${width}px layout failed: ${check}`);
    }
    if (width === 390 || width === 1440) {
      // Full-page captures can omit offscreen composited content after resizing.
      // Bring each section into the viewport and let layout/paint settle first.
      const targets = ["header", "#how", "#how .card:nth-child(3)", "#how .card:nth-child(5)", "#getting-started", ".privacy", "footer"];
      for (const [index, target] of targets.entries()) {
        await page.$eval(target, (el) => window.scrollTo({
          top: el.getBoundingClientRect().top + window.scrollY - 90, behavior: "instant",
        }));
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.screenshot({ path: join(evidence, `homepage-${width}-${index}.png`) });
      }
    }
  }
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const readable = await page.evaluate(() => [...document.querySelectorAll(".privacy li, .privacy .note")]
    .every((el) => getComputedStyle(el).opacity === "1" && getComputedStyle(el).visibility === "visible"));
  if (!readable) problems.push("privacy text is hidden or faded at the bottom of the page");
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));

  // Press play, then confirm two embeds appeared and the room drives them.
  await page.click("[data-start]");
  await page.waitForFunction(() => document.querySelectorAll(".pic iframe").length === 2, { timeout: 10000 })
    .catch(() => problems.push("the demo did not create both players"));

  const live = await page.evaluate(() => document.querySelector(".stage").classList.contains("is-live"));
  if (!live) problems.push("the stage never went live");

  const frames = await page.evaluate(() =>
    [...document.querySelectorAll(".pic iframe")].map((f) => new URL(f.src).origin));
  if (!frames.every((o) => o === "https://www.youtube-nocookie.com")) {
    problems.push(`embeds point somewhere unexpected: ${frames.join(", ")}`);
  }

  await page.click("[data-play]");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const pausedFrames = await page.evaluate(() => window.__siteFrames);
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (await page.evaluate(() => window.__siteFrames) !== pausedFrames) problems.push("paused demo kept scheduling frames");
  await page.click("[data-play]");
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const hiddenFrames = await page.evaluate(() => window.__siteFrames);
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (await page.evaluate(() => window.__siteFrames) !== hiddenFrames) problems.push("offscreen demo kept scheduling frames");
  await page.$eval("[data-demo]", (el) => el.scrollIntoView({ behavior: "instant", block: "center" }));
  await page.waitForFunction((before) => window.__siteFrames > before, { timeout: 2000 }, hiddenFrames)
    .catch(() => problems.push("visible playing demo did not resume frames"));

  // The clock must hold when an advert catches everyone. This is the differentiator, and
  // it is checked here rather than trusted, because it is the thing most easily broken by
  // an edit that looks harmless.
  await page.click("[data-ad-both]");
  const before = await page.evaluate(() => document.querySelector('[data-screen="you"] .time').textContent);
  await new Promise((r) => setTimeout(r, 2500));
  const after = await page.evaluate(() => document.querySelector('[data-screen="you"] .time').textContent);
  if (before !== after) problems.push(`clock advanced during a shared advert: ${before} then ${after}`);

  const state = await page.evaluate(() => document.querySelector('[data-screen="you"] .screen-state').textContent);
  if (!/ad break|holding/.test(state)) problems.push(`expected an advert state, saw "${state}"`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) {
  console.error("site check failed:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("site check passed: CSP allows the site's own assets, both embeds load, the clock holds through a shared advert");
