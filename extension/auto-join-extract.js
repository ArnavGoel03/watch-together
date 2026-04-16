// Runs at document_start — extracts wt_room and stores in chrome.storage.local
// chrome.storage.local is extension-private, no website can touch it
(function () {
  try {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("wt_room");
    if (code) {
      // Store in chrome.storage — 100% reliable, no race conditions
      chrome.storage.local.set({
        pendingJoin: {
          roomCode: code.toUpperCase(),
          url: window.location.href,
          timestamp: Date.now(),
        },
      });
      // Clean URL
      const url = new URL(window.location.href);
      url.searchParams.delete("wt_room");
      window.history.replaceState({}, "", url.toString());
    }
  } catch {}
})();
