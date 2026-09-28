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
  player: null, ready: null, query: "",

  // The player itself, created once and reused.
  ensurePlayer() {
    if (this.ready) return this.ready;
    this.ready = loadYouTubeApi().then(() => new Promise((resolve) => {
      this.player = new YT.Player("ytFrame", {
        host: "https://www.youtube-nocookie.com",
        playerVars: { autoplay: 1, playsinline: 1, rel: 0 },
        events: {
          onReady: () => resolve(this.player),
          onStateChange: () => {
            const data = this.player.getVideoData?.();
            if (data?.title) $("ytTitle").textContent = data.title;
          },
          // 101/150: the uploader doesn't allow embedding -- move on to the next result.
          onError: (e) => {
            if ([101, 150, 100].includes(e.data) && this.player.getPlaylistIndex?.() < (this.player.getPlaylist?.()?.length || 0) - 1) this.player.nextVideo();
            else $("ytTitle").textContent = `Couldn't play "${this.query}" here.`;
          },
        },
      });
    }));
    return this.ready;
  },

  // "Play <song/video>" or "open <name> channel": look it up on YouTube (via the server), then play.
  async play(query) {
    query = (query || "").trim();
    if (!query) return "Watch what?";
    this.query = query;
    $("ytView").hidden = false;
    $("ytTitle").textContent = `Finding "${query}" on YouTube…`;
    document.body.classList.add("yt-open");
    try {
      const [found, player] = await Promise.all([
        fetch("/api/youtube?q=" + encodeURIComponent(query)).then(r => r.json()),
        this.ensurePlayer(),
      ]);
      if (found.error) { $("ytTitle").textContent = found.error; return found.error; }
      $("ytTitle").textContent = found.title;
      if (found.kind === "channel") player.loadPlaylist({ listType: "playlist", list: found.playlist });
      else player.loadPlaylist(found.ids);
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
