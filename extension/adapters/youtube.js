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

      // Skip if it's an ad
      const adPlaying = document.querySelector('.ad-showing, .ytp-ad-player-overlay');
      if (adPlaying) return;

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
