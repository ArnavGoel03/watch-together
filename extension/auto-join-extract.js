// Runs at document_start — extracts wt_room param before page JS can strip it
// This is the FIRST thing that runs, before YouTube/Netflix/etc. JS loads
(function () {
  try {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("wt_room");
    if (code) {
      // Store globally for content.js to pick up
      window.__wtAutoJoinCode = code.toUpperCase();
      // Also store in sessionStorage as backup (survives if window prop is overwritten)
      sessionStorage.setItem("__wt_autojoin", code.toUpperCase());
      // Clean URL so YouTube doesn't see the unknown param
      const url = new URL(window.location.href);
      url.searchParams.delete("wt_room");
      window.history.replaceState({}, "", url.toString());
      console.log("[WatchTogether] Auto-join code extracted:", code.toUpperCase());
    }
  } catch {
    // Silently fail on restricted pages
  }
})();
