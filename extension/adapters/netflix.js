// Netflix adapter - handles netflix.com video player
(function () {
  window.__watchTogetherAdapters = window.__watchTogetherAdapters || {};

  window.__watchTogetherAdapters.netflix = {
    name: "netflix",

    findVideo() {
      // Netflix uses a single video element inside their player
      return (
        /** @type {HTMLVideoElement|null} */ (document.querySelector('.watch-video--player-view video')) ||
        /** @type {HTMLVideoElement|null} */ (document.querySelector('video'))
      );
    },

  };
})();
