"use strict";
// The sidebar media player: pick a local audio or video file and it plays right there, with a
// small reactive visualizer. Nothing is uploaded -- the file never leaves the browser.

const MPlayer = {
  audio: null, analyser: null, buf: null, raf: null,
  playlist: [], index: -1,

  init() {
    this.audio = new Audio();
    this.audio.addEventListener("timeupdate", () => this.tick());
    this.audio.addEventListener("loadedmetadata", () => this.tick());
    this.audio.addEventListener("ended", () => this.next());
    this.audio.addEventListener("play", () => this.setIcon(true));
    this.audio.addEventListener("pause", () => this.setIcon(false));

    $("mpLoadBtn").addEventListener("click", () => $("mpFile").click());
    $("mpFile").addEventListener("change", (e) => this.load([...e.target.files]));
    $("mpPlay").addEventListener("click", () => this.toggle());
    $("mpVol").addEventListener("input", (e) => { this.audio.volume = e.target.value; });
    $("mpSeek").addEventListener("input", (e) => {
      if (this.audio.duration) this.audio.currentTime = (e.target.value / 1000) * this.audio.duration;
    });
    this.resizeCanvas();
    addEventListener("resize", () => this.resizeCanvas());
    this.draw();
  },

  load(files) {
    if (!files.length) return;
    this.playlist = files;
    this.play(0);
  },

  play(i) {
    if (i < 0 || i >= this.playlist.length) return;
    this.index = i;
    const f = this.playlist[i];
    this.audio.src = URL.createObjectURL(f);
    $("mpTitle").textContent = f.name.replace(/\.[a-z0-9]+$/i, "");
    this.ensureAnalyser();
    this.audio.play().catch(() => {});
  },

  next() { if (this.playlist.length > 1) this.play((this.index + 1) % this.playlist.length); },

  toggle() {
    if (!this.audio.src) { $("mpFile").click(); return; }
    if (this.audio.paused) { getAudioCtx(); this.audio.play().catch(() => {}); } else this.audio.pause();
  },

  setIcon(playing) {
    $("mpPlay").title = playing ? "Pause" : "Play";
    $("mpPlay").innerHTML = playing
      ? '<svg class="i" viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>'
      : '<svg class="i" viewBox="0 0 24 24"><path d="M7 5v14l11-7z"/></svg>';
  },

  ensureAnalyser() {
    if (this.analyser) return;
    try {
      const ac = getAudioCtx();
      const src = ac.createMediaElementSource(this.audio);
      this.analyser = ac.createAnalyser();
      this.analyser.fftSize = 64;
      this.buf = new Uint8Array(this.analyser.frequencyBinCount);
      src.connect(this.analyser); this.analyser.connect(ac.destination);
    } catch { /* a second source on the same element throws; ignore */ }
  },

  tick() {
    const a = this.audio;
    const say = (s) => { const s2 = Math.floor(s || 0); return `${Math.floor(s2 / 60)}:${String(s2 % 60).padStart(2, "0")}`; };
    $("mpCur").textContent = say(a.currentTime);
    $("mpDur").textContent = say(a.duration);
    if (a.duration) $("mpSeek").value = String((a.currentTime / a.duration) * 1000);
  },

  resizeCanvas() {
    const c = $("mpVis");
    c.width = c.clientWidth * (devicePixelRatio || 1);
    c.height = c.clientHeight * (devicePixelRatio || 1);
  },

  draw() {
    this.raf = requestAnimationFrame(() => this.draw());
    const c = $("mpVis"), g = c.getContext("2d");
    g.clearRect(0, 0, c.width, c.height);
    const n = 24, gap = c.width / n;
    let levels;
    if (this.analyser && !this.audio.paused) {
      this.analyser.getByteFrequencyData(this.buf);
      const step = Math.floor(this.buf.length / n) || 1;
      levels = Array.from({ length: n }, (_, i) => this.buf[i * step] / 255);
    } else {
      levels = Array.from({ length: n }, () => 0.04);
    }
    g.fillStyle = "#ff2b36";
    levels.forEach((v, i) => {
      const h = Math.max(2, v * c.height);
      g.globalAlpha = 0.35 + v * 0.65;
      g.fillRect(i * gap + gap * 0.2, c.height - h, gap * 0.6, h);
    });
    g.globalAlpha = 1;
  },
};

MPlayer.init();
