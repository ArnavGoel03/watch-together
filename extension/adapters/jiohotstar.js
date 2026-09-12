// JioHotstar adapter - handles jiohotstar.com and hotstar.com video player
(function () {
  window.__watchTogetherAdapters = window.__watchTogetherAdapters || {};

  window.__watchTogetherAdapters.jiohotstar = {
    name: "jiohotstar",

    /** @returns {HTMLVideoElement|null} */
    findVideo() {
      // JioHotstar uses a standard HTML5 video element inside their player container
      // Try specific selectors first, then fall back to generic
      const selectors = [
        'video[src]',
        '.shaka-video-container video',
        '.player-base video',
        '.content-player video',
        'video',
      ];

      for (const sel of selectors) {
        const video = /** @type {HTMLVideoElement|null} */ (document.querySelector(sel));
        if (video) return video;
      }
      return null;
    },

  };
})();
