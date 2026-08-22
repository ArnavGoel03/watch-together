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

    applyState(video, state) {
      const DRIFT = 0.5;

      // Skip if it's an ad. The list is config's, not this file's: it used to hold two
      // of the ten markers, so anything added for YouTube elsewhere did not exist here.
      const markers = window.__wtConfig?.AD_SELECTORS || [];
      if (markers.some((sel) => document.querySelector(sel))) return;

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
