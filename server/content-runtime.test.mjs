// Run the shipped content script and adapters against a minimal browser boundary.
// Export lexical controls only in the VM so assertions exercise production behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function harness(site = 'generic') {
  const sent = [];
  const nodes = new Map();
  const timers = new Map();
  let nextTimer = 0;
  let now = 100000;
  class Node extends EventTarget {
    constructor() { super(); this.style = {}; this.children = []; }
    appendChild(node) { this.children.push(node); node.parentNode = this; if (node.id) nodes.set(node.id, node); }
    removeChild(node) { this.children = this.children.filter(n => n !== node); nodes.delete(node.id); }
  }
  const video = Object.assign(new Node(), {
    currentTime: 100, duration: 600, readyState: 4, paused: false, playbackRate: 1,
    clientWidth: 640, clientHeight: 360, offsetParent: {}, textTracks: [],
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
  });
  const body = new Node();
  const document = Object.assign(new Node(), {
    body, documentElement: body,
    createElement: () => new Node(),
    getElementById: id => nodes.get(id),
    querySelector: sel => /(^video(?:\[src\]|\.html5-main-video)?$| video$)/.test(sel) ? video : null,
    querySelectorAll: sel => sel === 'video' ? [video] : [],
    contains: el => el === video,
  });
  const storageCallbacks = [];
  const window = Object.assign(new Node(), { location: new URL(`https://${site === 'generic' ? 'example' : site}.com/watch`) });
  const context = vm.createContext({
    window, self: window, document, location: window.location, console, URL, URLSearchParams,
    Event, CustomEvent: class extends Event { constructor(type, opts) { super(type); this.detail = opts?.detail; } },
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearTimeout: id => timers.delete(id), setInterval: () => ++nextTimer, clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    chrome: {
      storage: { local: { get: (_keys, cb) => storageCallbacks.push(cb), set() {}, remove() {} }, onChanged: { addListener() {} } },
      runtime: { connect: () => ({ postMessage: msg => sent.push(msg), onMessage: { addListener: fn => { context.receive = fn; } }, onDisconnect: { addListener() {} } }) },
    },
  });
  for (const file of ['config.js', `adapters/${site}.js`, 'content.js']) {
    let src = readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8');
    if (file === 'content.js') src = src.replace('  // Initialize', `
      window.testCore = { applySync, sendHeartbeat, onVideoEvent, checkUrlChange,
        setOffset: n => { syncOffset = n; },
        setMembers: n => { roomMemberCount = n; },
        setAd: value => { markerDistrustUntil = value; },
        attachVideoListeners, onBufferEvent,
        setPending: state => { pendingPlaybackState = state; activeVideo = null; },
      };
      // Initialize`);
    vm.runInContext(src, context, { filename: file });
  }
  storageCallbacks.forEach(cb => cb({}));
  context.receive({ type: 'room-created', roomCode: 'ABCDEFGH', members: [{}, {}] });
  return { video, window, document, sent, timers, receive: context.receive, advance: ms => { now += ms; }, core: window.testCore };
}

for (const site of ['generic', 'youtube', 'netflix', 'jiohotstar']) {
  test(`${site}: live sync never seeks the DVR timeline`, () => {
    const h = harness(site);
    h.video.duration = Infinity;
    h.core.applySync({ type: 'sync', currentTime: 0, playing: false, isLive: true, playbackRate: 1 });
    assert.equal(h.video.currentTime, 100);
    assert.equal(h.video.paused, true);
  });
  test(`${site}: rate changes preserve position and heartbeat drift nudges`, () => {
    const h = harness(site);
    h.core.applySync({ type: 'sync', action: 'ratechange', currentTime: 20, playing: true, playbackRate: 1.25 });
    assert.equal(h.video.currentTime, 100);
    assert.equal(h.video.playbackRate, 1.25);
    h.core.applySync({ type: 'heartbeat', currentTime: 101, playing: true, playbackRate: 1.25 });
    assert.equal(h.video.currentTime, 100);
    assert.ok(h.video.playbackRate > 1.25);
    h.advance(2500);
    h.core.sendHeartbeat();
    assert.equal(h.sent.at(-1).playbackRate, 1.25);
  });
  test(`${site}: autoplay rejection presents a recoverable gesture prompt`, async () => {
    const h = harness(site);
    h.video.paused = true;
    h.video.play = () => Promise.reject(Object.assign(new Error('gesture'), { name: 'NotAllowedError' }));
    h.core.applySync({ type: 'sync', currentTime: 100, playing: true, playbackRate: 1 });
    await Promise.resolve(); await Promise.resolve();
    assert.ok(h.document.getElementById('wt-gesture-prompt'));
  });
}

test('outgoing actions translate the local offset back to room time', () => {
  const h = harness();
  h.core.setOffset(12);
  h.core.onVideoEvent({ type: 'pause', target: h.video });
  assert.equal(h.sent.at(-1).currentTime, 88);
});

test('negative local offset clamps seeks at zero', () => {
  const h = harness();
  h.core.setOffset(-12);
  h.core.applySync({ type: 'sync', currentTime: 3, playing: false, playbackRate: 1 });
  assert.equal(h.video.currentTime, 0);
});

test('leaving a room cancels a pending redirect and metadata sync', () => {
  const h = harness();
  h.video.readyState = 0;
  h.core.applySync({ type: 'sync', currentTime: 200, playing: true, playbackRate: 1 });
  h.receive({ type: 'navigate', url: 'https://example.com/other' });
  h.receive({ type: 'room-ended' });
  h.video.readyState = 4;
  h.video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(h.video.currentTime, 100);
  assert.equal([...h.timers.values()].filter(t => t.ms === 250).length, 0);
});


test('a pending sync survives attaching a player before its metadata arrives', () => {
  const h = harness();
  h.video.readyState = 0;
  h.core.setPending({ type: 'sync', currentTime: 200, playing: false, playbackRate: 1 });
  h.core.attachVideoListeners(h.video);
  h.video.readyState = 4;
  h.video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(h.video.currentTime, 200);
});

test('a server pause cannot falsely report that a buffering viewer recovered', () => {
  const h = harness();
  h.core.onBufferEvent({ type: 'waiting' });
  const announce = [...h.timers.values()].find(t => t.ms === 1200);
  announce.fn();
  assert.equal(h.sent.at(-1).state, 'buffering');
  h.core.applySync({ type: 'sync', currentTime: 100, playing: false, playbackRate: 1 });
  h.core.onBufferEvent({ type: 'pause' });
  assert.equal(h.sent.at(-1).state, 'buffering');
  h.core.onBufferEvent({ type: 'canplay' });
  assert.ok(h.sent.some(msg => msg.type === 'presence' && msg.state === 'watching'));
});
