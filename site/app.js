// The hero demo.
//
// The most persuasive thing this page can do is not describe synchronised playback, it is
// BE synchronised playback. So these are two real YouTube players, in two separate frames,
// driven by one shared room clock that the visitor can scrub, pause and interrupt. The
// rules below are the same rules the extension's relay applies to a real room; nothing
// here is a video of a video.
//
// No framework and no WebGL. A shared clock and two embeds is both cheaper than a canvas
// and a truer picture of what the product actually does.

const VIDEO_ID = "dQw4w9WgXcQ";
const EMBED_ORIGIN = "https://www.youtube-nocookie.com";
const FALLBACK_DURATION = 213;
const AD_LENGTH = 8;
const BUFFER_LENGTH = 5;

// How far a player may drift from the room before it is pulled back. Below roughly a
// third of a second a correction is more visible than the drift it fixes.
const DRIFT_TOLERANCE = 0.55;
// A seek takes a moment to land, and reading the old position in the meantime would
// trigger another seek, and another. One correction, then wait.
const SEEK_COOLDOWN_MS = 1400;
// How long to give the embeds before deciding they are not coming. Some browsers and
// some networks refuse YouTube embeds outright, and a visitor must never be shown
// YouTube's "video unavailable" card where the demo should be.
//
// The test is whether the player ENGAGED, not whether it reached playing. Two streams
// starting at once on one connection can sit in the buffering state for a while, and an
// earlier version of this gave up at six and a half seconds and marked both players
// permanently failed, which hid a video that was seconds from playing. Buffering means
// the command landed and the player is working, so it counts.
const EMBED_TIMEOUT_MS = 11000;

const fmt = (t) => {
  const m = Math.floor(t / 60);
  const s = Math.floor(Math.max(0, t) % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

/**
 * One embedded player, spoken to over postMessage.
 *
 * Deliberately not the YouTube IFrame API script: loading their JavaScript into this
 * origin would mean widening script-src for a page that otherwise runs nothing but its
 * own code. The frame's message channel does everything needed here.
 */
class Player {
  constructor(mount, { muted }) {
    this.time = 0;
    this.duration = FALLBACK_DURATION;
    this.ready = false;
    this.started = false;
    // Engaged means the player answered: playing, or buffering on its way there. It is
    // the signal the fallback watches, because reaching "playing" can take a while and
    // reaching "buffering" already proves the embed is alive.
    this.engaged = false;
    this.failed = false;
    this.lastSeek = 0;
    this.muted = muted;

    const params = new URLSearchParams({
      enablejsapi: "1",
      origin: location.origin,
      controls: "0",
      disablekb: "1",
      modestbranding: "1",
      rel: "0",
      playsinline: "1",
      iv_load_policy: "3",
      mute: muted ? "1" : "0",
      loop: "1",
      playlist: VIDEO_ID,
    });

    this.frame = document.createElement("iframe");
    this.frame.src = `${EMBED_ORIGIN}/embed/${VIDEO_ID}?${params}`;
    this.frame.title = "Demonstration video";
    this.frame.allow = "autoplay; encrypted-media";
    this.frame.setAttribute("tabindex", "-1");
    this.frame.addEventListener("load", () => this.listen());
    this.wanted = null;
    mount.appendChild(this.frame);
  }

  /* The handshake that starts the position stream.
   *
   * Posted on the frame's load event AND again on onReady, because load fires when the
   * document arrives, not when the widget is listening. Sent only on load it is dropped,
   * never retried, and no infoDelivery ever arrives: the player then plays perfectly
   * while this page believes it never started, and the fallback hides a working video.
   * That is exactly what happened, and it was only visible in a real browser. */
  listen() {
    this.post({ event: "listening", id: 1, channel: "widget" });
  }

  /** The widget is now listening, so queued intent can be applied for real. */
  markReady() {
    if (this.ready) return;
    this.ready = true;
    // Anything said before now was discarded by the widget, so the record of what was
    // asked for has to be cleared or the guard below would suppress the real command as
    // a duplicate of one that was never delivered.
    this.wanted = null;
    this.listen();
  }

  post(payload) {
    this.frame.contentWindow?.postMessage(JSON.stringify(payload), EMBED_ORIGIN);
  }

  send(func, args = []) {
    if (!this.ready) return;
    this.post({ event: "command", func, args, id: 1, channel: "widget" });
  }

  /* Only speak when the intent actually changes. reconcile() runs every animation frame,
   * so an unguarded play() was posting sixty messages a second across a frame boundary
   * for no benefit. */
  play() {
    if (this.wanted === "play") return;
    this.wanted = "play";
    this.send("playVideo");
  }

  pause() {
    if (this.wanted === "pause") return;
    this.wanted = "pause";
    this.send("pauseVideo");
  }

  setMuted(muted) {
    this.muted = muted;
    this.send(muted ? "mute" : "unMute");
  }

  seek(t) {
    this.time = t;
    this.lastSeek = performance.now();
    this.send("seekTo", [t, true]);
  }

  /** True while a seek is still settling, so drift readings are not to be trusted. */
  get settling() { return performance.now() - this.lastSeek < SEEK_COOLDOWN_MS; }

  accept(info) {
    if (info.playerState === 1 || info.playerState === 3) this.engaged = true;
    if (info.playerState === 1 || info.currentTime > 0) {
      this.started = true;
      this.engaged = true;
    }
    if (typeof info.currentTime === "number") this.time = info.currentTime;
    if (typeof info.duration === "number" && info.duration > 0) this.duration = info.duration;
  }
}

class Member {
  constructor(room, el, name, { muted }) {
    this.room = room;
    this.el = el;
    this.name = name;
    this.muted = muted;
    this.state = "watching"; // watching | ad | buffering
    this.remaining = 0;
    this.player = null;
    room.add(this);
  }

  attach() {
    if (this.player) return;
    this.player = new Player(this.el.querySelector("[data-frame]"), { muted: this.muted });
  }

  owns(frame) { return this.player?.frame.contentWindow === frame; }

  interrupt(kind, seconds) {
    this.state = kind;
    this.remaining = seconds;
    this.player?.pause();
  }

  /** The position this member can actually see, which is the player's own clock. */
  get position() {
    if (this.player?.started && !this.player.failed) return this.player.time;
    return this.room.position;
  }

  tick(dt) {
    if (this.state === "watching") return;
    this.remaining -= dt;
    if (this.remaining > 0) return;

    // Coming back from an advert or a stall, rejoin the room rather than resuming where
    // the picture happened to stop. This is the whole trick: the room decided what time
    // it is, not this player.
    this.state = "watching";
    this.remaining = 0;
    if (this.player && !this.player.failed && this.room.live) {
      this.player.seek(this.room.position);
      if (this.room.playing) this.player.play();
    }
  }

  /** Hold this player against the room clock, the way the extension holds a real one. */
  reconcile() {
    const p = this.player;
    if (!p?.ready || p.failed || this.state !== "watching") return;

    if (!this.room.playing) { p.pause(); return; }
    p.play();

    if (p.settling) return;
    if (Math.abs(p.time - this.room.position) > DRIFT_TOLERANCE) p.seek(this.room.position);
  }

  render(roomDark) {
    const el = this.el;
    el.classList.toggle("is-ad", this.state === "ad");

    const dot = el.querySelector(".dot");
    dot.className =
      "dot" + (this.state === "ad" ? " ad" : this.state === "buffering" ? " buf" : "");

    el.querySelector(".screen-state").textContent =
      this.state === "ad" ? "ad break"
      : this.state === "buffering" ? "buffering"
      : roomDark ? "holding"
      : this.room.playing ? "watching"
      : "paused";

    if (this.state === "ad") {
      // One full sweep of the hand per second, and a number that restarts its own
      // entrance on every tick, the way a projection leader does.
      const count = el.querySelector("[data-ad-count]");
      const secs = String(Math.ceil(this.remaining));
      if (count.textContent !== secs) {
        count.textContent = secs;
        count.classList.remove("is-tick");
        void count.offsetWidth; // reflow, or the animation never restarts
        count.classList.add("is-tick");
      }
      const swept = 1 - (this.remaining - Math.floor(this.remaining));
      el.querySelector("[data-ad-hand]").style.transform = `rotate(${swept * 360}deg)`;
    }

    const pos = this.position;
    const pct = (pos / this.room.duration) * 100;
    el.querySelector(".fill").style.width = `${Math.max(0, Math.min(100, pct))}%`;
    el.querySelector(".head").style.left = `${Math.max(0, Math.min(100, pct))}%`;
    el.querySelector(".time").textContent = fmt(pos);
  }
}

class Room {
  constructor() {
    this.position = 0;
    this.playing = false;
    this.live = false; // true once the embeds exist
    this.members = [];
    this.last = performance.now();
    this.onchange = () => {};
  }

  add(member) { this.members.push(member); return member; }

  get duration() {
    for (const m of this.members) {
      if (m.player?.duration) return m.player.duration;
    }
    return FALLBACK_DURATION;
  }

  /** True when nobody can currently see the film, which is when the clock must hold. */
  get dark() {
    return this.members.length > 0 && this.members.every((m) => m.state !== "watching");
  }

  /** Whoever the room takes its time from: someone who can actually see the picture. */
  get leader() {
    return this.members.find(
      (m) => m.state === "watching" && m.player?.started && !m.player.failed && !m.player.settling,
    );
  }

  tick(now) {
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;

    for (const m of this.members) m.tick(dt);

    // The rule the whole product turns on: with nobody watching, the film does not
    // advance. Without this an advert that catches everyone convinces the room that time
    // passed, and everybody is thrown that far forward when they come back.
    if (this.playing && !this.dark) {
      const leader = this.leader;
      if (leader) this.position = leader.position;
      else this.position = Math.min(this.duration, this.position + dt);
    }

    for (const m of this.members) m.reconcile();
    this.onchange();
  }

  seek(t) {
    this.position = Math.max(0, Math.min(this.duration, t));
    for (const m of this.members) {
      if (m.state === "watching" && m.player && !m.player.failed) m.player.seek(this.position);
    }
    this.onchange();
  }

  setPlaying(playing) {
    this.playing = playing;
    for (const m of this.members) {
      if (m.state !== "watching") continue;
      if (!m.player || m.player.failed) continue;
      if (playing) m.player.play();
      else m.player.pause();
    }
    this.onchange();
  }
}

function start() {
  page();
  const stage = document.querySelector("[data-demo]");
  if (!stage) return;

  const room = new Room();
  // Only one side ever carries sound, which is the honest answer to "will we hear it
  // twice". In a real room you hear your own tab and nobody else's.
  const you = new Member(room, stage.querySelector('[data-screen="you"]'), "You", { muted: true });
  const them = new Member(room, stage.querySelector('[data-screen="them"]'), "Priya", { muted: true });

  const hint = stage.querySelector("[data-hint]");
  const playBtn = stage.querySelector("[data-play]");
  const soundBtn = stage.querySelector("[data-sound]");
  const say = (text) => { hint.textContent = text; };

  room.onchange = () => {
    const dark = room.dark;
    you.render(dark);
    them.render(dark);
    playBtn.textContent = room.playing ? "Pause" : "Play";
  };

  // One message channel for both frames; each member claims the ones from its own.
  window.addEventListener("message", (e) => {
    if (e.origin !== EMBED_ORIGIN) return;
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    const member = room.members.find((m) => m.owns(e.source));
    if (!member) return;

    // onReady is the only reliable signal that the widget will now hear us. Commands sent
    // before it are silently discarded, so the room's current state is applied here
    // rather than at attach time.
    if (data.event === "onReady") {
      member.player.markReady();
      member.player.setMuted(member.player.muted);
      member.player.seek(room.position);
      if (room.playing && member.state === "watching") member.player.play();
      return;
    }
    if (data.event === "infoDelivery" && data.info) member.player.accept(data.info);
  });

  let live = false;
  const goLive = () => {
    if (live) return;
    live = true;
    room.live = true;
    stage.classList.add("is-live");
    for (const m of room.members) m.attach();
    room.setPlaying(true);
    say("Two separate players, one room. Interrupt either one.");

    // If the embeds never start, take them away rather than leaving YouTube's error card
    // sitting where the product demo should be. Everything else still works: the room
    // clock, the adverts, the stall, the scrubbers.
    setTimeout(() => {
      if (room.members.some((m) => m.player?.engaged)) return;
      for (const m of room.members) {
        if (m.player) m.player.failed = true;
      }
      stage.classList.remove("is-live");
      stage.classList.add("is-fallback");
      say("The embeds are blocked here, so this is the room clock on its own. Everything below still holds.");

      // Giving up is not final. A slow embed that arrives late is put back rather than
      // left hidden behind a poster for the rest of the visit.
      const recover = setInterval(() => {
        if (!room.members.some((m) => m.player?.engaged)) return;
        clearInterval(recover);
        for (const m of room.members) {
          if (m.player) m.player.failed = false;
        }
        stage.classList.remove("is-fallback");
        stage.classList.add("is-live");
        say("Two separate players, one room. Interrupt either one.");
      }, 1000);
    }, EMBED_TIMEOUT_MS);
  };

  stage.querySelector("[data-start]").addEventListener("click", goLive);

  // Scrubbing either track moves the room, because in the real thing anyone can drive.
  for (const track of stage.querySelectorAll(".track")) {
    const seekFrom = (e) => {
      const r = track.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      room.seek(Math.max(0, Math.min(1, x / r.width)) * room.duration);
    };
    let dragging = false;
    track.addEventListener("pointerdown", (e) => {
      goLive();
      dragging = true;
      track.setPointerCapture(e.pointerId);
      seekFrom(e);
      say("Either of you can scrub. The room follows whoever moved.");
    });
    track.addEventListener("pointermove", (e) => { if (dragging) seekFrom(e); });
    track.addEventListener("pointerup", () => { dragging = false; });
    track.addEventListener("pointercancel", () => { dragging = false; });
  }

  const togglePlaying = () => {
    if (!live) { goLive(); return; }
    room.setPlaying(!room.playing);
    say(room.playing ? "Playing, for both of you." : "Paused, for both of you.");
  };

  playBtn.addEventListener("click", togglePlaying);

  // The embeds are pointer-events:none, so that a click cannot land on YouTube's own
  // controls and take somebody off the page. That left the most obvious gesture on any
  // video, pressing the picture to stop it, doing nothing at all, which reads as a
  // broken player rather than as a demo with its own controls. The picture is a control
  // now: either one pauses the room, because there is only one room to pause.
  for (const pic of stage.querySelectorAll(".screen .pic")) {
    pic.addEventListener("click", togglePlaying);
  }

  soundBtn?.addEventListener("click", () => {
    if (!live) { goLive(); }
    const on = soundBtn.getAttribute("aria-pressed") !== "true";
    soundBtn.setAttribute("aria-pressed", String(on));
    soundBtn.textContent = on ? "Mute" : "Unmute";
    you.player?.setMuted(!on);
    say(on ? "Your audio only. Hers stays muted, so a call over the top still works."
           : "Muted again.");
  });

  const interrupt = (fn, message) => () => {
    if (!live) { goLive(); }
    fn();
    say(message);
  };

  stage.querySelector("[data-ad-one]").addEventListener("click", interrupt(
    () => them.interrupt("ad", AD_LENGTH),
    "Her advert, not yours. The film carries on and she rejoins where the room is.",
  ));

  stage.querySelector("[data-ad-both]").addEventListener("click", interrupt(
    () => { you.interrupt("ad", AD_LENGTH); them.interrupt("ad", AD_LENGTH); },
    "A mid-roll catches you both. Watch the clock: it holds, so nobody is thrown forward when it ends.",
  ));

  stage.querySelector("[data-buffer]").addEventListener("click", interrupt(
    () => them.interrupt("buffering", BUFFER_LENGTH),
    "Her connection stalls. You can see why, rather than watching her drift and guessing.",
  ));

  const loop = (now) => { room.tick(now); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);

}

/** Everything that is true of every page, demo or not. */
function page() {
  // The drawn demonstrations loop forever, so they run only while they are on screen.
  // A paused loop costs nothing; one running off screen is a compositor job for a
  // picture nobody is looking at.
  const minis = document.querySelectorAll(".mini, .wire");
  if (minis.length && "IntersectionObserver" in window) {
    const watcher = new IntersectionObserver(
      (entries) => {
        for (const e of entries) e.target.classList.toggle("is-onscreen", e.isIntersecting);
      },
      { rootMargin: "80px 0px" },
    );
    for (const m of minis) watcher.observe(m);
  } else {
    for (const m of minis) m.classList.add("is-onscreen");
  }

  // The sticky nav grows a hairline only once it is actually over content.
  const nav = document.querySelector("nav");
  const sentinel = document.querySelector("[data-top]");
  if (nav && sentinel && "IntersectionObserver" in window) {
    new IntersectionObserver(([e]) => nav.classList.toggle("stuck", !e.isIntersecting))
      .observe(sentinel);
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
