// Generic adapter - works with any HTML5 video element
(function () {
  window.__watchTogetherAdapters = window.__watchTogetherAdapters || {};

  window.__watchTogetherAdapters.generic = {
    name: "generic",

    findVideo() {
      const videos = Array.from(document.querySelectorAll("video"));
      if (videos.length === 0) return null;
      if (videos.length === 1) return videos[0];
      const real = videos.filter((v) => !(v.offsetParent === null && v.clientHeight === 0)
        && !(v.muted && (v.autoplay || v.loop) && !v.controls));
      return (real.length ? real : videos).reduce((best, v) => {
        const area = v.clientWidth * v.clientHeight;
        const bestArea = best.clientWidth * best.clientHeight;
        return area > bestArea ? v : best;
      });
    },

  };
})();
