// Runs at document_start — extracts wt_room param before page JS can strip it
(function () {
  try {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("wt_room");
    if (code) {
      window.__wtAutoJoinCode = code.toUpperCase();
      // Clean URL immediately
      const url = new URL(window.location.href);
      url.searchParams.delete("wt_room");
      window.history.replaceState({}, "", url.toString());
    }
  } catch {
    // Silently fail on restricted pages
  }
})();
