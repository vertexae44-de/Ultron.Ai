"use strict";
// The HUD strip above the orb: clock, battery, temperature and the nearest timer, each a small
// glowing ring gauge in Ultron's own red, in the spirit of a heads-up display.

const R = 34, C = 2 * Math.PI * R;   // ring geometry shared by every gauge

function gaugeSVG() {
  return `<svg viewBox="0 0 76 76"><circle class="track" cx="38" cy="38" r="${R}"/>
    <circle class="fill" cx="38" cy="38" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>`;
}

function makeGauge(id, label) {
  const g = el("div", { class: "gauge", id });
  g.append(
    el("div", { class: "ring-wrap" }, frag(gaugeSVG()), el("div", { class: "val" }, el("b"), el("small"))),
    el("span", { class: "lbl" }, label));
  return g;
}

function setGauge(g, frac, big, small) {
  const fill = g.querySelector(".fill");
  fill.style.strokeDashoffset = String(C * (1 - Math.max(0, Math.min(1, frac))));
  g.querySelector(".val b").textContent = big;
  g.querySelector(".val small").textContent = small || "";
}

const HUD = {
  clock: null, battery: null, temp: null, timer: null,

  init() {
    const row = $("hudRow");
    if (!row) return;
    row.append(
      this.clock = makeGauge("hudClock", "Time"),
      this.battery = makeGauge("hudBattery", "Battery"),
      this.temp = makeGauge("hudTemp", "Temp"),
      this.timer = makeGauge("hudTimer", "Timer"),
    );
    this.tickClock();
    setInterval(() => this.tickClock(), 1000);
    this.startBattery();
    this.startTemp();
    setInterval(() => this.tickTimer(), 500);
  },

  tickClock() {
    const d = new Date();
    setGauge(this.clock, (d.getSeconds() * 1000 + d.getMilliseconds()) / 60000,
      d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      d.toLocaleDateString([], { weekday: "short" }));
  },

  async startBattery() {
    if (!navigator.getBattery) { this.battery.hidden = true; return; }
    try {
      const b = await navigator.getBattery();
      const draw = () => {
        setGauge(this.battery, b.level, Math.round(b.level * 100) + "%", b.charging ? "charging" : "");
        this.battery.classList.toggle("charging", b.charging);
        this.battery.classList.toggle("low", !b.charging && b.level < 0.2);
        this.battery.classList.toggle("warn", !b.charging && b.level >= 0.2 && b.level < 0.4);
      };
      draw();
      b.addEventListener("levelchange", draw); b.addEventListener("chargingchange", draw);
    } catch { this.battery.hidden = true; }
  },

  async startTemp() {
    const units = Intl.DateTimeFormat().resolvedOptions().locale?.endsWith("-US") ? "imperial" : "metric";
    const load = (lat, lon) => {
      const q = lat != null ? `?lat=${lat}&lon=${lon}&units=${units}` : `?units=${units}`;
      fetch("/api/weather/home" + q).then(r => r.json()).then(d => {
        if (d.error) { this.temp.hidden = true; return; }
        const frac = (d.temperature - (units === "imperial" ? 20 : -5)) / (units === "imperial" ? 90 : 40);
        setGauge(this.temp, frac, `${Math.round(d.temperature)}°${d.unit}`, d.conditions);
      }).catch(() => { this.temp.hidden = true; });
    };
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => load(pos.coords.latitude, pos.coords.longitude),
        () => load(null, null),
        { timeout: 4000 },
      );
    } else load(null, null);
    this._tempRefresh = setInterval(() => load(this._lastLat, this._lastLon), 15 * 60 * 1000);
  },

  tickTimer() {
    const t = typeof nearestTimer === "function" ? nearestTimer() : null;
    if (!t) { setGauge(this.timer, 0, "—", "none"); return; }
    const left = Math.max(0, t.endsAt - Date.now());
    setGauge(this.timer, left / (t.total * 1000), fmtRemaining(left), t.label || "running");
  },
};

HUD.init();
