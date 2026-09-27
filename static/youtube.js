"use strict";
// "Play <something> on YouTube": an embedded, voice-controllable YouTube player inside Ultron
// itself (the official IFrame Player API -- no API key needed). This plays on THIS device, in
// this browser tab. A website has no way to reach out and control a separate physical phone;
// that would need a companion app running on the phone. See README for the honest version of
// this limit.

let ytApiPromise = null;
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = resolve;
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
  return ytApiPromise;
}

const YouTube = {
  player: null, query: "",

  async play(query) {
    query = (query || "").trim();
    if (!query) return "Watch what?";
    this.query = query;
    $("ytView").hidden = false;
    $("ytTitle").textContent = `Searching YouTube for "${query}"…`;
    document.body.classList.add("yt-open");
    try {
      await loadYouTubeApi();
      if (this.player) { this.player.loadPlaylist({ listType: "search", list: query }); }
      else {
        this.player = new YT.Player("ytFrame", {
          host: "https://www.youtube-nocookie.com",
          playerVars: { listType: "search", list: query, autoplay: 1, playsinline: 1 },
          events: {
            onReady: () => this.player.playVideo(),
            onStateChange: (e) => {
              const data = this.player.getVideoData?.();
              if (data?.title) $("ytTitle").textContent = data.title;
            },
            onError: () => { $("ytTitle").textContent = `Couldn't play "${query}" on YouTube.`; },
          },
        });
      }
    } catch (err) {
      this.close();
      return "YouTube didn't load -- check your connection.";
    }
    return "";
  },

  pause() { this.player?.pauseVideo(); },
  resume() { this.player?.playVideo(); },
  next() { this.player?.nextVideo(); },
  setVolume(v) { this.player?.setVolume(Math.round(clampYT(v, 0, 1) * 100)); },

  close() {
    $("ytView").hidden = true;
    document.body.classList.remove("yt-open");
    try { this.player?.pauseVideo(); } catch {}
  },
};

const clampYT = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

$("closeYT")?.addEventListener("click", () => YouTube.close());
