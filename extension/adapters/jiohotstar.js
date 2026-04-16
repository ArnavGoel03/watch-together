// JioHotstar adapter — handles jiohotstar.com and hotstar.com video player
(function () {
  window.__watchTogetherAdapters = window.__watchTogetherAdapters || {};

  window.__watchTogetherAdapters.jiohotstar = {
    name: "jiohotstar",

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
        const video = document.querySelector(sel);
        if (video) return video;
      }
      return null;
    },

    applyState(video, state) {
      const DRIFT = 0.5;

      // JioHotstar sometimes has ads — only sync if the video duration suggests real content
      if (video.duration && video.duration < 30) {
        // Likely an ad, skip sync
        return;
      }

      if (Math.abs(video.currentTime - state.currentTime) > DRIFT) {
        video.currentTime = state.currentTime;
      }
      if (state.playbackRate && video.playbackRate !== state.playbackRate) {
        video.playbackRate = state.playbackRate;
      }
      if (state.playing && video.paused) {
        video.play().catch(() => {});
        // Also try clicking the play button if programmatic play fails
        setTimeout(() => {
          if (video.paused) {
            const playBtn = document.querySelector(
              '[class*="play-btn"], [aria-label*="Play"], [data-testid*="play"]'
            );
            if (playBtn) playBtn.click();
          }
        }, 200);
      } else if (!state.playing && !video.paused) {
        video.pause();
      }
    },
  };
})();
