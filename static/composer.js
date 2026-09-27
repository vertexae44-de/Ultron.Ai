"use strict";
// The composer (message box, attachments, level and model menus), view switching,
// and the shortcut buttons around it (action cards, chips, tool tiles, sidebar).

const LEVELS = [
  { effort: "low",    name: "Quick",    tip: "Fastest replies" },
  { effort: "medium", name: "Balanced", tip: "A bit more thought" },
  { effort: "high",   name: "Smart",    tip: "Thinks carefully" },
  { effort: "xhigh",  name: "Genius",   tip: "Deep reasoning, slower" },
  { effort: "max",    name: "Max",      tip: "Maximum effort, slowest" },
];
const MODEL_BLURBS = {
  "claude-opus-5": "Smart all-rounder",
  "claude-opus-5-5": "Newest Opus, sharpest reasoning",
  "claude-sonnet-5": "Fast and capable",
};
const ICONS = {
  chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 10h.01M12 10h.01M16 10h.01"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  code: '<path d="m9 8-4 4 4 4M15 8l4 4-4 4"/>',
  voice: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3"/>',
  file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  video: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="m10 9 5 2.5-5 2.5z"/><path d="M3 20h18"/>',
  model: '<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10"/>',
  hologram: '<path d="M12 2v6M12 22v-6M4.9 4.9l4.2 4.2M14.9 14.9l4.2 4.2M4.9 19.1l4.2-4.2M14.9 9.1l4.2-4.2"/><circle cx="12" cy="12" r="3.4"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  power: '<path d="M12 3v7"/><path d="M6.3 6.3a9 9 0 1 0 11.4 0"/>',
};
const icon = (name, cls = "i") => `<svg class="${cls}" viewBox="0 0 24 24">${ICONS[name]}</svg>`;
const frag = (html) => document.createRange().createContextualFragment(html);

const MAX_PDF = 20 * 1024 * 1024, MAX_TEXT = 300 * 1024, MAX_TOTAL = 24 * 1024 * 1024, MAX_BLOCKS = 36;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|ya?ml|toml|ini|cfg|conf|log|py|ipynb|js|mjs|cjs|ts|tsx|jsx|java|c|h|cpp|hpp|cc|cs|go|rs|rb|php|swift|kt|kts|scala|sql|sh|bash|zsh|ps1|bat|html?|css|scss|less|vue|svelte|r|m|lua|pl|dart|exs?|hs|clj|tex|srt|vtt|env|gitignore|dockerfile|makefile)$/i;

// ---------- views ----------
const View = {
  current: "home",
  showChrome: false,   // "open the sidebar": temporarily undoes fullscreen-home to show the tools
  show(name) {
    if (name === "chat") name = "home";   // voice-only: never show the text transcript
    const ids = { home: "homeView", chat: "chatView", images: "imagesView" };
    if (!ids[name]) return;
    if (name !== "home") this.showChrome = false;   // leaving home resets it; other views always show chrome
    this.current = name;
    for (const [k, id] of Object.entries(ids)) $(id).classList.toggle("active", k === name);
    const slot = name === "chat" ? $("chatComposerSlot") : $("homeComposerSlot");
    if ($("composer").parentElement !== slot) slot.append($("composer"));
    document.querySelectorAll("#sidebar .nav, #tabbar button").forEach(b => {
      if (b.dataset.view === name) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    $("sidebar").classList.remove("open");
    document.querySelector(".shell").classList.toggle("home-full",
      name === "home" && document.body.classList.contains("voice-only") && !this.showChrome);
    if (name === "images") Gallery.load();
    if (name === "chat") Chat.scrollToEnd();
    requestAnimationFrame(updateLayout);
  },

  // "open the sidebar" / "hide the sidebar", voice-driven. Only matters on the fullscreen home
  // screen; every other screen already shows the sidebar and tools.
  setChrome(show) {
    this.showChrome = show;
    this.show(this.current);
  },
};

function prefill(text, { send = false } = {}) {
  if (View.current === "images") View.show("home");
  if (send) { ask(text); return; }
  const ta = $("text");
  ta.value = text; autogrow(); ta.focus();
  ta.setSelectionRange(text.length, text.length);
}

// Every shortcut button in the app goes through here.
function act(name) {
  switch (name) {
    case "chat": View.show("chat"); $("text").focus(); break;
    case "generate": if (Account.require("generate images", "images")) View.show("images"), $("genPrompt").focus(); break;
    case "code": Code.open(); break;
    case "animate": prefill("Make an animation of "); break;
    case "hologram": Hologram.open("core").then(msg => { if (msg) toast(msg, 5000); }); break;
    case "files": if (Account.require("attach files", "attachments")) $("fileInput").click(); break;
    case "voice": toggleTalk(); break;
    case "history": Chats.openDrawer(); break;
    case "settings": Account.settings(); break;
    case "signup": Account.open("signup"); break;
    case "login": Account.open("login"); break;
    case "logout": Account.logout(); break;
    case "media": View.setChrome(true); $("mediaPlayer")?.scrollIntoView({ behavior: "smooth", block: "center" }); break;
    case "sleep": Voice.run("wake_word", "off"); toast("Wake word off. Click the orb or say “Ultron” to talk."); break;
  }
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act], [data-view]");
  if (!b || b.closest("#modal")) return;
  if (b.dataset.view) View.show(b.dataset.view); else act(b.dataset.act);
});
$("menuBtn").addEventListener("click", (e) => { e.stopPropagation(); $("sidebar").classList.toggle("open"); });
addEventListener("pointerdown", (e) => {        // tap outside the slide-out menu to close it
  if ($("sidebar").classList.contains("open") && !$("sidebar").contains(e.target) && !$("menuBtn").contains(e.target)) $("sidebar").classList.remove("open");
});
const narrow = matchMedia("(max-width: 820px)");
const setPlaceholder = () => { $("text").placeholder = narrow.matches ? "Message Ultron…" : "Type your message here… (or press Space to talk)"; };
narrow.addEventListener("change", setPlaceholder); setPlaceholder();

// ---------- composer ----------
function autogrow() {
  const ta = $("text");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 180) + "px";
}

const Composer = {
  items: [],      // { id, name, kind, status: "working"|"ready"|"error", blocks, thumb, bytes, error, el }

  levelNum() { return Number($("level").value || 1); },
  effort() { return LEVELS[this.levelNum() - 1].effort; },
  model() { return $("model").value || App.config?.default_model; },
  busy() { return this.items.some(i => i.status === "working"); },

  takeAttachments() {
    const ready = this.items.filter(i => i.status === "ready");
    const out = { blocks: ready.flatMap(i => i.blocks), meta: ready.map(i => ({ name: i.name, kind: i.kind, thumb: i.thumb })) };
    this.items.forEach(i => i.el.remove()); this.items = [];
    return out;
  },

  add(files) {
    if (!Account.require("attach files", "attachments")) return;
    for (const file of files) {
      const item = { id: Math.random().toString(36).slice(2), name: file.name || "pasted image", kind: kindOf(file), status: "working", blocks: [], bytes: 0 };
      item.el = el("div", { class: "chip" });
      this.items.push(item); this.renderChip(item); $("attachments").append(item.el);
      processFile(file, item.kind)
        .then(({ blocks, thumb }) => {
          const bytes = blocks.reduce((n, b) => n + (b.source?.data?.length || b.text?.length || 0), 0);
          const totalBlocks = this.items.filter(i => i.status === "ready").reduce((n, i) => n + i.blocks.length, 0) + blocks.length;
          if (this.totalBytes() + bytes > MAX_TOTAL) throw new Error("Too large together; send these separately");
          if (totalBlocks > MAX_BLOCKS) throw new Error("Too many files at once");
          Object.assign(item, { blocks, thumb, bytes, status: "ready" });
        })
        .catch((err) => Object.assign(item, { status: "error", error: err.message }))
        .finally(() => this.renderChip(item));
    }
  },
  totalBytes() { return this.items.filter(i => i.status === "ready").reduce((n, i) => n + i.bytes, 0); },
  remove(item) { item.el.remove(); this.items = this.items.filter(i => i !== item); },
  renderChip(item) {
    const labels = { image: "Picture", video: "Video", pdf: "PDF", text: "Text file" };
    const sub = item.status === "working" ? "Reading…" : item.status === "error" ? item.error
      : item.kind === "video" ? `${labels.video} · ${item.blocks.filter(b => b.type === "image").length} frames` : labels[item.kind];
    item.el.className = "chip" + (item.status === "error" ? " err" : "");
    item.el.replaceChildren(
      item.thumb ? el("img", { src: item.thumb, alt: "" }) : el("span", { class: "ph" }, frag(icon(item.kind === "video" ? "video" : "file"))),
      el("span", {}, el("span", { class: "nm", title: item.name }, item.name), el("span", { class: "sub" }, sub)),
      el("button", { type: "button", title: "Remove", "aria-label": "Remove " + item.name, onclick: () => this.remove(item) }, "×"));
  },
};

function kindOf(file) {
  const t = file.type || "";
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
  if (t.startsWith("text/") || /json|xml|javascript|x-python|x-sh|yaml|csv/.test(t) || TEXT_EXT.test(file.name)) return "text";
  return "other";
}

async function processFile(file, kind) {
  if (kind === "image") return imageBlocks(file);
  if (kind === "video") return videoBlocks(file);
  if (kind === "pdf") {
    if (file.size > MAX_PDF) throw new Error("PDF over 20 MB");
    const data = await readBase64(file);
    return { blocks: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }] };
  }
  if (kind === "text") {
    let text = await file.slice(0, MAX_TEXT).text();
    if (text.includes("\u0000")) throw new Error("Not a text file");
    if (file.size > MAX_TEXT) text += `\n\n[… truncated: only the first ${MAX_TEXT / 1024} KB are included]`;
    return { blocks: [{ type: "text", text: `Attached file "${file.name}":\n\n${text}` }] };
  }
  const ext = (file.name.split(".").pop() || "").toUpperCase();
  throw new Error(`Can't read ${ext || "this"} files. Try PDF, a picture, a video or plain text`);
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(file);
  });
}

function drawScaled(source, w, h, max) {
  const s = Math.min(1, max / Math.max(w, h));
  const c = el("canvas"); c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);   // transparent PNGs get a white background
  g.drawImage(source, 0, 0, c.width, c.height);
  return c;
}
const jpegBlock = (canvas, q) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: canvas.toDataURL("image/jpeg", q).split(",")[1] } });

async function imageBlocks(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { throw new Error("This picture format isn't supported (try JPG or PNG)"); }
  const block = jpegBlock(drawScaled(bmp, bmp.width, bmp.height, 1568), .86);
  const thumb = drawScaled(bmp, bmp.width, bmp.height, 96).toDataURL("image/jpeg", .7);
  bmp.close?.();
  return { blocks: [block], thumb };
}

async function videoBlocks(file) {
  const url = URL.createObjectURL(file);
  const v = el("video", { muted: true, playsinline: true, preload: "auto" });
  v.muted = true; v.src = url;
  const wait = (ev, ms, msg) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(msg)), ms);
    v.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true });
    v.addEventListener("error", () => { clearTimeout(t); rej(new Error("Your browser can't read this video format")); }, { once: true });
  });
  try {
    await wait("loadeddata", 20000, "Timed out reading the video");
    const d = v.duration;
    if (!isFinite(d) || d <= 0) throw new Error("Couldn't find the video's length");
    const n = d <= 8 ? 4 : d <= 60 ? 8 : 10;
    const blocks = [{ type: "text", text: `Video "${file.name}", ${d.toFixed(1)} seconds long. ${n} still frames sampled evenly (no audio):` }];
    let thumb = null;
    for (let i = 0; i < n; i++) {
      const at = d * (i + .5) / n;
      v.currentTime = at;
      await wait("seeked", 10000, "Timed out reading video frames");
      const c = drawScaled(v, v.videoWidth, v.videoHeight, 1024);
      blocks.push({ type: "text", text: `Frame at ${at.toFixed(1)} s:` }, jpegBlock(c, .8));
      if (!thumb) thumb = drawScaled(v, v.videoWidth, v.videoHeight, 96).toDataURL("image/jpeg", .7);
    }
    return { blocks, thumb };
  } finally { URL.revokeObjectURL(url); v.removeAttribute("src"); v.load(); }
}

// ---------- composer wiring ----------
(() => {
  $("homeComposerSlot").append($("composer"));   // starts under the action cards on Home
  const ta = $("text");
  ta.addEventListener("input", autogrow);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); }
  });
  ta.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); Composer.add(files); }
  });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = ta.value.trim();
    if (!v && !Composer.items.some(i => i.status === "ready")) return;
    ta.value = ""; autogrow();
    ask(v);
  });
  $("attachBtn").addEventListener("click", () => { if (Account.require("attach files", "attachments")) $("fileInput").click(); });
  $("fileInput").addEventListener("change", (e) => { Composer.add([...e.target.files]); e.target.value = ""; });
  $("imageBtn").addEventListener("click", () => { if (Account.require("generate images", "images")) prefill("Generate an image of "); });
  $("micBtn").addEventListener("click", () => toggleTalk());

  // Drag and drop anywhere.
  let depth = 0;
  addEventListener("dragenter", (e) => { if (e.dataTransfer?.types?.includes("Files")) { depth++; $("dropzone").hidden = false; } });
  addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; $("dropzone").hidden = true; } });
  addEventListener("dragover", (e) => e.preventDefault());
  addEventListener("drop", (e) => {
    e.preventDefault(); depth = 0; $("dropzone").hidden = true;
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) { if (View.current === "images") View.show("home"); Composer.add(files); }
  });

  // Level menu.
  const lv = $("level");
  LEVELS.forEach((l, i) => lv.append(el("option", { value: i + 1 }, `${i + 1} · ${l.name} — ${l.tip}`)));
  lv.value = String(store.get("level", 1));
  const showLevel = () => { const l = LEVELS[Composer.levelNum() - 1]; $("levelLabel").textContent = `${Composer.levelNum()} · ${l.name}`; };
  lv.addEventListener("change", () => {
    const max = LEVELS.findIndex(l => l.effort === App.perms.max_effort) + 1;
    if (Composer.levelNum() > max) lv.value = String(max);   // shouldn't happen now everyone gets max_effort
    store.set("level", Composer.levelNum()); showLevel(); renderLive();
  });
  showLevel();

  $("model").addEventListener("change", () => { store.set("model", $("model").value); syncModels(); });

  // Chips, tool tiles.
  const CHIPS = [
    ["Write a story", "Write a short story about "], ["Create an image", "Generate an image of "],
    ["Explain this code", "Explain the code in my editor.", true], ["Give me ideas", "Give me ten ideas for "],
    ["Help me plan", "Help me plan "], ["Make an animation", "Make an animation of "],
    ["Set a timer", "Set a timer for 10 minutes", true], ["Weather", "What's the weather like today?", true],
  ];
  for (const [label, text, send] of CHIPS)
    $("chips").append(el("button", { class: "pill", type: "button", onclick: () => prefill(text, { send }) }, label));
  const TOOLS = [["Chat", "chat", "chat"], ["Generate Images", "image", "generate"], ["Code", "code", "code"],
    ["Voice", "voice", "voice"], ["File Upload", "file", "files"], ["Animation", "video", "animate"],
    ["Hologram", "hologram", "hologram"]];
  for (const [label, ic, a] of TOOLS)
    $("tools").append(el("button", { class: "tile", type: "button", "data-act": a }, frag(icon(ic)), label));
})();

// Menus and locks depend on who's logged in and their plan.
function modelAllowed(id) {
  const m = App.perms.models;
  return id === App.config?.default_model || m === "all" || (Array.isArray(m) && m.includes(id));
}
function askForModel(m) {           // there's no locked model anymore, but keep a safe fallback
  toast(`Couldn't switch to ${m.label}.`);
}
function syncModels() {
  const c = App.config;
  if (!c) return;
  const sel = $("model");
  if (!sel.options.length) for (const m of c.models) sel.append(el("option", { value: m.id }, m.label));
  for (const o of sel.options) {
    const m = c.models.find(x => x.id === o.value);
    o.textContent = m.label;
  }
  const saved = store.get("model", null);
  if (!sel.dataset.init) { sel.value = c.models.some(m => m.id === saved) ? saved : c.default_model; sel.dataset.init = "1"; }
  $("modelLabel").textContent = (c.models.find(m => m.id === sel.value) || {}).label || sel.value;
  const list = $("modelList");
  list.replaceChildren(...c.models.map(m => el("li", {},
    el("button", { class: "item", type: "button", onclick: () => {
      sel.value = m.id; store.set("model", m.id); syncModels(); toast(`Model: ${m.label}`);
    } },
      el("span", { class: "ic" }, frag(icon("model"))),
      el("span", { class: "tx" }, el("span", { class: "t" }, m.label), el("span", { class: "s" },
        m.brain === "local" ? "Free. Runs on this PC, nothing sent to the cloud." : MODEL_BLURBS[m.id] || "Claude model")),
      m.id === sel.value ? el("span", { class: "badge" }, "Selected")
        : m.id === c.default_model ? el("span", { class: "badge" }, "Default") : null))));
  if (typeof HUD !== "undefined") HUD.buildStatus();
}

onConfig(() => {
  const max = LEVELS.findIndex(l => l.effort === App.perms.max_effort) + 1;
  [...$("level").options].forEach((o, i) => {
    o.textContent = `${i + 1} · ${LEVELS[i].name} — ${LEVELS[i].tip}`;
  });
  if (Composer.levelNum() > max) { $("level").value = String(max); }
  $("levelLabel").textContent = `${Composer.levelNum()} · ${LEVELS[Composer.levelNum() - 1].name}`;
  syncModels();
  for (const [sel, perm] of [["#attachBtn", "attachments"], ["#imageBtn", "images"]]) {
    const b = document.querySelector(sel);
    b.querySelector(".lock")?.remove();
    if (!App.perms[perm]) b.append(el("span", { class: "lock" }, "🔒"));
  }
  document.querySelectorAll('.tile[data-act="generate"], .tile[data-act="files"]').forEach(t => {
    t.querySelector(".lock")?.remove();
    if (!App.perms[t.dataset.act === "files" ? "attachments" : "images"]) t.append(el("span", { class: "lock" }, "🔒"));
  });
});

View.show(View.current);   // apply the fullscreen-home treatment on first load, too
