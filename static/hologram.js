"use strict";
// The hologram viewer: a floating 3D wireframe you control with your bare hands, like the
// gesture-controlled demos going around. Spread both hands apart to grow it, bring them
// together to shrink it, move your hand(s) to spin it, make a fist to dismiss it.
//
// There's no text-to-3D model generation here -- that needs a heavyweight cloud model this
// app doesn't have. What's real: Ultron's own core as a live 3D object, a handful of named
// primitive shapes ("project a torus"), and your last generated image projected onto a
// floating glowing card. All rendered locally with Three.js; the only thing that leaves your
// machine is whatever generate_image already sent.

const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js";
const SHAPES = {
  core: () => new THREE.IcosahedronGeometry(1.3, 2),
  sphere: () => new THREE.IcosahedronGeometry(1.3, 3),
  cube: () => new THREE.BoxGeometry(1.9, 1.9, 1.9),
  box: () => new THREE.BoxGeometry(1.9, 1.9, 1.9),
  pyramid: () => new THREE.ConeGeometry(1.4, 2, 4),
  cone: () => new THREE.ConeGeometry(1.3, 2, 32),
  torus: () => new THREE.TorusGeometry(1.1, 0.42, 16, 64),
  cylinder: () => new THREE.CylinderGeometry(1.1, 1.1, 1.8, 32),
  diamond: () => new THREE.OctahedronGeometry(1.4, 0),
  star: () => new THREE.OctahedronGeometry(1.4, 0),
};

let threePromise = null;
function loadThree() {
  if (!threePromise) threePromise = import(THREE_URL);
  return threePromise;
}

const Hologram = {
  active: false, kind: null, label: "",
  scene: null, camera: null, renderer: null, mesh: null, group: null,
  raf: null, spinIdle: 0,
  scale: 1, targetScale: 1, rotY: 0, targetRotY: 0, rotX: 0, targetRotX: 0,
  hasHands: false, lastHandsAt: 0,

  async open(kind, value) {
    kind = (kind || "core").toLowerCase();
    const wantsImage = kind === "image" || kind === "picture" || kind === "photo";
    if (wantsImage && !Media.last) { return "You haven't generated an image yet. Ask me for one first."; }
    if (!wantsImage && !SHAPES[kind]) kind = "core";

    if (!Gesture.running) await Gesture.start();     // the hologram is pointless without hand tracking
    if (!Gesture.running) return "I need the camera for that -- gesture control couldn't start.";

    this.kind = wantsImage ? "image" : kind;
    this.label = wantsImage ? "your image" : kind;
    this.scale = this.targetScale = 1; this.rotX = this.targetRotX = 0; this.rotY = this.targetRotY = 0.4;
    $("hologramView").hidden = false;
    $("hologramTitle").textContent = wantsImage ? "Projecting your image" : `Projecting a ${kind}`;
    this.active = true;
    document.body.classList.add("hologram-open");

    try {
      await this.build(wantsImage ? "image" : kind, value);
    } catch (err) {
      this.close();
      return "The hologram viewer couldn't load: " + (err.message || err);
    }
    this.loop();
    return "";
  },

  async build(kind, value) {
    if (!this.renderer) {
      const THREE_MOD = await loadThree();
      window.THREE = THREE_MOD;              // SHAPES above reference the global for brevity
      const canvas = $("hologramCanvas");
      this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      this.renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
      this.camera.position.set(0, 0, 5.5);
      this.group = new THREE.Group();
      this.scene.add(this.group);
      const grid = new THREE.PolarGridHelper(2.6, 16, 6, 64, 0xff2b36, 0x5a1015);
      grid.position.y = -1.9; grid.material.transparent = true; grid.material.opacity = .35;
      this.scene.add(grid);
      this.resize();
      addEventListener("resize", () => this.resize());
    }
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose?.(); this.mesh = null; }

    if (kind === "image") {
      const tex = await new THREE.TextureLoader().loadAsync(value?.url || Media.last.url);
      const ar = tex.image.width / tex.image.height;
      const geo = new THREE.PlaneGeometry(2.4 * Math.max(ar, 1), 2.4 * Math.max(1 / ar, 1));
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
      this.mesh = new THREE.Mesh(geo, mat);
      const rim = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xff2b36 }));
      this.mesh.add(rim);
    } else {
      const geo = SHAPES[kind]();
      const mat = new THREE.MeshBasicMaterial({ color: 0xff2b36, wireframe: true, transparent: true, opacity: .85 });
      this.mesh = new THREE.Mesh(geo, mat);
      const glow = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff2b36, transparent: true, opacity: .06 }));
      glow.scale.setScalar(1.03);
      this.mesh.add(glow);
    }
    this.group.add(this.mesh);
  },

  resize() {
    if (!this.renderer) return;
    const el = $("hologramCanvas");
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  },

  loop() {
    if (!this.active) return;
    this.raf = requestAnimationFrame(() => this.loop());
    const idle = performance.now() - this.lastHandsAt > 700;
    if (idle) this.spinIdle += 0.006;                              // gentle idle spin when no hands are seen
    this.rotY += ((this.targetRotY + (idle ? this.spinIdle : 0)) - this.rotY) * 0.12;
    this.rotX += (this.targetRotX - this.rotX) * 0.12;
    this.scale += (this.targetScale - this.scale) * 0.15;
    if (this.group) {
      this.group.rotation.y = this.rotY; this.group.rotation.x = this.rotX;
      this.group.scale.setScalar(this.scale);
    }
    $("hologramHint").textContent = this.hasHands
      ? "Spread hands to grow · bring together to shrink · move to rotate"
      : "Show your hand to the camera";
    this.renderer?.render(this.scene, this.camera);
  },

  // Called every frame from Gesture.loop() with the raw MediaPipe result, while active.
  updateHands(result) {
    const hands = result.landmarks || [];
    this.hasHands = hands.length > 0;
    if (!hands.length) return;
    this.lastHandsAt = performance.now();
    const palm = (h) => ({ x: (h[0].x + h[9].x) / 2, y: (h[0].y + h[9].y) / 2 });

    if (hands.length >= 2) {
      const a = palm(hands[0]), b = palm(hands[1]);
      const spread = Math.hypot(a.x - b.x, a.y - b.y);
      this.targetScale = clamp(spread / 0.38, 0.4, 3.2);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      this.targetRotY = (cx - 0.5) * -5;
      this.targetRotX = (cy - 0.5) * 3.2;
    } else {
      const h = hands[0], p = palm(h);
      const pinch = Math.hypot(h[4].x - h[8].x, h[4].y - h[8].y);
      this.targetScale = clamp(pinch / 0.09, 0.4, 3.2);
      this.targetRotY = (p.x - 0.5) * -5;
      this.targetRotX = (p.y - 0.5) * 3.2;
    }
  },

  resetView() { this.targetScale = 1; this.targetRotY = 0.4; this.targetRotX = 0; this.spinIdle = 0; },

  close() {
    this.active = false; this.hasHands = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    $("hologramView").hidden = true;
    document.body.classList.remove("hologram-open");
  },
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

$("closeHologram")?.addEventListener("click", () => Hologram.close());
