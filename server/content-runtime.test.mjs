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
  const storageWrites = [];
  let sendFailure = false;
  const window = Object.assign(new Node(), { location: new URL(`https://${site === 'generic' ? 'example' : site}.com/watch`) });
  const context = vm.createContext({
    window, self: window, document, location: window.location, console, URL, URLSearchParams,
    Event, CustomEvent: class extends Event { constructor(type, opts) { super(type); this.detail = opts?.detail; } },
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearTimeout: id => timers.delete(id), setInterval: () => ++nextTimer, clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    chrome: {
      storage: { local: { get: (_keys, cb) => storageCallbacks.push(cb), set: data => storageWrites.push(data), remove() {} }, onChanged: { addListener() {} } },
      runtime: { connect: () => ({ postMessage: msg => { if (sendFailure) throw new Error('Port disconnected'); sent.push(msg); }, onMessage: { addListener: fn => { context.receive = fn; } }, onDisconnect: { addListener() {} } }) },
    },
  });
  for (const file of ['config.js', `adapters/${site}.js`, 'content.js']) {
    let src = readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8');
    if (file === 'content.js') src = src.replace('  // Initialize', `
      window.testCore = { applySync, sendHeartbeat, onVideoEvent, checkUrlChange, sendMsg, connectToBackground,
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
  return { video, window, document, sent, timers, storageWrites, failSend: value => { sendFailure = value; }, receive: msg => context.receive(msg), advance: ms => { now += ms; }, core: window.testCore };
}

test('remote navigation strips invitation hints without publishing consent to other tabs', () => {
  const h = harness();
  const before = h.storageWrites.length;
  h.receive({ type: 'navigate', url: 'https://example.com/episode?v=2&wt_room=OTHER&wt_invite=secret&wt_relay=wss%3A%2F%2Frelay.example#chapter' });
  const redirect = [...h.timers.values()].find(timer => timer.ms === 250);
  assert.ok(redirect);
  redirect.fn();
  assert.equal(h.window.location.href, 'https://example.com/episode?v=2#chapter');
  assert.equal(h.storageWrites.length, before);
  assert.equal(h.sent.some(message => message.type === 'join-room'), false);
});

test('a failed join retries only in its originating content context after port reconnection', () => {
  const origin = harness();
  const bystander = harness();
  origin.receive({ type: 'room-ended' });
  bystander.receive({ type: 'room-ended' });
  origin.failSend(true);
  origin.core.sendMsg({ type: 'join-room', roomCode: 'ABCDEF', inviteToken: 'secret' });
  assert.equal(origin.sent.some(message => message.type === 'join-room'), false);
  assert.equal(origin.storageWrites.length, 0);
  bystander.core.connectToBackground();
  assert.equal(bystander.sent.some(message => message.type === 'join-room'), false);
  origin.failSend(false);
  origin.core.connectToBackground();
  const joins = origin.sent.filter(message => message.type === 'join-room');
  assert.equal(joins.length, 1);
  assert.equal(joins[0].inviteToken, 'secret');
  origin.core.connectToBackground();
  assert.equal(origin.sent.filter(message => message.type === 'join-room').length, 1);
  assert.equal([...origin.timers.values()].some(timer => timer.ms === 20000), false);
});

for (const cancel of ['room-ended', 'navigate', 'spa', 'expired']) {
  test(`local join retry is cancelled by ${cancel}`, () => {
    const h = harness();
    h.receive({ type: 'room-ended' });
    h.failSend(true);
    h.core.sendMsg({ type: 'join-room', roomCode: 'ABCDEF' });
    if (cancel === 'spa') {
      h.window.location.href = 'https://example.com/another';
      h.core.checkUrlChange();
    } else if (cancel === 'expired') {
      h.advance(20001);
      [...h.timers.values()].find(timer => timer.ms === 20000).fn();
    } else h.receive({ type: cancel, url: 'https://example.com/another' });
    h.failSend(false);
    h.core.connectToBackground();
    assert.equal(h.sent.some(message => message.type === 'join-room'), false);
    assert.equal([...h.timers.values()].some(timer => timer.ms === 20000), false);
  });
}

test('film volume survives remount while transient ducking leaves the preference intact', () => {
  const h = harness();
  h.window.__wtCore.setVolume(0.65);
  assert.equal(h.video.volume, 0.65);
  h.window.__wtCore.setVolume(0.15, true);
  const replacement = Object.assign(new EventTarget(), { textTracks: [], playbackRate: 1, volume: 1 });
  h.core.attachVideoListeners(replacement);
  assert.equal(replacement.volume, 0.15);
  assert.equal(h.window.__wtCore.getVolume(), 0.65);
  h.window.__wtCore.setVolume(0.8);
  assert.equal(replacement.volume, 0.8);
  h.window.__wtCore.setVolume(NaN);
  assert.equal(replacement.volume, 0.8);
});

test('diagnostics export constructs a safe schema and drops secret-bearing unknown fields', () => {
  const h = harness();
  const input = {
    connectionState: 'connected', rttMs: 12, reconnectAttempts: 3,
    url: 'https://private.example/video', roomCode: 'SECRET', token: 'secret', chat: 'private', ip: '127.0.0.1',
    events: [{ event: 'connected', atMs: 1, token: 'secret' }, {event: 'https://private.example', atMs: 2}, { event: 'pong', atMs: 3, value: Infinity }],
  };
  const report = JSON.parse(JSON.stringify(h.window.__wtConfig.buildDiagnosticsReport(input, -0.5)));
  assert.deepEqual(report, { schemaVersion: 1, connectionState: 'connected', rttMs: 12, driftSeconds: -0.5, reconnectAttempts: 3, events: [{event: 'connected', atMs: 1}, {event: 'pong', atMs: 3}] });
  assert.equal(h.window.__wtConfig.buildDiagnosticsReport({...input, events: Array(200).fill(input.events[0])}).events.length, 100);
});

test('installed and older versions never leave a stale update indicator', () => {
  const cfg = harness().window.__wtConfig;
  assert.equal(cfg.isNewerVersion('1.3.0', '1.3.0'), false);
  assert.equal(cfg.isNewerVersion('1.2.9', '1.3.0'), false);
  assert.equal(cfg.isNewerVersion('1.10.0', '1.9.9'), true);
  assert.equal(cfg.isNewerVersion('malformed', '1.3.0'), false);
});

test('invite builder carries authoritative credentials and removes stale invite parameters', () => {
  const h = harness();
  const cfg = h.window.__wtConfig;
  const token = 'a'.repeat(64);
  const url = new URL(cfg.buildInviteUrl({videoUrl: 'https://www.youtube.com/watch?v=video&wt_invite=stale', roomCode: 'ABCDEF', inviteToken: token, serverUrl: cfg.SERVER_URLS[1]}));
  assert.equal(url.searchParams.get('v'), 'video');
  assert.equal(url.searchParams.get('wt_invite'), token);
  assert.equal(url.searchParams.get('wt_relay'), cfg.SERVER_URLS[1]);
  assert.equal(cfg.offsetKeyFor(url.href), cfg.offsetKeyFor('https://www.youtube.com/watch?v=video'));
  const fallback = new URL(cfg.buildInviteUrl({roomCode: 'ABCDEF', inviteToken: token, serverUrl: 'ws://localhost:4568'}));
  assert.equal(fallback.origin, 'http://localhost:4568');
  assert.equal(fallback.pathname, '/join/ABCDEF');
  assert.equal(fallback.searchParams.get('invite'), token);
});

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
