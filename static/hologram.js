"use strict";
// The hologram viewer: a floating 3D projection you control with your bare hands, like the
// gesture-controlled demos going around. Spread both hands apart to grow it, bring them
// together to shrink it, move your hand(s) to spin it, make a fist to dismiss it.
//
// Two kinds of object:
//  - a wireframe primitive (cube, sphere, torus, ... or Ultron's own "core") -- a true 3D mesh,
//    viewable from any angle.
//  - "project a Lamborghini" / "project a Boeing 747 interior" / anything else you describe --
//    Ultron generates a picture of it (the same image tool as always), then this builds a
//    depth-relief card from that single picture: a subdivided plane whose vertices are pushed
//    forward or back based on the picture's own brightness and how central each point is, so it
//    visibly shifts and parallaxes as you turn it. That's an honest description of what it is: a
//    very convincing single view, not a walk-around model. True arbitrary 3D generation needs a
//    cloud text-to-3D service this app doesn't have.

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

  // kind: a SHAPES name, "core", "image" (last generated image), or any other text -- treated as
  // something to generate an image of and project.
  async open(kind, value) {
    kind = (kind || "core").trim();
    const low = kind.toLowerCase();
    const wantsLast = low === "image" || low === "picture" || low === "photo";
    const wantsShape = !wantsLast && !!SHAPES[low];
    const wantsDescribed = !wantsLast && !wantsShape;
    if (wantsLast && !Media.last) return "You haven't generated an image yet. Ask me for one first.";

    if (!Gesture.running) await Gesture.start();     // the hologram is pointless without hand tracking
    if (!Gesture.running) return "I need the camera for that -- gesture control couldn't start.";

    this.kind = wantsShape ? low : "image";
    this.label = wantsLast ? "your image" : wantsShape ? low : kind;
    this.scale = this.targetScale = 1; this.rotX = this.targetRotX = 0; this.rotY = this.targetRotY = 0.4;
    $("hologramView").hidden = false;
    $("hologramTitle").textContent = wantsDescribed ? `Generating "${kind}"…` : wantsLast ? "Projecting your image" : `Projecting a ${low}`;
    this.active = true;
    document.body.classList.add("hologram-open");

    try {
      let source = value;
      if (wantsDescribed) {
        const res = await fetch("/api/hologram/project", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: kind }),
        });
        const data = await res.json();
        if (!res.ok) { this.close(); return data.error || "Couldn't generate that."; }
        source = data;
        Media.last = { url: data.url, prompt: data.prompt };
        $("hologramTitle").textContent = `Projecting "${kind}"`;
        if (App.config) { App.config.images.left = data.images_left; Account.render(); }
      }
      await this.build(wantsShape ? low : "image", source);
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
      this.mesh = await this.buildDepthCard(value?.url || Media.last.url);
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

  // Turns a single flat picture into a relief card: a subdivided plane pushed forward where the
  // picture is bright and central, and back where it's dark or near the edges. No real depth
  // sensor or model -- just enough displacement that turning it in your hand actually parallaxes.
  async buildDepthCard(url) {
    const tex = await new THREE.TextureLoader().loadAsync(url);
    const img = tex.image;
    const ar = img.width / img.height;
    const w = 2.6 * Math.max(ar, 1), h = 2.6 * Math.max(1 / ar, 1);
    const seg = 64;
    const geo = new THREE.PlaneGeometry(w, h, seg, seg);

    const c = document.createElement("canvas");
    c.width = seg + 1; c.height = seg + 1;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0, c.width, c.height);
    const px = g.getImageData(0, 0, c.width, c.height).data;

    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const col = i % (seg + 1), row = Math.floor(i / (seg + 1));
      const j = ((seg - row) * (seg + 1) + col) * 4;          // plane rows run bottom-to-top; image top-to-bottom
      const lum = (px[j] * 0.299 + px[j + 1] * 0.587 + px[j + 2] * 0.114) / 255;
      const u = col / seg - 0.5, v = row / seg - 0.5;
      const central = 1 - Math.min(1, Math.hypot(u, v) * 1.5);  // subject usually sits toward the middle
      const depth = (lum * 0.6 + central * 0.4);
      pos.setZ(i, (depth - 0.5) * 0.85);
    }
    geo.computeVertexNormals();

    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    const rim = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, h)), new THREE.LineBasicMaterial({ color: 0xff2b36, transparent: true, opacity: .5 }));
    mesh.add(rim);
    return mesh;
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
