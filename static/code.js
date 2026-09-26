"use strict";
// The code panel (editor + runners) and the animation player.
//
// Everything runs sandboxed in the browser, never on the server:
//   Python      Pyodide in a Web Worker (downloaded on first run, ~10 MB)
//   JavaScript  a Web Worker (no page access; killed after 10 s)
//   HTML        an <iframe sandbox="allow-scripts">, so it can't touch Ultron's page or cookies

const PYODIDE_DEFAULT = "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/";
const JS_TIMEOUT_MS = 10000, PY_TIMEOUT_MS = 30000;
const EXT = { python: "py", javascript: "js", html: "html" };

// Injected at the top of sandboxed pages: forwards console output and errors to
// Ultron, and records the page's <canvas> to video when the player asks.
const SANDBOX_HELPER = `<script>(()=>{const P=m=>parent.postMessage(Object.assign({ultron:1},m),"*");
const f=a=>a.map(x=>typeof x==="string"?x:(()=>{try{return JSON.stringify(x)}catch{return String(x)}})()).join(" ");
for(const[k,l]of[["log","log"],["info","log"],["warn","warn"],["error","err"]]){const o=console[k].bind(console);
console[k]=(...a)=>{try{P({kind:"console",level:l,text:f(a)})}catch{}o(...a)}}
addEventListener("error",e=>P({kind:"console",level:"err",text:String(e.message)}));
addEventListener("message",e=>{const d=e.data;if(!d||d.ultron!=="record")return;const c=document.querySelector("canvas");
if(!c||!c.captureStream||typeof MediaRecorder==="undefined"){P({kind:"recorded",error:"This animation doesn't draw on a canvas, so it can't be recorded as video."});return}
const types=["video/mp4;codecs=avc1","video/webm;codecs=vp9","video/webm"];const type=types.find(t=>MediaRecorder.isTypeSupported(t));
const r=new MediaRecorder(c.captureStream(60),Object.assign({videoBitsPerSecond:8e6},type?{mimeType:type}:{}));const ch=[];
r.ondataavailable=ev=>{if(ev.data.size)ch.push(ev.data)};r.onstop=()=>P({kind:"recorded",blob:new Blob(ch,{type:r.mimeType}),type:r.mimeType});
r.start(250);setTimeout(()=>r.stop(),Math.min(60,Math.max(1,d.seconds))*1000)});})();<\/script>`;

function sandboxDoc(html) {
  // Put the helper inside <head> (before the doctype would trigger quirks mode).
  for (const re of [/<head[^>]*>/i, /<html[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + SANDBOX_HELPER + html.slice(m.index + m[0].length);
  }
  return SANDBOX_HELPER + html;
}

const JS_WORKER = `
const fmt = (a) => a.map(x => typeof x === "string" ? x : (() => { try { return JSON.stringify(x, null, 2) ?? String(x); } catch { return String(x); } })()).join(" ");
for (const [k, lv] of [["log","log"],["info","log"],["debug","log"],["warn","warn"],["error","err"]])
  console[k] = (...a) => postMessage({ k: lv, t: fmt(a) });
self.onmessage = async (e) => {
  try {
    const AsyncFunction = (async () => {}).constructor;
    const r = await new AsyncFunction(e.data)();
    if (r !== undefined) postMessage({ k: "result", t: fmt([r]) });
  } catch (err) { postMessage({ k: "err", t: (err && err.stack) || String(err) }); }
  postMessage({ k: "done" });
};`;

const PY_WORKER = `
let py = null;
const AFTER = [
  "import sys as _s",
  "if 'matplotlib' in _s.modules:",
  "    import matplotlib.pyplot as _plt, io as _io, base64 as _b",
  "    for _n in _plt.get_fignums():",
  "        _buf = _io.BytesIO(); _plt.figure(_n).savefig(_buf, format='png', bbox_inches='tight')",
  "        print('__ULTRON_IMG__' + _b.b64encode(_buf.getvalue()).decode())",
  "    _plt.close('all')",
].join("\\n");
self.onmessage = async (e) => {
  const d = e.data;
  if (d.cmd === "init") {
    try {
      importScripts(d.base + "pyodide.js");
      py = await loadPyodide({ indexURL: d.base, stdout: (s) => postMessage({ k: "log", t: s }), stderr: (s) => postMessage({ k: "err", t: s }) });
      py.runPython("import os; os.environ['MPLBACKEND'] = 'AGG'");
      postMessage({ k: "ready" });
    } catch (err) { postMessage({ k: "fatal", t: String(err && err.message || err) }); }
  } else if (d.cmd === "run") {
    try {
      await py.loadPackagesFromImports(d.code, { messageCallback: (m) => postMessage({ k: "sys", t: m }) });
      const r = await py.runPythonAsync(d.code);
      if (r !== undefined && r !== null) postMessage({ k: "result", t: String(r) });
    } catch (err) { postMessage({ k: "err", t: String(err && err.message || err) }); }
    try { await py.runPythonAsync(AFTER); } catch {}
    postMessage({ k: "done" });
  }
};`;

const workerURL = (src) => URL.createObjectURL(new Blob([src], { type: "text/javascript" }));

function pyodideBase() {
  // ?pyodide=/local/path/ lets you serve Pyodide yourself; only same-origin paths are accepted.
  const q = new URLSearchParams(location.search).get("pyodide");
  const base = q && /^\/[^/\\]/.test(q) ? new URL(q, location.href).href : PYODIDE_DEFAULT;
  return base.endsWith("/") ? base : base + "/";
}

function download(name, blob) {
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const slug = (s) => (s || "ultron").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "ultron";

// ---------- code panel ----------
const Code = {
  output: "",
  running: null,          // { kind, stop() }
  py: null,               // { worker, ready: Promise }

  isOpen() { return !$("codePanel").hidden; },
  open() {
    $("codePanel").hidden = false; $("codeBtn").setAttribute("aria-pressed", "true");
    updateLayout(); setTimeout(() => $("code").focus(), 0);
  },
  close() { $("codePanel").hidden = true; $("codeBtn").setAttribute("aria-pressed", "false"); updateLayout(); },
  toggle() { this.isOpen() ? this.close() : this.open(); },

  load(language, code, { open = true } = {}) {
    $("codeLang").value = EXT[language] ? language : "python";
    $("code").value = code;
    this.output = ""; this.clearOutput(); this.save(); this.syncButtons();
    if (open) this.open();
  },
  save() { store.set("code", { language: $("codeLang").value, code: $("code").value }); },
  syncButtons() {
    const html = $("codeLang").value === "html";
    $("playCode").hidden = !html;
    $("runCode").lastChild.textContent = html ? "Preview" : "Run";
  },
  context() {
    const code = $("code").value;
    return code.trim() ? { language: $("codeLang").value, code: code.slice(0, 200000), output: this.output.slice(-20000) } : null;
  },

  clearOutput() {
    $("console").replaceChildren(); $("preview").hidden = true; $("preview").srcdoc = "";
    $("runStatus").textContent = "Output";
  },
  log(kind, text) {
    if (kind === "log" && text.startsWith("__ULTRON_IMG__")) {
      $("console").append(el("img", { src: "data:image/png;base64," + text.slice(14), alt: "figure", style: "max-width:100%;background:#fff;border-radius:6px;margin:6px 0;display:block" }));
      this.output += "[figure]\n";
      return;
    }
    const line = el("div", { class: kind === "err" ? "err" : kind === "warn" ? "warn" : kind === "sys" ? "sys" : "" }, text);
    $("console").append(line);
    $("console").scrollTop = $("console").scrollHeight;
    if (kind !== "sys") this.output += (kind === "err" ? "ERROR: " : "") + text + "\n";
  },
  finish(status) {
    if (this.running) this.running.stopTimer?.();
    this.running = null;
    $("runStatus").textContent = status;
  },

  run() {
    const lang = $("codeLang").value, code = $("code").value;
    if (!code.trim()) { toast("Nothing to run yet."); return; }
    this.stop(true);
    this.clearOutput(); this.output = "";
    $("runStatus").textContent = "Running…";
    if (lang === "javascript") this.runJS(code);
    else if (lang === "python") this.runPython(code);
    else this.runHTML(code);
  },
  stop(quiet = false) {
    if (!this.running) return;
    this.running.stop();
    if (!quiet) { this.log("sys", "Stopped."); this.finish("Stopped"); }
    this.running = null;
  },

  runJS(code) {
    const w = new Worker(workerURL(JS_WORKER));
    let grace = null;
    const hard = setTimeout(() => { w.terminate(); this.log("err", `Stopped after ${JS_TIMEOUT_MS / 1000} seconds (infinite loop?).`); this.finish("Timed out"); }, JS_TIMEOUT_MS);
    this.running = { kind: "js", stop: () => { clearTimeout(hard); clearTimeout(grace); w.terminate(); }, stopTimer: () => clearTimeout(hard) };
    const started = performance.now();
    w.onmessage = (e) => {
      const { k, t } = e.data;
      if (k === "done") {
        clearTimeout(hard);
        this.finish(`Finished in ${((performance.now() - started) / 1000).toFixed(2)} s`);
        grace = setTimeout(() => w.terminate(), 1500);      // let pending timers print, then clean up
      } else this.log(k === "result" ? "log" : k, k === "result" ? "→ " + t : t);
    };
    w.postMessage(code);
  },

  ensurePython() {
    if (this.py) return this.py.ready;
    const worker = new Worker(workerURL(PY_WORKER));
    const ready = new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        if (e.data.k === "ready") resolve();
        else if (e.data.k === "fatal") reject(new Error(e.data.t));
      };
      worker.onerror = (e) => reject(new Error(e.message || "worker failed"));
    });
    this.py = { worker, ready };
    worker.postMessage({ cmd: "init", base: pyodideBase() });
    ready.catch(() => { this.py = null; worker.terminate(); });
    return ready;
  },

  async runPython(code) {
    const first = !this.py;
    if (first) this.log("sys", "Loading Python (first run only, about 10 MB)…");
    let cancelled = false;
    this.running = { kind: "py", stop: () => { cancelled = true; this.py?.worker.terminate(); this.py = null; } };
    try { await this.ensurePython(); }
    catch (err) {
      if (!cancelled) { this.log("err", "Couldn't load Python: " + err.message + ". Check your internet connection."); this.finish("Failed"); }
      return;
    }
    if (cancelled) return;
    const { worker } = this.py;
    const started = performance.now();
    const hard = setTimeout(() => {
      worker.terminate(); this.py = null;
      this.log("err", `Stopped after ${PY_TIMEOUT_MS / 1000} seconds (infinite loop?). Python will reload on the next run.`);
      this.finish("Timed out");
    }, PY_TIMEOUT_MS);
    this.running.stopTimer = () => clearTimeout(hard);
    const prevStop = this.running.stop;
    this.running.stop = () => { clearTimeout(hard); prevStop(); };
    worker.onmessage = (e) => {
      const { k, t } = e.data;
      if (k === "done") { clearTimeout(hard); this.finish(`Finished in ${((performance.now() - started) / 1000).toFixed(2)} s`); }
      else if (k === "result") this.log("log", "→ " + t);
      else if (k === "log" || k === "err" || k === "sys") this.log(k, t);
    };
    worker.postMessage({ cmd: "run", code });
  },

  runHTML(code) {
    const f = $("preview");
    f.hidden = false; f.srcdoc = sandboxDoc(code);
    this.running = null;
    $("runStatus").textContent = "Live preview";
  },
};

// Messages from sandboxed frames (HTML preview console, animation recordings).
addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.ultron !== 1) return;
  if (e.source === $("preview").contentWindow && d.kind === "console") Code.log(d.level, d.text);
  else if (Player.frame && e.source === Player.frame.contentWindow) Player.onMessage(d);
});

// ---------- animation player ----------
const Player = {
  frame: null, title: "", html: "", seconds: 8, statusEl: null, recordBtn: null,

  open(title, html, seconds = 8) {
    this.title = title || "Animation"; this.html = html; this.seconds = seconds || 8;
    this.frame = el("iframe", { class: "player", sandbox: "allow-scripts", title: this.title, allow: "fullscreen" });
    this.frame.srcdoc = sandboxDoc(html);
    this.statusEl = el("span", { class: "muted" });
    const btn = (label, title, run) => el("button", { class: "pill", title, onclick: run }, label);
    this.recordBtn = btn(`Record ${this.seconds}s video`, "Save the animation as a video file", () => this.record());
    const box = el("div", { class: "box wide", role: "dialog", "aria-label": this.title },
      el("header", {},
        el("h2", {}, this.title),
        this.statusEl,
        btn("Replay", "Restart the animation", () => { this.frame.srcdoc = sandboxDoc(this.html); }),
        btn("Fullscreen", "Fullscreen", () => this.frame.requestFullscreen?.()),
        this.recordBtn,
        btn("Download HTML", "Save as a web page", () => download(slug(this.title) + ".html", new Blob([this.html], { type: "text/html" }))),
        btn("Edit code", "Open in the code editor", () => { Code.load("html", this.html, { open: true }); Modal.close(); }),
        el("button", { class: "icon-btn", title: "Close", "aria-label": "Close", onclick: () => Modal.close() }, "×")),
      this.frame);
    Modal.open(box, () => { this.frame = null; });
  },

  record() {
    if (!this.frame) return;
    this.recordBtn.disabled = true;
    let left = this.seconds;
    this.statusEl.textContent = `● Recording… ${left}s`;
    this.tick = setInterval(() => { left = Math.max(0, left - 1); this.statusEl.textContent = `● Recording… ${left}s`; }, 1000);
    this.frame.contentWindow.postMessage({ ultron: "record", seconds: this.seconds }, "*");
  },

  onMessage(d) {
    if (d.kind !== "recorded") return;
    clearInterval(this.tick);
    this.recordBtn.disabled = false;
    if (d.error) { this.statusEl.textContent = ""; toast(d.error, 5000); return; }
    const ext = (d.type || "").includes("mp4") ? "mp4" : "webm";
    download(`${slug(this.title)}.${ext}`, d.blob);
    this.statusEl.textContent = `Saved ${ext.toUpperCase()} video`;
  },
};

// ---------- panel wiring ----------
(() => {
  const saved = store.get("code", null);
  if (saved && typeof saved.code === "string") { $("codeLang").value = EXT[saved.language] ? saved.language : "python"; $("code").value = saved.code; }
  Code.syncButtons();
  $("codeBtn").addEventListener("click", () => Code.toggle());
  $("closeCode").addEventListener("click", () => Code.close());
  $("runCode").addEventListener("click", () => Code.run());
  $("playCode").addEventListener("click", () => Player.open("Preview", $("code").value, 8));
  $("clearOut").addEventListener("click", () => { Code.clearOutput(); Code.output = ""; });
  $("codeLang").addEventListener("change", () => { Code.save(); Code.syncButtons(); });
  let saveTimer = null;
  $("code").addEventListener("input", () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => Code.save(), 400); });
  $("code").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); Code.run(); return; }
    if (e.key === "Tab" && !e.shiftKey) {        // indent instead of leaving the editor (Esc, then Tab, moves on)
      e.preventDefault();
      const ta = e.target, s = ta.selectionStart;
      ta.setRangeText("    ", s, ta.selectionEnd, "end");
      ta.dispatchEvent(new Event("input"));
    }
  });
  $("codeMore").addEventListener("click", (e) => openMenu(e.currentTarget, [
    { label: "Stop running", run: () => Code.stop() },
    { label: "Copy code", run: () => navigator.clipboard.writeText($("code").value).then(() => toast("Copied")) },
    { label: "Download file", run: () => download(`ultron.${EXT[$("codeLang").value]}`, new Blob([$("code").value], { type: "text/plain" })) },
    { label: "Ask Ultron to explain it", run: () => ask("Explain the code in my editor.") },
    { label: "Clear editor", danger: true, run: () => { $("code").value = ""; Code.save(); Code.clearOutput(); Code.output = ""; } },
  ]));
})();
