"use strict";
// Hand-gesture control: point the webcam at your hand and control Ultron without
// touching anything. Runs entirely in the browser (MediaPipe's on-device model,
// downloaded once and cached) -- no video ever leaves your machine.
//
//   Open palm, held a beat   -> wake Ultron (like saying "Ultron" or clapping)
//   Fist                     -> stop talking / cancel
//   Thumbs up                -> confirm ("yes")
//   Thumbs down               -> cancel / close ("no")
//   Peace sign                -> new chat
//
// Off by default (it asks for the camera); turn it on in Settings.

const GESTURE_VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const GESTURE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";
const GESTURE_HOLD_MS = { Open_Palm: 350, Closed_Fist: 250, Thumb_Up: 300, Thumb_Down: 300, Victory: 350 };
const GESTURE_COOLDOWN_MS = 1200;
const GESTURE_MIN_SCORE = 0.65;

const Gesture = {
  enabled: store.get("gesture", false),
  running: false, starting: null,
  video: null, recognizer: null, raf: null, stream: null,
  current: null, since: 0, firedAt: 0, lastLabel: "",
  panel: null, thumb: null, label: null,

  async start() {
    if (this.running || this.starting) return this.starting;
    this.starting = (async () => {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: "user" } });
        this.video = document.createElement("video");
        this.video.srcObject = this.stream; this.video.muted = true; this.video.playsInline = true;
        await this.video.play();

        const { GestureRecognizer, FilesetResolver } = await loadVisionTasks();
        const files = await FilesetResolver.forVisionTasks(GESTURE_VISION_URL);
        this.recognizer = await GestureRecognizer.createFromOptions(files, {
          baseOptions: { modelAssetPath: GESTURE_MODEL_URL, delegate: "GPU" },
          runningMode: "VIDEO", numHands: 1,
        });

        this.buildPanel();
        this.running = true;
        this.loop();
      } catch (err) {
        this.stop();
        toast(/NotAllowedError|Permission/.test(String(err)) ? "Camera permission denied." : "Couldn't start gesture control: " + (err.message || err), 5000);
        this.enabled = false; store.set("gesture", false);
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  },

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.recognizer?.close?.(); this.recognizer = null;
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
    this.video = null;
    this.panel?.remove(); this.panel = null;
    this.current = null; this.since = 0;
  },

  toggle(on) {
    this.enabled = on; store.set("gesture", on);
    if (on) this.start(); else this.stop();
  },

  buildPanel() {
    this.thumb = el("video", { autoplay: true, muted: true, playsInline: true, class: "gesture-thumb" });
    this.thumb.srcObject = this.stream;
    this.label = el("span", { class: "gesture-label" }, "Show me a gesture");
    this.panel = el("div", { class: "gesture-panel", title: "Hand-gesture control is on" },
      this.thumb, this.label,
      el("button", { class: "icon-btn", "aria-label": "Turn off gesture control", onclick: () => { this.toggle(false); renderLive(); } }, "×"));
    document.body.append(this.panel);
  },

  loop() {
    if (!this.running) return;
    this.raf = requestAnimationFrame(() => this.loop());
    if (this.video.readyState < 2) return;
    let result;
    try { result = this.recognizer.recognizeForVideo(this.video, performance.now()); } catch { return; }
    const top = result.gestures?.[0]?.[0];
    const label = top && top.score >= GESTURE_MIN_SCORE && top.categoryName !== "None" ? top.categoryName : null;
    if (this.label) this.label.textContent = label ? PRETTY[label] || label : "…";

    const now = performance.now();
    if (label !== this.current) { this.current = label; this.since = now; }
    if (!label || now - this.since < (GESTURE_HOLD_MS[label] || 400)) return;
    if (now - this.firedAt < GESTURE_COOLDOWN_MS) return;

    this.fire(label);
    this.firedAt = now; this.since = now + 100000;   // don't refire until the gesture changes
  },

  fire(label) {
    switch (label) {
      case "Open_Palm":
        if (mode === "idle" || mode === "listening") Voice.wake();
        return;
      case "Closed_Fist":
        interrupt(); return;
      case "Thumb_Up":
        if (Modal.isOpen) Voice.confirm(); else { flare = .6; toast("👍"); }
        return;
      case "Thumb_Down":
        if (Modal.isOpen) Voice.run("close"); else toast("👎");
        return;
      case "Victory":
        Voice.run("new_chat"); return;
    }
  },
};

const PRETTY = { Open_Palm: "Open palm · waking", Closed_Fist: "Fist · stop", Thumb_Up: "Thumbs up", Thumb_Down: "Thumbs down", Victory: "Peace · new chat" };

let visionTasksPromise = null;
function loadVisionTasks() {
  if (visionTasksPromise) return visionTasksPromise;
  visionTasksPromise = import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs");
  return visionTasksPromise;
}

if (Gesture.enabled) Gesture.start();
