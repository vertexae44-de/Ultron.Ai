"use strict";
// The JARVIS-style dashboard around the orb: real time, battery, temperature, location and timer
// data where the browser can genuinely see it, plus a live Active Processes / Data Stream feed
// tied to what Ultron is actually doing. A few panels (system load, processing, network traffic,
// the network map) are stylised motion -- no web page can read a device's real CPU/GPU load or
// its network topology -- but everything else here is real.

const R = 34, C = 2 * Math.PI * R;          // big ring gauges (battery, timer)
const R2 = 26, C2 = 2 * Math.PI * R2;       // the smaller "system load" ring

function setRing(fillEl, frac, dash = C) {
  if (!fillEl) return;
  fillEl.style.strokeDasharray = String(dash);
  fillEl.style.strokeDashoffset = String(dash * (1 - Math.max(0, Math.min(1, frac))));
}

const HUD = {
  timers: [],

  init() {
    if (!$("jarvis")) return;
    this.tickClock(); setInterval(() => this.tickClock(), 1000);
    this.startBattery();
    this.startTemp();
    this.startLocation();
    setInterval(() => this.tickTimer(), 500);
    this.buildStatus(); setInterval(() => this.buildStatus(), 4000);
    this.buildQuick();
    this.buildProfile(); document.addEventListener("ultron:user", () => this.buildProfile());
    this.startProcs(); setInterval(() => this.tickProcs(), 800);
    this.startStream();
    this.startNetMap();
    this.startSim();
  },

  log(line) {
    const ul = $("jStream"); if (!ul) return;
    const t = new Date().toLocaleTimeString([], { hour12: false });
    const li = el("li", {}, el("b", {}, "[" + t + "] "), document.createTextNode(line));
    ul.prepend(li);
    while (ul.children.length > 14) ul.lastChild.remove();
  },

  // ---------- clock ----------
  tickClock() {
    const d = new Date();
    if ($("jTime")) $("jTime").textContent = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    if ($("jDate")) $("jDate").textContent = d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  },

  // ---------- battery ----------
  async startBattery() {
    if (!navigator.getBattery) return;
    try {
      const b = await navigator.getBattery();
      const draw = () => {
        const pct = Math.round(b.level * 100);
        if ($("jBattPct")) $("jBattPct").textContent = pct + "%";
        setRing($("jBattRing"), b.level, C);
        const bars = $("jBattBars");
        if (bars) {
          bars.innerHTML = "";
          for (let i = 0; i < 5; i++) bars.append(el("i", { class: (i < Math.round(b.level * 5)) ? "on" : "" }));
        }
        if ($("jBattState")) $("jBattState").textContent = b.charging ? "charging" : "on battery";
        $("jarvis")?.querySelector(".j-battery")?.classList.toggle("charging", b.charging);
        const secs = b.charging ? b.chargingTime : b.dischargingTime;
        if ($("jBattTime")) $("jBattTime").textContent = (secs && isFinite(secs) && secs > 0)
          ? `${Math.floor(secs / 3600)}h ${Math.round((secs % 3600) / 60)}m` : (b.charging ? "full soon" : "--");
        this._lastCharging ??= b.charging;
        if (this._lastCharging !== b.charging) { this.log(b.charging ? "External power connected." : "Running on battery."); this._lastCharging = b.charging; }
      };
      draw();
      b.addEventListener("levelchange", draw); b.addEventListener("chargingchange", draw);
    } catch {}
  },

  // ---------- temperature (reused for the "core temp" mini panel) ----------
  async startTemp() {
    const units = Intl.DateTimeFormat().resolvedOptions().locale?.endsWith("-US") ? "imperial" : "metric";
    const load = (lat, lon) => {
      this._lastLat = lat; this._lastLon = lon;
      const q = lat != null ? `?lat=${lat}&lon=${lon}&units=${units}` : `?units=${units}`;
      fetch("/api/weather/home" + q).then(r => r.json()).then(d => {
        if (d.error) return;
        if ($("jTemp")) $("jTemp").textContent = `${Math.round(d.temperature)}°${d.unit}`;
        if ($("jTempCond")) $("jTempCond").textContent = d.conditions || "--";
      }).catch(() => {});
    };
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => load(pos.coords.latitude, pos.coords.longitude),
        () => load(null, null), { timeout: 4000 });
    } else load(null, null);
    setInterval(() => load(this._lastLat, this._lastLon), 15 * 60 * 1000);
  },

  // ---------- location ----------
  startLocation() {
    if (!$("jLocName")) return;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const city = tz.split("/").pop()?.replace(/_/g, " ") || "Unknown";
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((pos) => {
        $("jLocName").textContent = city;
        $("jLocCoord").textContent = `${pos.coords.latitude.toFixed(3)}°, ${pos.coords.longitude.toFixed(3)}°`;
        this.log(`Location fixed near ${city}.`);
      }, () => { $("jLocName").textContent = city; $("jLocCoord").textContent = tz; }, { timeout: 5000 });
    } else { $("jLocName").textContent = city; $("jLocCoord").textContent = tz; }
  },

  // ---------- timer ----------
  tickTimer() {
    const t = typeof nearestTimer === "function" ? nearestTimer() : null;
    const ring = $("jTimerRing");
    if (!t) {
      if ($("jTimerVal")) $("jTimerVal").textContent = "--:--";
      if ($("jTimerSub")) $("jTimerSub").textContent = "idle";
      if ($("jTimerLabel")) $("jTimerLabel").textContent = "No timer running";
      setRing(ring, 0, C);
      $("jarvis")?.querySelector(".j-timer")?.classList.remove("active");
      return;
    }
    const left = Math.max(0, t.endsAt - Date.now());
    if ($("jTimerVal")) $("jTimerVal").textContent = fmtRemaining(left);
    if ($("jTimerSub")) $("jTimerSub").textContent = "left";
    if ($("jTimerLabel")) $("jTimerLabel").textContent = t.label || "Timer running";
    setRing(ring, left / (t.total * 1000), C);
    $("jarvis")?.querySelector(".j-timer")?.classList.add("active");
  },

  // ---------- system status (real, browser-observable signals) ----------
  buildStatus() {
    const ul = $("jStatus"); if (!ul) return;
    const rows = [
      ["Network", navigator.onLine ? "online" : "offline", !navigator.onLine],
      ["Voice Recognition", ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) ? "ready" : "unavailable", !("webkitSpeechRecognition" in window || "SpeechRecognition" in window)],
      ["Camera Access", (typeof Gesture !== "undefined" && Gesture.running) ? "active" : "standby", false],
      ["Account", (typeof App !== "undefined" && App.user) ? "signed in" : "guest", false],
    ];
    ul.innerHTML = "";
    for (const [label, val, warn] of rows) ul.append(el("li", { class: warn ? "warn" : "" }, el("span", {}, label), el("span", {}, val)));
  },

  // ---------- active processes (real app state) ----------
  startProcs() {
    addEventListener("online", () => this.buildStatus());
    addEventListener("offline", () => this.buildStatus());
  },
  tickProcs() {
    const ul = $("jProcs"); if (!ul) return;
    const m = typeof mode !== "undefined" ? mode : "idle";
    const playing = (typeof MPlayer !== "undefined" && MPlayer.audio && !MPlayer.audio.paused)
      || (typeof YouTube !== "undefined" && YouTube.player && typeof YouTube.player.getPlayerState === "function" && YouTube.player.getPlayerState() === 1);
    const rows = [
      ["Voice Recognition", m === "listening"],
      ["Natural Language Processing", m === "thinking"],
      ["Speech Synthesis", m === "speaking"],
      ["Visual Analysis", typeof Gesture !== "undefined" && Gesture.running],
      ["Media Playback", !!playing],
    ];
    const prevKey = this._procKey; const key = rows.map(r => r[1] ? 1 : 0).join("");
    ul.innerHTML = "";
    for (const [label, active] of rows) ul.append(el("li", { class: active ? "active" : "", "data-state": active ? "RUNNING" : "IDLE" }, el("i"), el("span", {}, label)));
    if (prevKey !== undefined && prevKey !== key) {
      rows.forEach((r, i) => { if (r[1] && prevKey[i] !== "1") this.log(`${r[0]} started.`); });
    }
    this._procKey = key;
  },

  // ---------- data stream ----------
  startStream() {
    this.log("Ultron dashboard initialized.");
    document.addEventListener("ultron:tool", (e) => this.log(`Ran ${e.detail?.name || "a tool"}.`));
  },

  // ---------- user profile ----------
  buildProfile() {
    const u = typeof App !== "undefined" ? App.user : null;
    if ($("jAvatar")) $("jAvatar").textContent = u ? (u.username || u.name || "?")[0].toUpperCase() : "?";
    if ($("jUserName")) $("jUserName").textContent = u ? (u.name || u.username) : "Guest";
    if ($("jUserRole")) $("jUserRole").textContent = u ? `@${u.username}` : "Not signed in";
    const btn = $("jAuthBtn");
    if (btn) { btn.dataset.act = u ? "logout" : "login"; btn.title = u ? "Log out" : "Log in"; }
    if ($("jAuthLabel")) $("jAuthLabel").textContent = u ? "Log out" : "Log in";
    if ($("jAccess")) $("jAccess").textContent = u ? "MEMBER · FULL" : "GUEST";
  },

  // ---------- quick access ----------
  buildQuick() {
    const box = $("jQuick"); if (!box) return;
    const tiles = [
      ["generate", "image", "Generate"],
      ["code", "code", "Code"],
      ["hologram", "hologram", "Hologram"],
      ["media", "voice", "Player"],
      ["files", "file", "Files"],
      ["settings", "model", "Settings"],
    ];
    box.innerHTML = "";
    for (const [act, ic, label] of tiles) box.append(el("button", { type: "button", "data-act": act },
      frag(icon(ic)), el("span", {}, label)));
  },

  // ---------- global network canvas (a stylised map -- browsers can't see real network topology) ----------
  startNetMap() {
    const cv = $("jNetMap"); if (!cv) return;
    const ctx = cv.getContext("2d");
    const pts = Array.from({ length: 9 }, () => ({ x: Math.random() * cv.width, y: Math.random() * cv.height, p: Math.random() * Math.PI * 2 }));
    const frame = () => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.strokeStyle = "rgba(255,40,55,.25)"; ctx.lineWidth = 1;
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
        if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < 55) {
          ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); ctx.stroke();
        }
      }
      for (const p of pts) {
        p.p += 0.03;
        const r = 1.6 + Math.sin(p.p) * 1;
        ctx.fillStyle = "rgba(255,60,70,.9)";
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill();
      }
      requestAnimationFrame(frame);
    };
    frame();
    const tickNums = () => {
      if ($("jConns")) $("jConns").textContent = `${380 + Math.floor(Math.random() * 12)} ONLINE`;
      const start = performance.now();
      fetch("/api/config").then(() => { if ($("jLatency")) $("jLatency").textContent = `${(performance.now() - start).toFixed(0)} MS`; }).catch(() => {});
    };
    tickNums(); setInterval(tickNums, 6000);
  },

  // ---------- stylised load / processing / traffic (no real telemetry available in-browser) ----------
  startSim() {
    let load = 30, up = 40, down = 70;
    const procs = [{ n: "CPU", v: 30 }, { n: "GPU", v: 20 }, { n: "MEM", v: 45 }, { n: "NEURAL NET", v: 60 }];
    const wave = (cv, seed) => {
      if (!cv) return null;
      const ctx = cv.getContext("2d"); let t = seed;
      return () => {
        t += 0.15;
        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.strokeStyle = "var(--red)".includes("var") ? "#ff1f2d" : "#ff1f2d";
        ctx.lineWidth = 1.5; ctx.beginPath();
        for (let x = 0; x <= cv.width; x += 4) {
          const y = cv.height / 2 + Math.sin(x * 0.15 + t) * (cv.height / 2 - 4) * (0.4 + 0.3 * Math.sin(t * 0.4));
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      };
    };
    const drawProc = wave($("jProcWave"), 0), drawTraffic = wave($("jTrafficWave"), 2);
    const step = () => {
      load += (Math.random() - 0.5) * 8; load = Math.max(8, Math.min(92, load));
      setRing($("jLoadRing"), load / 100, C2);
      if ($("jLoadPct")) $("jLoadPct").textContent = Math.round(load) + "%";
      up += (Math.random() - 0.5) * 6; up = Math.max(2, Math.min(180, up));
      down += (Math.random() - 0.5) * 10; down = Math.max(4, Math.min(480, down));
      if ($("jUp")) $("jUp").textContent = `↑ ${up.toFixed(1)} KB/s`;
      if ($("jDown")) $("jDown").textContent = `↓ ${down.toFixed(1)} KB/s`;
      const list = $("jProcList");
      if (list) {
        list.innerHTML = "";
        procs.forEach(p => { p.v = Math.max(4, Math.min(98, p.v + (Math.random() - 0.5) * 6)); list.append(el("li", {}, el("span", {}, p.n), el("span", {}, Math.round(p.v) + "%"))); });
      }
      drawProc?.(); drawTraffic?.();
      requestAnimationFrame(step);
    };
    step();
  },
};

HUD.init();
