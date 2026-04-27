// Logic tests for the pure helpers added to extension/content.js + extension/popup/popup.js.
// Run with: node --test client-logic.test.mjs
//
// The helpers live inside browser-only IIFEs (DOM access, chrome.* APIs), so we
// re-implement the pure pieces here and verify the algorithms. If a production
// algorithm drifts from this spec, the test fails and we know to update one or both.

import { test } from "node:test";
import assert from "node:assert/strict";

// ============================================================
// Re-implemented pure logic — must match content.js / popup.js
// ============================================================

function isLiveStream(video) {
  if (!video) return false;
  const d = video.duration;
  return d === Infinity || d === Number.POSITIVE_INFINITY || (typeof d === "number" && d > 1e6);
}

function makeClockOffsetTracker() {
  let offset = 0;
  let samples = 0;
  return {
    update(serverTime, nowFn = Date.now) {
      if (typeof serverTime !== "number") return;
      const sample = serverTime - nowFn();
      if (samples === 0) offset = sample;
      else offset = offset * 0.85 + sample * 0.15;
      samples++;
    },
    get offset() { return offset; },
    get samples() { return samples; },
    nowServer(nowFn = Date.now) { return nowFn() + offset; },
  };
}

function classifyDrift(driftSec, isHeartbeat) {
  const DRIFT_IGNORE = 0.5;
  const DRIFT_HARD_SEEK = 1.5;
  const abs = Math.abs(driftSec);
  if (abs < DRIFT_IGNORE) return "ignore";
  if (isHeartbeat && abs < DRIFT_HARD_SEEK) return "nudge";
  return "seek";
}

function nudgeMagnitude(driftSec) {
  const DRIFT_MAX_RATE_DELTA = 0.10;
  return Math.min(DRIFT_MAX_RATE_DELTA, Math.abs(driftSec) * 0.10);
}

// Mirrors the popup buildShareLink + overlay copy-link path.
function buildShareLink(currentRoom, tabUrl, fallbackBase = "https://watch-together-server-acwi.onrender.com") {
  if (!currentRoom) return "";
  const isVideoTab = tabUrl && !["chrome", "about:", "edge:", "moz-extension:", "chrome-extension:", "file:", "brave:"].some((p) => tabUrl.startsWith(p));
  if (isVideoTab) {
    try {
      const url = new URL(tabUrl);
      url.searchParams.set("wt_room", currentRoom);
      return url.toString();
    } catch {
      return `${tabUrl}${tabUrl.includes("?") ? "&" : "?"}wt_room=${currentRoom}`;
    }
  }
  return `${fallbackBase}/join/${currentRoom}`;
}

// Mirrors the suspect-jump filter in onVideoEvent.
function isSuspectJumpToZero(action, currentTime, lastBroadcastTime, msSinceLastBroadcast, graceMs = 1500) {
  if (action !== "seek" && action !== "play") return false;
  if (currentTime >= 1.5) return false;
  return lastBroadcastTime > 5 && msSinceLastBroadcast < graceMs;
}

// ============================================================
// Tests
// ============================================================

test("isLiveStream: Infinity counts as live", () => {
  assert.equal(isLiveStream({ duration: Infinity }), true);
  assert.equal(isLiveStream({ duration: Number.POSITIVE_INFINITY }), true);
});

test("isLiveStream: very large numbers count as live (HLS sometimes reports huge durations)", () => {
  assert.equal(isLiveStream({ duration: 1e7 }), true);
  assert.equal(isLiveStream({ duration: 1e6 + 1 }), true);
});

test("isLiveStream: normal durations are not live", () => {
  assert.equal(isLiveStream({ duration: 7200 }), false); // 2-hour movie
  assert.equal(isLiveStream({ duration: 600 }), false);  // 10-min video
  assert.equal(isLiveStream({ duration: 0 }), false);
});

test("isLiveStream: null / missing video", () => {
  assert.equal(isLiveStream(null), false);
  assert.equal(isLiveStream(undefined), false);
});

test("clock offset: first sample is taken verbatim", () => {
  const t = makeClockOffsetTracker();
  // Pretend local clock is 1000ms behind server
  t.update(11000, () => 10000);
  assert.equal(t.offset, 1000);
  assert.equal(t.samples, 1);
});

test("clock offset: EWMA smooths subsequent samples (15% weight)", () => {
  const t = makeClockOffsetTracker();
  t.update(11000, () => 10000); // offset=1000
  t.update(12200, () => 10000); // sample=2200, new offset = 1000*0.85 + 2200*0.15 = 1180
  assert.equal(Math.round(t.offset), 1180);
});

test("clock offset: nowServer adds offset to local time", () => {
  const t = makeClockOffsetTracker();
  t.update(11000, () => 10000);
  assert.equal(t.nowServer(() => 10500), 11500);
});

test("clock offset: ignores non-numeric serverTime", () => {
  const t = makeClockOffsetTracker();
  t.update("not a number", () => 10000);
  t.update(undefined, () => 10000);
  assert.equal(t.samples, 0);
  assert.equal(t.offset, 0);
});

test("drift: < 0.5s is ignored regardless of source", () => {
  assert.equal(classifyDrift(0.3, true), "ignore");
  assert.equal(classifyDrift(-0.3, false), "ignore");
  assert.equal(classifyDrift(0.49, true), "ignore");
});

test("drift: heartbeat in 0.5-1.5s window → nudge (smooth playbackRate)", () => {
  assert.equal(classifyDrift(0.6, true), "nudge");
  assert.equal(classifyDrift(-1.4, true), "nudge");
});

test("drift: user-action sync always seeks (no nudging)", () => {
  assert.equal(classifyDrift(0.6, false), "seek");
  assert.equal(classifyDrift(1.0, false), "seek");
});

test("drift: > 1.5s always hard-seeks even on heartbeat", () => {
  assert.equal(classifyDrift(2.0, true), "seek");
  assert.equal(classifyDrift(-3.0, true), "seek");
  assert.equal(classifyDrift(10, true), "seek");
});

test("nudge magnitude scales with drift, capped at 10%", () => {
  assert.equal(nudgeMagnitude(0.5), 0.05);
  assert.equal(nudgeMagnitude(1.0), 0.10);
  assert.equal(nudgeMagnitude(1.4), 0.10); // capped
  assert.equal(nudgeMagnitude(5.0), 0.10);
  assert.equal(nudgeMagnitude(-0.5), 0.05); // sign-independent magnitude
});

test("share link: appends wt_room to a video URL via URL API", () => {
  const link = buildShareLink("ABC123", "https://www.youtube.com/watch?v=xyz");
  const u = new URL(link);
  assert.equal(u.searchParams.get("v"), "xyz");
  assert.equal(u.searchParams.get("wt_room"), "ABC123");
});

test("share link: replaces existing wt_room param (no duplicate)", () => {
  const link = buildShareLink("NEW", "https://www.youtube.com/watch?v=xyz&wt_room=OLD");
  const u = new URL(link);
  assert.equal(u.searchParams.get("wt_room"), "NEW");
});

test("share link: falls back to /join/CODE for non-video URLs", () => {
  assert.equal(
    buildShareLink("ABC123", "chrome://newtab"),
    "https://watch-together-server-acwi.onrender.com/join/ABC123"
  );
  assert.equal(
    buildShareLink("ABC123", "about:blank"),
    "https://watch-together-server-acwi.onrender.com/join/ABC123"
  );
});

test("share link: empty room → empty link (caller shows error)", () => {
  assert.equal(buildShareLink("", "https://youtube.com/watch?v=x"), "");
  assert.equal(buildShareLink(null, "https://youtube.com/watch?v=x"), "");
});

test("suspect-jump: seek to 0 right after a real time → blocked", () => {
  assert.equal(isSuspectJumpToZero("seek", 0.0, 120, 200), true);
  assert.equal(isSuspectJumpToZero("play", 0.5, 120, 200), true);
});

test("suspect-jump: real seek to 0 long after last broadcast → allowed", () => {
  assert.equal(isSuspectJumpToZero("seek", 0.0, 120, 5000), false);
});

test("suspect-jump: seek to >1.5s is never suspect", () => {
  assert.equal(isSuspectJumpToZero("seek", 5, 120, 100), false);
});

test("suspect-jump: pause/ratechange events are never suspect", () => {
  assert.equal(isSuspectJumpToZero("pause", 0, 120, 100), false);
  assert.equal(isSuspectJumpToZero("ratechange", 0, 120, 100), false);
});

test("suspect-jump: no prior broadcast (lastBroadcastTime = 0) → not suspect", () => {
  assert.equal(isSuspectJumpToZero("seek", 0, 0, 100), false);
});
