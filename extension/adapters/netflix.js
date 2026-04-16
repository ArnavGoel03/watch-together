// Netflix adapter — handles netflix.com video player
(function () {
  window.__watchTogetherAdapters = window.__watchTogetherAdapters || {};

  window.__watchTogetherAdapters.netflix = {
    name: "netflix",

    findVideo() {
      // Netflix uses a single video element inside their player
      return (
        document.querySelector('.watch-video--player-view video') ||
        document.querySelector('video')
      );
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
        // Netflix sometimes needs a click on their custom button
        setTimeout(() => {
          if (video.paused) {
            const playBtn = document.querySelector(
              '[data-uia="control-play-pause-play"], .button-nfplayerPlay, [aria-label="Play"]'
            );
            if (playBtn) playBtn.click();
          }
        }, 200);
      } else if (!state.playing && !video.paused) {
        video.pause();
        setTimeout(() => {
          if (!video.paused) {
            const pauseBtn = document.querySelector(
              '[data-uia="control-play-pause-pause"], .button-nfplayerPause, [aria-label="Pause"]'
            );
            if (pauseBtn) pauseBtn.click();
          }
        }, 200);
      }
    },
  };
})();
