// Generic adapter — works with any HTML5 video element
(function () {
  window.__watchTogetherAdapters = window.__watchTogetherAdapters || {};

  window.__watchTogetherAdapters.generic = {
    name: "generic",

    findVideo() {
      const videos = Array.from(document.querySelectorAll("video"));
      if (videos.length === 0) return null;
      if (videos.length === 1) return videos[0];
      return videos.reduce((best, v) => {
        const area = v.clientWidth * v.clientHeight;
        const bestArea = best.clientWidth * best.clientHeight;
        return area > bestArea ? v : best;
      });
    },

    applyState(video, state) {
      const DRIFT = 0.5;
      if (Math.abs(video.currentTime - state.currentTime) > DRIFT) {
        video.currentTime = state.currentTime;
      }
      if (state.playbackRate && video.playbackRate !== state.playbackRate) {
        video.playbackRate = state.playbackRate;
      }
      if (state.playing && video.paused) {
        video.play().catch(() => {});
      } else if (!state.playing && !video.paused) {
        video.pause();
      }
    },
  };
})();
