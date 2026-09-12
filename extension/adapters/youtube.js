// YouTube adapter - handles youtube.com video player
(function () {
  window.__watchTogetherAdapters = window.__watchTogetherAdapters || {};

  window.__watchTogetherAdapters.youtube = {
    name: "youtube",

    findVideo() {
      // YouTube main player video
      return (
        /** @type {HTMLVideoElement|null} */ (document.querySelector('#movie_player video')) ||
        /** @type {HTMLVideoElement|null} */ (document.querySelector('video.html5-main-video')) ||
        /** @type {HTMLVideoElement|null} */ (document.querySelector('video'))
      );
    },

  };
})();
