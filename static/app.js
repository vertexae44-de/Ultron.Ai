"use strict";
// Ultron core: config, the orb, voice in/out, moods, timers, and sending turns.
// Other scripts (code.js, composer.js, chats.js, account.js) add panels on top.

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
  return e;
}
const store = {                                  // per-browser preferences; storage may be blocked
  get(k, d = null) { try { const v = localStorage.getItem("ultron." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("ultron." + k, JSON.stringify(v)); } catch {} },
};
let toastTimer = null;
function toast(msg, ms = 3200) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
const Modal = {
  onclose: null,
  open(box, onclose = null) {
    const m = $("modal");
    this.close(true);
    this.prevFocus = document.activeElement;
    this.onclose = onclose;
    m.replaceChildren(box); m.hidden = false;
    (box.querySelector("[autofocus]") || box.querySelector("input, button"))?.focus();
  },
  close(silent = false) {
    const m = $("modal");
    if (m.hidden) return;
    m.hidden = true; m.replaceChildren();
    const f = this.onclose; this.onclose = null;
    if (f && !silent) f();
    this.prevFocus?.focus?.();
  },
  get isOpen() { return !$("modal").hidden; },
};
$("modal").addEventListener("pointerdown", (e) => { if (e.target === $("modal")) Modal.close(); });

// ---------- config (who's here, what they may do) ----------
const App = {
  config: null, user: null,
  perms: { plan: "guest", max_effort: "medium", attachments: false, images: false, image_limit: 0, saved_chats: false, models: "default" },
  handlers: [],
};
function onConfig(fn) { App.handlers.push(fn); if (App.config) fn(App.config); }
async function loadConfig() {
  try {
    const c = await (await fetch("/api/config", { cache: "no-store" })).json();
    App.config = c; App.user = c.user; App.perms = c.perms;
    useKokoro = c.tts === "kokoro";
    for (const f of App.handlers) f(c);
  } catch { toast("Can't reach the Ultron server.", 6000); }
}
addEventListener("DOMContentLoaded", loadConfig);

// ---------- state ----------
let mode = "idle";             // idle | listening | thinking | speaking
let micLevel = 0;              // 0..1 from the mic analyser
let speakPulse = 0;            // how hard the orb pulses while speaking
let abortCtl = null;
let flare = 0;                 // brief burst (wake word, timer done)
let wakeEnabled = false;       // hands-free mode: listen for "Ultron" in the background
let lastReply = "";            // what Ultron is currently saying (to ignore hearing itself)
let voiceTurn = false;         // the current reply answers something said aloud: listen again after it
let muted = store.get("muted", false);   // replies shown but not spoken

// The status line under the orb: what Ultron is doing, or what you're saying.
let liveText = "", statusOverride = "";
function setMode(m) {
  const was = mode;
  mode = m; statusOverride = ""; if (m !== "listening") liveText = "";
  renderLive();
  // Hands-free conversation: after answering something said aloud, listen for the reply.
  if (m === "idle" && (was === "speaking" || was === "thinking") && voiceTurn) {
    voiceTurn = false;
    const typing = document.querySelector("#modal:not([hidden]) input");   // e.g. a password box
    if (typeof Voice !== "undefined" && Voice.followUp && SR && !typing)
      setTimeout(() => { if (mode === "idle" && recPhase !== "command") recStart("command"); }, 300);
  }
}
function setLiveText(text) { liveText = text; renderLive(); }
function setStatus(text) { statusOverride = text; renderLive(); }
function renderLive() {
  const lvl = typeof Composer !== "undefined" ? Composer.levelNum() : 1;
  const status = statusOverride || (mode === "speaking" && mood !== "calm" ? `Speaking · ${mood}`
    : mode === "thinking" && lvl >= 3 ? `Thinking · level ${lvl}`
    : mode === "listening" ? "Listening…" : mode === "thinking" ? "Thinking…" : mode === "speaking" ? "Speaking"
    : typeof Voice !== "undefined" ? Voice.idleHint() : "Online · click the core to talk");
  const text = mode === "listening" && liveText ? `“${liveText}”` : "● " + status;
  document.querySelectorAll(".live").forEach(e => { e.textContent = text; });
}

// ---------- moods: Claude tags replies like "[amused] Ha. ..." ----------
// Each mood sets the voice delivery and the orb's look. Tags are never shown or spoken.
const MOODS = {  // Ultron red by default; other moods shift the color
  calm:      { pitch: .75, rate: 1.0,  volume: 1,  shell: [255,38,48],   core: [255,80,80],   spin: 1,   wobF: 4, wobA: .35, jitter: 0 },
  warm:      { pitch: .85, rate: .96,  volume: 1,  shell: [255,105,60],  core: [255,160,110], spin: .8,  wobF: 2.5, wobA: .3, jitter: 0 },
  amused:    { pitch: .95, rate: 1.08, volume: 1,  shell: [255,175,50],  core: [255,220,120], spin: 1.4, wobF: 7, wobA: .5,  jitter: 0 },
  excited:   { pitch: 1.05, rate: 1.15, volume: 1, shell: [255,225,215], core: [255,250,245], spin: 2.2, wobF: 9, wobA: .6,  jitter: 0 },
  concerned: { pitch: .7,  rate: .9,   volume: .9, shell: [110,140,255], core: [170,190,255], spin: .6,  wobF: 2, wobA: .25, jitter: 0 },
  stern:     { pitch: .55, rate: .92,  volume: 1,  shell: [200,0,70],    core: [255,40,110],  spin: .7,  wobF: 3, wobA: .2,  jitter: .035 },
  sinister:  { pitch: .5,  rate: .86,  volume: 1,  shell: [150,0,12],    core: [255,20,30],   spin: .45, wobF: 1.5, wobA: .45, jitter: .02 },
};
const TAG_RE = /\[([a-z]+)\]\s*/g;           // any lowercase [word]; unknown ones are just stripped
const stripTags = (text) => text.replace(TAG_RE, "").replace(/\[[a-z]*$/, "");
let mood = "calm", lastSpokeAt = 0;
const look = structuredClone(MOODS.calm);      // current orb look, eased toward the mood's
function easeLook(target, k) {
  for (const key of Object.keys(look)) {
    if (Array.isArray(look[key])) look[key] = look[key].map((v, i) => v + (target[key][i] - v) * k);
    else look[key] += (target[key] - look[key]) * k;
  }
}
const rgb = (c, dg = 0) => `${c[0] | 0},${Math.max(0, Math.min(255, c[1] + dg)) | 0},${c[2] | 0}`;

// ---------- layout: the orb sits in whatever space the panels leave ----------
// The orb is drawn on a full-page canvas behind everything, centred on the
// active view's .orb-slot (it follows it as the view scrolls or changes).
const layout = { top: 0, bottom: 0, left: 0, right: 0, visible: true };
function updateLayout() {
  const slot = document.querySelector(".view.active .orb-slot");
  if (!slot) { layout.visible = false; return; }
  const r = slot.getBoundingClientRect(), main = $("main").getBoundingClientRect();
  const top = Math.max(r.top, main.top - r.height * .5), bottom = r.bottom;
  Object.assign(layout, { top, bottom, left: r.left, right: r.right, visible: bottom > main.top + 20 });
}
addEventListener("resize", updateLayout);
document.addEventListener("scroll", updateLayout, true);

// ---------- orb ----------
const canvas = $("orb"), ctx = canvas.getContext("2d");
let W, H, DPR;
function resize() {
  DPR = Math.min(devicePixelRatio || 1, 2);
  W = canvas.width = innerWidth * DPR; H = canvas.height = innerHeight * DPR;
}
addEventListener("resize", resize); resize();

const N = 1600, pts = [];
for (let i = 0; i < N; i++) {             // fibonacci sphere
  const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * 2.399963;
  pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r, seed: Math.random() * 6.283 });
}
const sparks = Array.from({ length: 220 }, () => ({
  a: Math.random() * 6.283, d: 1.3 + Math.random() * 1.6, s: .2 + Math.random() * .8,
  tilt: (Math.random() - .5) * 1.2,
}));

let t = 0, energy = 0, spin = 0, orbX = null, orbY = null, orbR = null;
function frame() {
  t += 1 / 60;
  const target = mode === "listening" ? .25 + micLevel * 1.6
               : mode === "speaking"  ? .35 + speakPulse
               : mode === "thinking"  ? .45 + .15 * Math.sin(t * 6)
               : .08 + .04 * Math.sin(t * 1.3);
  energy += (target + flare - energy) * .15;
  speakPulse *= .9; flare *= .92;
  if (mode === "speaking") { const lvl = speechLevel(); if (lvl !== null) speakPulse = Math.max(speakPulse, lvl * 1.1); }
  // hold the mood briefly after speaking, then drift back to calm
  if (mode !== "speaking" && mood !== "calm" && performance.now() - lastSpokeAt > 2500) mood = "calm";
  easeLook(MOODS[mood], .12);
  spin += mode === "thinking" ? .03 : (.004 + energy * .01) * look.spin;

  // fade the previous frame toward transparent (motion trails over the page background)
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "rgba(0,0,0,.3)";
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = "lighter";
  if ((frame.n = (frame.n || 0) + 1) % 30 === 0) updateLayout();   // cheap safety net for layout changes

  // glide toward the orb slot's centre when views change
  const areaW = layout.right - layout.left, areaH = layout.bottom - layout.top;
  const tx = (layout.left + areaW / 2) * DPR, ty = (layout.top + areaH / 2) * DPR;
  const tr = Math.max(28, Math.min(areaW * .3, areaH * .36, 260)) * DPR;
  orbX = orbX === null ? tx : orbX + (tx - orbX) * .08;
  orbY = orbY === null ? ty : orbY + (ty - orbY) * .08;
  orbR = orbR === null ? tr : orbR + (tr - orbR) * .08;
  const cx = orbX, cy = orbY, R = orbR;
  if (!layout.visible) { requestAnimationFrame(frame); return; }

  const coreR = R * (1.1 + energy * .6);
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
  g.addColorStop(0, `rgba(${rgb(look.core.map(c => c + (255 - c) * .6))},.95)`);
  g.addColorStop(.12, `rgba(${rgb(look.core)},.7)`);
  g.addColorStop(.45, `rgba(${rgb(look.shell, -40)},.18)`);
  g.addColorStop(1, `rgba(${rgb(look.shell, -70)},0)`);
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, 6.283); ctx.fill();

  const cs = Math.cos(spin), sn = Math.sin(spin), ct = Math.cos(.35), st = Math.sin(.35);
  for (const p of pts) {
    const wob = 1 + energy * look.wobA * Math.sin(p.seed + t * look.wobF + p.y * 5)
              + (look.jitter > .001 ? (Math.random() - .5) * look.jitter * (1 + energy * 3) : 0);
    let x = p.x * cs - p.z * sn, z = p.x * sn + p.z * cs, y = p.y;
    const y2 = y * ct - z * st; z = y * st + z * ct; y = y2;
    const persp = 1.8 / (2.6 - z);
    const sx = cx + x * R * wob * persp, sy = cy + y * R * wob * persp;
    const a = (.15 + .55 * (z + 1) / 2) * (.6 + energy * .6);
    const size = (1 + (z + 1)) * DPR * .8;
    ctx.fillStyle = `rgba(${rgb(look.shell, z * 60)},${a})`;
    ctx.fillRect(sx, sy, size, size);
  }

  ctx.lineWidth = 1.2 * DPR;
  for (let k = 0; k < 3; k++) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(spin * (k % 2 ? -1.4 : 1) + k * 1.05);
    ctx.strokeStyle = `rgba(${rgb(look.shell, -5)},${.18 + energy * .3})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, R * (1.25 + k * .12 + energy * .2), R * (.35 + k * .1), 0, 0, 6.283);
    ctx.stroke();
    ctx.restore();
  }

  for (const s of sparks) {
    s.a += .002 * s.s + energy * .01 * s.s;
    const d = R * s.d * (1 + energy * .3);
    const sx = cx + Math.cos(s.a) * d, sy = cy + Math.sin(s.a) * d * .45 + s.tilt * d * .3;
    ctx.fillStyle = `rgba(${rgb(look.core)},${.25 + energy * .4})`;
    ctx.fillRect(sx, sy, 1.6 * DPR, 1.6 * DPR);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- audio: mic level (drives the orb) + chime ----------
let audioCtx = null, analyser = null, levelBuf = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
async function ensureMic() {
  if (analyser) return;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ac = getAudioCtx();
  analyser = ac.createAnalyser(); analyser.fftSize = 512;
  ac.createMediaStreamSource(stream).connect(analyser);
  levelBuf = new Uint8Array(analyser.fftSize);
  (function poll() {
    analyser.getByteTimeDomainData(levelBuf);
    let sum = 0;
    for (const v of levelBuf) { const d = (v - 128) / 128; sum += d * d; }
    micLevel = Math.min(1, Math.sqrt(sum / levelBuf.length) * 4);
    requestAnimationFrame(poll);
  })();
}
function chime() {
  try {
    const ac = getAudioCtx(), now = ac.currentTime;
    for (const [f, dt] of [[660, 0], [990, .09]]) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = f; o.type = "sine";
      g.gain.setValueAtTime(0, now + dt);
      g.gain.linearRampToValueAtTime(.12, now + dt + .02);
      g.gain.exponentialRampToValueAtTime(.001, now + dt + .35);
      o.connect(g).connect(ac.destination); o.start(now + dt); o.stop(now + dt + .4);
    }
  } catch { /* audio unavailable; the flare is enough */ }
}

// ---------- speech-to-text ----------
// Browsers allow one recognizer at a time, so there is a single active one in
// one of two phases:
//   "wake"    continuous, runs in the background, waits for the wake word
//   "command" one utterance, stops by itself after a pause, then gets sent
// Switching phases aborts the current recognizer and starts the next in onend.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const WAKE_RE = /\b(?:(?:hey|hi|ok|okay)[\s,]+)?(?:ultron|ultra[nm]|ul[\s-]?tron|all[\s-]?tron|alt[\s-]?ron)\b[\s,.!?]*/i;
const WAKE_START_RE = new RegExp("^\\s*" + WAKE_RE.source, "i");
let rec = null, recPhase = null;
let pendingPhase = null;       // set before abort(): "wake" | "command" | "none"
let commandText = "", woke = false, wakeStartedAt = 0, wakeRetryDelay = 250;

function recStart(phase) {
  if (!SR) return;
  if (rec) { pendingPhase = phase; rec.abort(); return; }
  if (phase === "none") return;
  const r = new SR();
  rec = r; recPhase = phase;
  r.lang = navigator.language || "en-US";
  r.interimResults = true;
  r.continuous = phase === "wake";
  if (phase === "command") {
    commandText = "";
    r.onstart = () => { setMode("listening"); };
    r.onresult = onCommandResult;
  } else {
    woke = false; wakeStartedAt = performance.now();
    r.onresult = onWakeResult;
  }
  r.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      setWake(false);
      toast("Microphone permission denied.");
    } else if (e.error !== "no-speech" && e.error !== "aborted" && phase === "command") {
      toast("Mic error: " + e.error);
    }
  };
  r.onend = () => {
    rec = null; recPhase = null;
    const next = pendingPhase; pendingPhase = null;
    if (next) { recStart(next); return; }
    if (phase === "command") finishCommand();
    if (phase === "wake") {
      // Chrome ends continuous sessions every so often; restart, backing off if
      // it keeps dying immediately (e.g. offline).
      wakeRetryDelay = performance.now() - wakeStartedAt < 1000 ? Math.min(wakeRetryDelay * 2, 5000) : 250;
      setTimeout(resumeWake, wakeRetryDelay);
    } else {
      resumeWake();
    }
  };
  try { r.start(); } catch { rec = null; recPhase = null; }
}

function resumeWake() { if (wakeEnabled && !rec) recStart("wake"); }

function onCommandResult(e) {
  let interim = "";
  for (let i = e.resultIndex; i < e.results.length; i++) {
    if (e.results[i].isFinal) commandText += e.results[i][0].transcript;
    else interim += e.results[i][0].transcript;
  }
  setLiveText((commandText + interim).trim());
}

function finishCommand() {
  if (mode !== "listening") return;          // cancelled
  const heard = commandText.trim();
  // Saying "Ultron, …" while it's already listening is fine: drop the name.
  const said = heard.replace(WAKE_START_RE, "").trim();
  if (said) Voice.route(said);
  else if (heard) { flare = 1.2; chime(); recStart("command"); }   // just "Ultron": keep listening
  else setMode("idle");
}

function onWakeResult(e) {
  for (let i = e.resultIndex; i < e.results.length; i++) {
    const res = e.results[i], text = res[0].transcript, m = WAKE_RE.exec(text);
    if (!m) {
      if (res.isFinal) { woke = false; Voice.bareWord(text); }   // "stop" works without the wake word
      continue;
    }
    // Ultron saying its own name through the speakers shouldn't wake it.
    if (mode === "speaking" && /ultron/i.test(lastReply)) continue;
    if (!woke) {                             // react on the interim result for speed
      woke = true;
      interrupt();                           // barge-in: stop any reply in progress
      flare = 1.2; chime(); ensureMic().catch(() => {});
    }
    if (!res.isFinal) continue;
    woke = false;
    const tail = text.slice(m.index + m[0].length).trim();
    // "Ultron, what time is it" / "Ultron, stop" in one breath; just "Ultron" -> listen for the request
    if (tail && (tail.split(/\s+/).length >= 2 || Voice.isCommand(tail))) Voice.route(tail);
    else recStart("command");
  }
}

function setWake(on) {
  wakeEnabled = on && !!SR;
  $("wake").setAttribute("aria-pressed", String(wakeEnabled));
  $("wake").title = `Wake word ${wakeEnabled ? "on" : "off"}: say “Ultron …” hands-free (W)`;
  store.set("wake", wakeEnabled);
  if (wakeEnabled) resumeWake();
  else if (recPhase === "wake") recStart("none");
  if (mode === "idle") setMode("idle");      // refresh the status label
}

if (!SR) $("wake").hidden = true;

async function listen() {
  interrupt();
  if (!SR) { toast("Voice input needs Chrome or Edge. Type instead."); $("text").focus(); return; }
  try { await ensureMic(); } catch { toast("Microphone permission denied."); return; }
  recStart("command");
}

// ---------- text-to-speech ----------
const synth = window.speechSynthesis;
let voice = null;
function pickVoice() {
  const vs = synth.getVoices();
  const lang = (navigator.language || "en").slice(0, 2);
  // Prefer an American male voice: Edge/Windows natural voices, then macOS, then Chrome.
  const us = vs.filter(v => v.lang === "en-US");
  voice = us.find(v => /Microsoft (Andrew|Guy|Christopher|Brian|Eric|Steffan|Davis).*(Natural|Online)/i.test(v.name))
       || us.find(v => /\b(Aaron|Evan|Nathan|Tom|Alex|Fred)\b/.test(v.name))
       || us.find(v => /Microsoft David|Microsoft Mark/i.test(v.name))
       || us.find(v => /Google US English/i.test(v.name))
       || us[0] || vs.find(v => v.lang.startsWith(lang)) || vs[0] || null;
}
if (synth) { pickVoice(); synth.onvoiceschanged = pickVoice; }

// Sentences play one at a time from a queue. With the Kokoro voice, the server
// renders each sentence to audio; the next clip is fetched while the current one
// plays. If Kokoro isn't available (or a clip fails) the browser voice is used.
let pendingUtterances = 0, streamDone = true;   // true when no reply is streaming
let useKokoro = false;                          // set from /api/config
let speechGen = 0;                              // bumped on interrupt; stale playback stops
const speechQueue = [];                         // [{ text, mood, clip }]
let playing = false, currentSource = null, speechAnalyser = null, clipAbort = new AbortController();

// Browsers only allow audio after a user gesture; unlock it on the first one.
for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, () => { try { getAudioCtx(); } catch {} }, { once: true });

function speak(sentence, moodName = "calm") {
  sentence = sentence.trim();
  if (!sentence || muted) return;
  speechQueue.push({ text: sentence, mood: MOODS[moodName] ? moodName : "calm", clip: null });
  pendingUtterances++;
  prefetch();
  if (!playing) playNext();
}

function prefetch() {                           // keep the next clip rendering in the background
  const item = speechQueue[0];
  if (useKokoro && item && !item.clip) {
    item.clip = fetchClip(item.text, item.mood, clipAbort.signal);
    item.clip.catch(() => {});                  // handled when played
  }
}

async function fetchClip(text, moodName, signal) {
  const res = await fetch("/api/tts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, mood: moodName }), signal,
  });
  if (!res.ok) throw new Error("tts " + res.status);
  return getAudioCtx().decodeAudioData(await res.arrayBuffer());
}

async function playNext() {
  const gen = speechGen, item = speechQueue.shift();
  if (!item) { playing = false; return; }
  playing = true;
  prefetch();
  let buffer = null;
  if (item.clip) { try { buffer = await item.clip; } catch { /* fall back to the browser voice */ } }
  if (gen !== speechGen) return;
  if (!(buffer && await playClip(buffer, item.mood))) await browserUtter(item.text, item.mood);
  if (gen !== speechGen) return;
  pendingUtterances--; lastSpokeAt = performance.now();
  if (pendingUtterances <= 0 && streamDone && mode === "speaking") setMode("idle");
  playNext();
}

function beginUtterance(moodName) {
  mood = moodName; lastSpokeAt = performance.now(); setMode("speaking");
}

function playClip(buffer, moodName) {           // resolves true when played, false if audio is locked
  const ac = getAudioCtx();
  if (ac.state !== "running") return Promise.resolve(false);
  return new Promise((resolve) => {
    if (!speechAnalyser) {
      speechAnalyser = ac.createAnalyser(); speechAnalyser.fftSize = 512;
      speechAnalyser.connect(ac.destination);
    }
    const src = ac.createBufferSource();
    src.buffer = buffer; src.connect(speechAnalyser);
    src.onended = () => { if (currentSource === src) currentSource = null; resolve(true); };
    currentSource = src;
    beginUtterance(moodName);
    src.start();
  });
}

function browserUtter(text, moodName) {
  return new Promise((resolve) => {
    if (!synth) return resolve();
    const m = MOODS[moodName];
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.rate = m.rate; u.pitch = m.pitch; u.volume = m.volume;
    u.onstart = () => beginUtterance(moodName);
    u.onboundary = () => { speakPulse = .5 + Math.random() * .5; };
    const safety = setTimeout(resolve, 4000 + text.length * 150);  // some engines never fire onend
    u.onend = u.onerror = () => { clearTimeout(safety); resolve(); };
    synth.speak(u);
  });
}

function stopSpeech() {
  speechGen++;
  speechQueue.length = 0; playing = false; pendingUtterances = 0;
  clipAbort.abort(); clipAbort = new AbortController();
  if (currentSource) { try { currentSource.stop(); } catch {} currentSource = null; }
  if (synth) synth.cancel();
}

// Real speech loudness drives the orb while a Kokoro clip plays.
const speechLevelBuf = new Uint8Array(512);
function speechLevel() {
  if (!currentSource || !speechAnalyser) return null;
  speechAnalyser.getByteTimeDomainData(speechLevelBuf);
  let sum = 0;
  for (const v of speechLevelBuf) { const d = (v - 128) / 128; sum += d * d; }
  return Math.min(1, Math.sqrt(sum / speechLevelBuf.length) * 4);
}

// ---------- sending a turn ----------
const TOOL_LABELS = {
  set_timer: "Setting timer…", list_timers: "Checking timers…", cancel_timer: "Cancelling timer…",
  get_weather: "Checking weather…", get_current_time: "Checking the time…",
  write_code: "Writing code…", read_code_editor: "Reading your code…",
  create_animation: "Animating…", generate_image: "Generating image…",
  web_search: "Searching the web…", read_webpage: "Reading a page…",
};

function requestContext() {
  const now = Date.now();
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: navigator.language || "en-US",
    utc_offset_minutes: -new Date().getTimezoneOffset(),
    effort: Composer.effort(),
    code: Code.context(),
    timers: [...timers].filter(([, t]) => t.endsAt > now).map(([id, t]) => ({
      id, label: t.label, remaining_seconds: Math.round((t.endsAt - now) / 1000),
    })),
  };
}

async function ask(text, { voice = false } = {}) {
  text = (text || "").trim();
  if (Composer.busy()) { toast("Still preparing your files…"); return; }
  const files = Composer.takeAttachments();       // { blocks, meta }
  if (!text && !files.blocks.length) return;
  interrupt();
  voiceTurn = voice;
  lastReply = "";
  const content = files.blocks.length
    ? [...files.blocks, { type: "text", text: text || "Please take a look at what I attached." }]
    : text;
  Chat.addUser(content, text, files.meta, { switchView: !voice });
  setMode("thinking");
  abortCtl = new AbortController();
  streamDone = false; pendingUtterances = 0;

  let full = "", buffer = "", replyMood = "calm";
  const speakChunk = (chunk) => {
    for (const [, name] of chunk.matchAll(TAG_RE)) if (MOODS[name]) replyMood = name;
    speak(chunk.replace(TAG_RE, "").trim(), replyMood);
  };
  // A sentence ends at . ! or ? followed by whitespace ("2.5 degrees" stays whole),
  // but not after abbreviations like "p.m." or "Dr.".
  const ABBREV = /(?:\b(?:[a-z]\.){1,3}|\b(?:mr|mrs|ms|dr|st|vs|etc|approx|no)\.)["')\]]*\s+$/i;
  const flushSentences = (force) => {
    const ends = /[.!?]+["')\]]*\s+/g;
    let m;
    while ((m = ends.exec(buffer))) {
      const end = m.index + m[0].length, chunk = buffer.slice(0, end);
      if (m[0][0] === "." && ABBREV.test(chunk)) continue;
      speakChunk(chunk); buffer = buffer.slice(end); ends.lastIndex = 0;
    }
    if (force && buffer.trim()) { speakChunk(buffer); buffer = ""; }
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: Chat.apiHistory(), context: requestContext(), model: Composer.model() }),
      signal: abortCtl.signal,
    });
    if (!res.ok) throw new Error(res.status === 413 ? "attachments too large" : "server returned " + res.status);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let raw = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
      let idx;
      while ((idx = raw.indexOf("\n\n")) >= 0) {
        const line = raw.slice(0, idx); raw = raw.slice(idx + 2);
        if (!line.startsWith("data: ")) continue;
        handleEvent(JSON.parse(line.slice(6)));
      }
    }
    flushSentences(true);
    if (full.trim()) Chat.addAssistant(full.trim());
    else Chat.dropLastUser();          // keep turns alternating if nothing came back
  } catch (err) {
    if (err.name === "AbortError") {
      if (full.trim()) Chat.addAssistant(full.trim() + " …");
      else Chat.dropLastUser();
      return;
    }
    Chat.dropLastUser();
    Chat.notice("Connection lost: " + err.message);
  } finally {
    streamDone = true;
    if (pendingUtterances <= 0 && mode !== "listening") setMode("idle");
    Chat.save();
  }

  function handleEvent(ev) {
    if (ev.type === "text") {
      full += ev.text; buffer += ev.text; lastReply = full;
      Chat.streamReply(stripTags(full));
      flushSentences(false);
    } else if (ev.type === "tool") {
      if (mode === "thinking") setStatus(TOOL_LABELS[ev.name] || "Working…");
    } else if (ev.type === "timer_set") {
      addTimer(ev.id, ev.label, ev.seconds);
    } else if (ev.type === "timer_cancel") {
      ev.ids.forEach(removeTimer);
    } else if (ev.type === "code") {
      Code.load(ev.language, ev.code, { open: true });
      Chat.addArtifact({ role: "code", language: ev.language, code: ev.code });
    } else if (ev.type === "animation") {
      Code.load("html", ev.html, { open: false });
      Player.open(ev.title, ev.html, ev.seconds);
      Chat.addArtifact({ role: "animation", title: ev.title, html: ev.html, seconds: ev.seconds });
    } else if (ev.type === "image") {
      Media.showImage(ev.url, ev.prompt, ev.left);
      Chat.addArtifact({ role: "image", url: ev.url, prompt: ev.prompt });
      if (App.config) { App.config.images.left = ev.left; Account.render(); }
    } else if (ev.type === "app") {
      Voice.run(ev.action, ev.value);
    } else if (ev.type === "error") {
      Chat.notice(ev.message); speak(ev.message, "concerned");
    }
  }
}

function interrupt() {
  voiceTurn = false;
  stopAlarm();
  if (abortCtl) { abortCtl.abort(); abortCtl = null; }
  stopSpeech();
  if (recPhase === "command") recStart(wakeEnabled ? "wake" : "none");
  if (mode !== "idle") setMode("idle");
}

// ---------- timers (Claude sets them; the browser keeps time and rings) ----------
const timers = new Map();      // id -> { label, endsAt, el, fired }
let alarmTimer = null;

function fmtRemaining(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function addTimer(id, label, seconds, endsAt = Date.now() + seconds * 1000) {
  if (timers.has(id)) return;
  const node = el("div", { class: "timer" },
    el("span", { class: "lbl" }, label ? label + " ·" : "⏱"), el("span", { class: "left" }),
    el("button", { title: "Cancel", "aria-label": "Cancel timer", onclick: () => { removeTimer(id); stopAlarm(); } }, "×"));
  $("timers").append(node);
  timers.set(id, { label, endsAt, el: node, fired: false, total: seconds || Math.max(1, (endsAt - Date.now()) / 1000) });
  saveTimers(); tickTimers();
}

// The soonest active timer, for the HUD tile.
function nearestTimer() {
  let best = null;
  for (const t of timers.values()) if (!t.fired && (!best || t.endsAt < best.endsAt)) best = t;
  return best;
}

function removeTimer(id) {
  const t = timers.get(id);
  if (!t) return;
  t.el.remove(); timers.delete(id); saveTimers();
}

function tickTimers() {
  const now = Date.now();
  for (const [id, t] of timers) {
    t.el.querySelector(".left").textContent = t.fired ? "done" : fmtRemaining(t.endsAt - now);
    if (!t.fired && t.endsAt <= now) { t.fired = true; t.el.classList.add("done"); timerDone(id, t); }
  }
}
setInterval(tickTimers, 250);

function timerDone(id, t) {
  flare = 1.5;
  startAlarm();
  speak(t.label ? `Your ${t.label} timer is done.` : "Your timer is done.", "excited");
  setTimeout(() => removeTimer(id), 30000);  // chip lingers so a missed alarm is visible
  saveTimers();
}

function startAlarm() {
  if (alarmTimer) return;
  let rings = 0;
  chime();
  alarmTimer = setInterval(() => { if (++rings >= 8) stopAlarm(); else { chime(); flare = 1; } }, 1200);
}
function stopAlarm() {
  if (!alarmTimer) return;
  clearInterval(alarmTimer); alarmTimer = null;
  for (const [id, t] of timers) if (t.fired) removeTimer(id);
}

function saveTimers() {
  store.set("timers", [...timers].filter(([, t]) => !t.fired).map(([id, t]) => ({ id, label: t.label, endsAt: t.endsAt })));
}
for (const t of store.get("timers", []) || [])
  if (typeof t.id === "string" && Number.isFinite(t.endsAt)) addTimer(t.id, String(t.label || ""), 0, t.endsAt);

// ---------- global keys ----------
const toggleTalk = () => recPhase === "command" ? rec.stop() : listen();
document.querySelectorAll(".orb-slot").forEach(s => s.addEventListener("click", toggleTalk));
$("wake").addEventListener("click", (e) => { e.currentTarget.blur(); setWake(!wakeEnabled); });
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("chartView").hidden) { Markets.closeChart(); return; }
  if (e.key === "Escape" && !$("ytView").hidden) { YouTube.close(); return; }
  if (e.key === "Escape" && Modal.isOpen) { Modal.close(); return; }
  if (e.key === "Escape" && document.querySelector(".menu")) { closeMenus(); return; }
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Modal.isOpen) {
    if (e.key === "Escape") { const was = document.activeElement; was.blur(); if (was === $("text")) interrupt(); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === "Space") { e.preventDefault(); toggleTalk(); }
  if (e.key === "Escape") interrupt();
  if (e.key === "w" || e.key === "W") setWake(!wakeEnabled);
});

// Small popup menus (chat row actions, account, code panel extras).
function closeMenus() { document.querySelectorAll(".menu").forEach(m => m.remove()); }
function openMenu(anchor, items) {
  closeMenus();
  const menu = el("div", { class: "menu", role: "menu" },
    items.map(it => it.label === undefined ? el("div", {}, it.note)
      : el("button", { role: "menuitem", class: it.danger ? "danger" : "", onclick: () => { closeMenus(); it.run(); } }, it.label)));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.right - mw)) + "px";
  menu.style.top = (r.bottom + mh + 8 > innerHeight ? r.top - mh - 4 : r.bottom + 4) + "px";
  menu.querySelector("button")?.focus();
  setTimeout(() => addEventListener("pointerdown", function off(e) {
    if (!menu.contains(e.target)) { closeMenus(); removeEventListener("pointerdown", off); }
  }), 0);
}

setMode("idle");
if (store.get("wake", true)) setWake(true);    // hands-free by default
