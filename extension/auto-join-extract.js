// Capture in the background so an invitation belongs to one browser tab, including
// across a provider login redirect. Page scripts cannot impersonate sender.tab.
(function () {
  try {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("wt_room");
    if (code) {
      const url = new URL(window.location.href);
      url.searchParams.delete("wt_room");
      url.searchParams.delete("wt_invite");
      url.searchParams.delete("wt_relay");
      chrome.runtime.sendMessage({
        type: "capture-invite", roomCode: code.toUpperCase(),
        inviteToken: params.get("wt_invite"), relayUrl: params.get("wt_relay"),
        url: url.toString(),
      }, () => { void chrome.runtime.lastError; });
      window.history.replaceState(window.history.state, "", url.toString());
    }
  } catch {}
})();
