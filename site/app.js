// The hero demo.
//
// The most persuasive thing this page can do is not describe synchronised playback, it is
// BE synchronised playback: two players driven by one shared clock, which the visitor can
// scrub, pause and interrupt. Everything below is the real behaviour of the extension,
// modelled honestly rather than faked with a video of a video.
//
// Deliberately no framework and no WebGL. The whole demo is a shared clock and two DOM
// elements reading from it, which is both cheaper than a canvas and a truer picture of
// what the product actually does.

const DURATION = 214; // seconds of imaginary film
const AD_LENGTH = 8;

const fmt = (t) => {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

class Room {
  constructor() {
    this.position = 34;      // where the film is, for everybody
    this.playing = true;
    this.members = [];
    this.last = performance.now();
    this.onchange = () => {};
  }

  add(member) { this.members.push(member); return member; }

  /** True when nobody can currently see the film, which is when the clock must hold. */
  get dark() { return this.members.length > 0 && this.members.every((m) => m.state !== "watching"); }

  tick(now) {
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;

    for (const m of this.members) m.tick(dt);

    // The rule the whole product turns on: with nobody watching, the film does not advance.
    // Without this an ad break that catches everyone convinces the room that time passed,
    // and everybody is thrown that far forward when they come back.
    if (this.playing && !this.dark) {
      this.position = Math.min(DURATION, this.position + dt);
      if (this.position >= DURATION) this.position = 0;
    }
    this.onchange();
  }

  seek(t) {
    this.position = Math.max(0, Math.min(DURATION, t));
    this.onchange();
  }

  toggle() { this.playing = !this.playing; this.onchange(); }
}

class Member {
  constructor(room, el, name) {
    this.room = room;
    this.el = el;
    this.name = name;
    this.state = "watching";   // watching | ad | buffering
    this.remaining = 0;
    room.add(this);
  }

  interrupt(kind, seconds) {
    this.state = kind;
    this.remaining = seconds;
  }

  tick(dt) {
    if (this.state === "watching") return;
    this.remaining -= dt;
    if (this.remaining <= 0) {
      this.state = "watching";
      this.remaining = 0;
    }
  }

  render(position, playing, roomDark) {
    const el = this.el;
    el.classList.toggle("is-ad", this.state === "ad");

    const dot = el.querySelector(".dot");
    dot.className = "dot" + (this.state === "ad" ? " ad" : this.state === "buffering" ? " buf" : "");

    const label =
      this.state === "ad" ? `ad break ${Math.ceil(this.remaining)}s`
      : this.state === "buffering" ? "buffering"
      : roomDark ? "holding"
      : playing ? "watching" : "paused";
    el.querySelector(".screen-state").textContent = label;

    const pct = (position / DURATION) * 100;
    el.querySelector(".fill").style.width = pct + "%";
    el.querySelector(".head").style.left = pct + "%";
    el.querySelector(".time").textContent = fmt(position);
    // The picture drifts with the playhead, so the two screens visibly show the same frame.
    el.querySelector(".band").style.setProperty("--shift", (-position * 0.28) + "%");
  }
}

function start() {
  const stage = document.querySelector("[data-demo]");
  if (!stage) return;

  const room = new Room();
  const you = new Member(room, stage.querySelector('[data-screen="you"]'), "You");
  const them = new Member(room, stage.querySelector('[data-screen="them"]'), "Priya");
  const hint = stage.querySelector("[data-hint]");
  const playBtn = stage.querySelector("[data-play]");

  const say = (text) => { hint.textContent = text; };

  room.onchange = () => {
    const dark = room.dark;
    you.render(room.position, room.playing, dark);
    them.render(room.position, room.playing, dark);
    playBtn.textContent = room.playing ? "Pause" : "Play";
  };

  // Scrubbing either track moves the room, because in the real thing anyone can drive.
  for (const track of stage.querySelectorAll(".track")) {
    const seekFrom = (e) => {
      const r = track.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      room.seek((Math.max(0, Math.min(1, x / r.width))) * DURATION);
    };
    let dragging = false;
    track.addEventListener("pointerdown", (e) => { dragging = true; track.setPointerCapture(e.pointerId); seekFrom(e); say("Either of you can scrub. The room follows whoever moved."); });
    track.addEventListener("pointermove", (e) => { if (dragging) seekFrom(e); });
    track.addEventListener("pointerup", () => { dragging = false; });
    track.addEventListener("pointercancel", () => { dragging = false; });
  }

  playBtn.addEventListener("click", () => {
    room.toggle();
    say(room.playing ? "Playing, for both of you." : "Paused, for both of you.");
  });

  stage.querySelector("[data-ad-one]").addEventListener("click", () => {
    them.interrupt("ad", AD_LENGTH);
    say("Her advert, not yours. The film carries on and she rejoins where the room is.");
  });

  stage.querySelector("[data-ad-both]").addEventListener("click", () => {
    you.interrupt("ad", AD_LENGTH);
    them.interrupt("ad", AD_LENGTH);
    say("A mid-roll catches you both. Watch the clock: it holds, so nobody is thrown forward when it ends.");
  });

  stage.querySelector("[data-buffer]").addEventListener("click", () => {
    them.interrupt("buffering", 5);
    say("Her connection stalls. You can see why, rather than watching her drift and guessing.");
  });

  const loop = (now) => { room.tick(now); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);

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
