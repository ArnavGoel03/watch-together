import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
function fixture({ observer = true } = {}) {
  const events = () => ({
    listeners: new Map(),
    addEventListener(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) || []), fn]); },
    emit(name, value = {}) { for (const fn of this.listeners.get(name) || []) fn(value); },
  });
  function element() {
    const classes = new Set();
    const children = new Map();
    return Object.assign(events(), {
      textContent: "", style: {}, attributes: {}, frames: [],
      classList: { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)), contains: x => classes.has(x), toggle: (x, on) => on ? classes.add(x) : classes.delete(x) },
      querySelector(key) { if (!children.has(key)) children.set(key, element()); return children.get(key); },
      querySelectorAll() { return []; },
      setAttribute(key, value) { this.attributes[key] = value; },
      getAttribute(key) { return this.attributes[key]; },
      appendChild(child) { this.frames.push(child); },
      contentWindow: { messages: [], postMessage(value) { this.messages.push(JSON.parse(value)); } },
    });
  }
  const stage = element();
  const document = Object.assign(events(), { readyState: "loading", hidden: false,
    querySelector: key => key === "[data-demo]" ? stage : null,
    querySelectorAll: () => [], createElement: element });
  const window = events();
  const observers = [];
  window.IntersectionObserver = class {
    constructor(fn) { this.fn = fn; observers.push(this); }
    observe(target) { this.target = target; }
  };
  if (!observer) delete window.IntersectionObserver;
  let time = 0, serial = 0, renders = 0;
  const frames = new Map(), timers = new Map(), intervals = new Map();
  const context = vm.createContext({ document, window, URLSearchParams, location: { origin: "https://fixture.test" },
    IntersectionObserver: window.IntersectionObserver, performance: { now: () => time },
    requestAnimationFrame: fn => { const id = ++serial; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: fn => { const id = ++serial; timers.set(id, fn); return id; },
    setInterval: fn => { const id = ++serial; intervals.set(id, fn); return id; },
    clearInterval: id => intervals.delete(id),
    rendered: () => renders++,
  });
  vm.runInContext(`${source}\nconst originalRender = Member.prototype.render; Member.prototype.render = function (...args) { rendered(); return originalRender.apply(this, args); }; start();`, context);
  const visible = on => observers.find(o => o.target === stage)?.fn([{ isIntersecting: on }]);
  return { stage, document, window, frames, intervals, visible,
    click: key => stage.querySelector(key).emit("click"),
    renderCount: () => renders,
    step(ms = 16) { time += ms; const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(time)); },
    elapse(ms) { time += ms; },
    timeout() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
    message(info, origin = "https://www.youtube-nocookie.com", event = "infoDelivery") {
      const frame = stage.querySelector('[data-screen="you"]').querySelector("[data-frame]").frames[0];
      window.emit("message", { origin, source: frame.contentWindow, data: JSON.stringify({ event, info }) });
    },
  };
}

test("actual demo schedules no frames before play or after pausing", () => {
  const f = fixture(); f.visible(true);
  assert.equal(f.frames.size, 0);
  f.click("[data-start]"); assert.equal(f.frames.size, 1);
  f.step(); assert.equal(f.frames.size, 1);
  f.click("[data-play]"); assert.equal(f.frames.size, 0);
});

test("offscreen player updates do not seek against a sleeping room clock", () => {
  const f = fixture(); f.visible(true); f.click("[data-start]");
  f.message({}, undefined, "onReady");
  f.elapse(2000); f.message({ playerState: 1, currentTime: 12 }); f.step();
  const screen = f.stage.querySelector('[data-screen="you"]');
  const player = screen.querySelector("[data-frame]").frames[0].contentWindow;
  f.visible(false); f.elapse(60000);
  const seeks = player.messages.filter(m => m.func === "seekTo").length;
  f.message({ playerState: 1, currentTime: 120 });
  assert.equal(player.messages.filter(m => m.func === "seekTo").length, seeks);
  assert.equal(f.frames.size, 0);
  f.visible(true); f.step();
  assert.equal(screen.querySelector(".time").textContent, "2:00");
});

test("without IntersectionObserver the controls remain usable and paused work stays idle", () => {
  const f = fixture({ observer: false });
  assert.equal(f.frames.size, 0);
  f.click("[data-start]"); assert.equal(f.frames.size, 1);
  f.click("[data-play]"); assert.equal(f.frames.size, 0);
});

test("offscreen and hidden demos stop rendering, then resume without a catch-up jump", () => {
  const f = fixture(); f.visible(true); f.click("[data-start]"); f.step(100);
  const fill = f.stage.querySelector('[data-screen="you"]').querySelector(".fill");
  const before = parseFloat(fill.style.width);
  f.visible(false); assert.equal(f.frames.size, 0);
  const renders = f.renderCount(); f.elapse(60000); f.step(); assert.equal(f.renderCount(), renders);
  f.visible(true); assert.equal(f.frames.size, 1); f.step();
  assert.ok(parseFloat(fill.style.width) - before < 0.02);
  f.document.hidden = true; f.document.emit("visibilitychange"); assert.equal(f.frames.size, 0);
  f.document.hidden = false; f.document.emit("visibilitychange"); assert.equal(f.frames.size, 1);
  f.window.emit("pagehide"); assert.equal(f.frames.size, 0);
  f.window.emit("pageshow"); assert.equal(f.frames.size, 1);
});

test("a paused room completes an interruption and returns to idle", () => {
  const f = fixture(); f.visible(true); f.click("[data-start]"); f.click("[data-play]");
  f.click("[data-ad-one]"); assert.equal(f.frames.size, 1);
  for (let i = 0; i < 33; i++) f.step(250);
  assert.equal(f.stage.querySelector('[data-screen="them"]').querySelector(".screen-state").textContent, "paused");
  assert.equal(f.frames.size, 0);
});

test("failed embeds use authenticated player messages for late recovery, with no polling", () => {
  const f = fixture(); f.visible(true); f.click("[data-start]"); f.timeout();
  assert.ok(f.stage.classList.contains("is-fallback")); assert.equal(f.intervals.size, 0);
  f.message({ playerState: 1 }, "https://untrusted.test"); assert.ok(f.stage.classList.contains("is-fallback"));
  f.message({ playerState: 3 }); assert.ok(f.stage.classList.contains("is-live"));
  assert.equal(f.stage.classList.contains("is-fallback"), false);
});
