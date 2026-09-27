"use strict";
// The current conversation (transcript + what's sent to Claude), saved chats,
// the image viewer and the image gallery.

const logoSvg = () => frag('<svg class="logo"><use href="#ultron-logo"/></svg>');
function ago(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
const KEEP_FILES_TURNS = 3;   // older attachments are dropped from what's re-sent, to keep requests small

// ---------- the conversation ----------
const Chat = {
  id: null, title: "", starred: false,
  history: [],     // what Claude sees: [{role, content}]
  log: [],         // what the transcript shows: messages plus images, code and animations
  liveEl: null, sealed: 0, saving: Promise.resolve(),

  addUser(content, text, meta, { switchView = true } = {}) {
    this.history.push({ role: "user", content });
    const entry = { role: "user", text, files: meta };
    this.log.push(entry);
    if (!this.title) this.title = (text || meta.map(f => f.name).join(", ")).slice(0, 60) || "New chat";
    $("chatTitle").textContent = this.title;
    // A voice conversation stays on the orb -- home, code, wherever you were -- instead of
    // jumping to the text transcript. It's still saved; say "show the chat" to see it.
    if (switchView) View.show("chat");
    this.render(entry);
    this.sealed = 0;
    this.liveEl = this.renderAssistant(null);
    this.scrollToEnd();
  },
  streamReply(text) {
    if (!this.liveEl) this.liveEl = this.renderAssistant(null);
    this.liveEl.querySelector(".bubble").textContent = text.slice(this.sealed);
    this.scrollToEnd(true);
  },
  addAssistant(raw) {
    this.history.push({ role: "assistant", content: raw });
    this.log.push({ role: "assistant", text: stripTags(raw) });
    if (this.liveEl?.querySelector(".typing")) this.liveEl.remove();
    this.liveEl = null;
  },
  addArtifact(a) {
    this.log.push(a);
    const typingOnly = this.liveEl?.querySelector(".typing");
    if (this.liveEl && !typingOnly) { this.sealed = stripTags(lastReply).length; this.liveEl = null; }
    const node = this.render(a);
    if (typingOnly) $("transcript").append(this.liveEl);   // keep the "typing" dots after the card
    node.scrollIntoView({ block: "nearest" });
  },
  dropLastUser() {
    const last = this.history.at(-1);
    if (last?.role !== "user") return;
    this.history.pop();
    const i = this.log.map(e => e.role).lastIndexOf("user");
    const entry = this.log[i];
    this.log.splice(i, 1);
    entry?.el?.remove();
    if (this.liveEl?.querySelector(".typing")) { this.liveEl.remove(); this.liveEl = null; }
    if (entry?.text && !$("text").value) { $("text").value = entry.text; autogrow(); }   // so it can be re-sent
  },
  notice(msg) {
    if (this.liveEl?.querySelector(".typing")) { this.liveEl.remove(); this.liveEl = null; }
    const n = el("div", { class: "msg assistant notice" }, logoSvg(), el("div", { class: "bubble" }, msg));
    $("transcript").append(n); this.scrollToEnd();
  },

  renderAssistant(text) {
    const bubble = el("div", { class: "bubble" });
    if (text === null) bubble.append(el("span", { class: "typing", "aria-label": "Ultron is thinking" }, el("i"), el("i"), el("i")));
    else bubble.textContent = text;
    const n = el("div", { class: "msg assistant" }, logoSvg(), bubble);
    $("transcript").append(n);
    return n;
  },
  render(e) {
    let n;
    if (e.role === "user") {
      const files = e.files?.length ? el("div", { class: "files" }, e.files.map(f =>
        f.thumb ? el("img", { src: f.thumb, alt: f.name, title: f.name }) : el("span", {}, "📎 " + f.name))) : null;
      n = el("div", { class: "msg user" }, el("div", { class: "bubble" }, files, e.text || ""));
    } else if (e.role === "assistant") {
      n = this.renderAssistant(e.text); return n;
    } else if (e.role === "image") {
      n = el("div", { class: "artifact" },
        el("img", { src: e.url, alt: e.prompt, title: "View", onclick: () => Media.showImage(e.url, e.prompt) }),
        el("div", {}, el("div", { class: "t" }, "Generated image"), el("div", { class: "s" }, e.prompt)));
    } else if (e.role === "code") {
      const lines = e.code.split("\n").length;
      n = el("div", { class: "artifact" }, el("span", { class: "ic" }, frag(icon("code"))),
        el("div", {}, el("div", { class: "t" }, `Code · ${e.language}`), el("div", { class: "s" }, `${lines} lines, in the editor`)),
        el("button", { class: "pill", onclick: () => Code.load(e.language, e.code, { open: true }) }, "Open"));
    } else if (e.role === "animation") {
      n = el("div", { class: "artifact" }, el("span", { class: "ic" }, frag(icon("video"))),
        el("div", {}, el("div", { class: "t" }, e.title), el("div", { class: "s" }, "Animation")),
        el("button", { class: "pill primary", onclick: () => Player.open(e.title, e.html, e.seconds) }, "▶ Play"));
    } else return null;
    e.el = n;
    $("transcript").append(n);
    return n;
  },
  scrollToEnd(onlyIfNear = false) {
    const v = $("transcript");
    if (onlyIfNear && v.scrollHeight - v.scrollTop - v.clientHeight > 160) return;
    requestAnimationFrame(() => { v.scrollTop = v.scrollHeight; });
  },

  // Old attachments stay in the transcript but aren't re-sent every turn.
  apiHistory() {
    const withFiles = this.history.map((m, i) => Array.isArray(m.content) && m.content.some(b => b.type !== "text") ? i : -1).filter(i => i >= 0);
    const keep = new Set(withFiles.slice(-KEEP_FILES_TURNS));
    return this.history.map((m, i) => !withFiles.includes(i) || keep.has(i) ? m : {
      role: m.role,
      content: [...m.content.filter(b => b.type === "text"), { type: "text", text: "[Earlier attachments from this message are no longer included.]" }],
    });
  },

  reset() {
    interrupt();
    Object.assign(this, { id: null, title: "", starred: false, history: [], log: [], liveEl: null, sealed: 0 });
    if (typeof Voice !== "undefined") Voice.tutor = false;
    $("transcript").replaceChildren();
    $("chatTitle").textContent = "New chat";
    Chats.render();
    View.show("home");
  },
  async load(id) {
    try {
      const res = await fetch(`/api/chats/${id}`);
      if (!res.ok) throw new Error();
      const c = await res.json();
      interrupt();
      Object.assign(this, { id: c.id, title: c.title, starred: !!c.starred, history: c.messages || [], log: c.log || [], liveEl: null });
      $("transcript").replaceChildren();
      for (const e of this.log) this.render(e);
      $("chatTitle").textContent = this.title;
      Chats.closeDrawer(); View.show("chat"); Chats.render();
    } catch { toast("Couldn't open that chat."); }
  },
  save() {
    if (!App.perms.saved_chats || !this.history.length) return;
    const body = JSON.stringify({
      title: this.title, starred: this.starred, messages: this.history,
      log: this.log.map(({ el: _el, ...rest }) => rest),
    });
    this.saving = this.saving.then(async () => {
      try {
        const res = await fetch(this.id ? `/api/chats/${this.id}` : "/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body });
        if (!res.ok) throw new Error(res.status);
        this.id = (await res.json()).id;
        Chats.refresh();
      } catch { toast("Couldn't save this chat."); }
    });
  },
};

// ---------- saved chats ----------
const Chats = {
  list: [], starOnly: false,

  async refresh() {
    if (!App.user) { this.list = []; this.render(); return; }
    try { this.list = await (await fetch("/api/chats")).json(); } catch { this.list = []; }
    this.render();
  },
  openDrawer(query = "") {
    $("chatsPanel").hidden = false;
    if (query) $("chatSearch").value = query;
    this.render(); $("chatSearch").focus();
  },
  closeDrawer() { $("chatsPanel").hidden = true; },

  render() {
    const recent = $("recentChats"), list = $("chatList");
    if (!App.user) {
      const cta = () => el("div", { class: "empty" }, "Log in to save your chats and pick them up later.",
        el("div", { class: "row" }, el("button", { class: "pill", "data-act": "login" }, "Log in"), el("button", { class: "pill primary", "data-act": "signup" }, "Sign up")));
      recent.replaceChildren(el("li", {}, cta()));
      list.replaceChildren(el("li", {}, cta()));
      return;
    }
    const row = (c) => el("button", { class: "item", onclick: () => Chat.load(c.id) },
      el("span", { class: "ic" }, logoSvg()),
      el("span", { class: "tx" }, el("span", { class: "t" }, c.title), el("span", { class: "s" }, c.starred ? "★ Starred" : "Chat")),
      el("span", { class: "when" }, ago(c.viewed || c.updated)));
    recent.replaceChildren(...(this.list.length ? this.list.slice(0, 5).map(c => el("li", {}, row(c)))
      : [el("li", { class: "empty" }, "No chats yet. Say hello!")]));

    const q = $("chatSearch").value.trim().toLowerCase();
    const shown = this.list.filter(c => (!this.starOnly || c.starred) && (!q || c.title.toLowerCase().includes(q)));
    list.replaceChildren(...(shown.length ? shown.map(c => el("li", { class: c.id === Chat.id ? "current" : "" },
      el("button", { class: "open", onclick: () => Chat.load(c.id) },
        el("span", { class: "t" }, c.title), el("span", { class: "w" }, "Last viewed " + ago(c.viewed || c.updated))),
      el("button", { class: "star", "aria-pressed": String(!!c.starred), title: c.starred ? "Unstar" : "Star", "aria-label": "Star", onclick: () => this.meta(c.id, { starred: !c.starred }) }, "★"),
      el("button", { class: "more", title: "More", "aria-label": "More", onclick: (e) => openMenu(e.currentTarget, [
        { label: "Rename", run: () => this.rename(c) },
        { label: "Delete", danger: true, run: () => this.remove(c) },
      ]) }, "⋯")))
      : [el("li", { class: "empty" }, q || this.starOnly ? "No matching chats." : "No saved chats yet.")]));
  },

  async meta(id, patch) {
    try {
      await fetch(`/api/chats/${id}/meta`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      if (id === Chat.id) { if (patch.title) { Chat.title = patch.title; $("chatTitle").textContent = patch.title; } if ("starred" in patch) Chat.starred = patch.starred; }
      this.refresh();
    } catch { toast("Couldn't update that chat."); }
  },
  rename(c) {
    const input = el("input", { value: c.title, maxlength: "120", "aria-label": "Chat name", autofocus: true });
    const form = el("form", { class: "body", onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) this.meta(c.id, { title: v }); Modal.close(); } },
      el("label", { class: "field" }, input), el("button", { class: "btn" }, "Save"));
    Modal.open(el("div", { class: "box" }, el("header", {}, el("h2", {}, "Rename chat")), form));
    input.select();
  },
  remove(c) {
    Modal.open(el("div", { class: "box" }, el("header", {}, el("h2", {}, "Delete chat?")),
      el("div", { class: "body" }, el("p", {}, `“${c.title}” will be deleted for good.`),
        el("div", { class: "row" }, el("button", { class: "pill", onclick: () => Modal.close() }, "Cancel"), el("span", { class: "spacer" }),
          el("button", { class: "pill primary", autofocus: true, onclick: async () => {
            Modal.close();
            await fetch(`/api/chats/${c.id}`, { method: "DELETE" });
            if (c.id === Chat.id) Chat.reset();
            this.refresh();
          } }, "Delete")))));
  },
};

$("closeChart")?.addEventListener("click", () => Markets.closeChart());
$("newChatBtn").addEventListener("click", () => { Chats.closeDrawer(); Chat.reset(); });
$("closeChats").addEventListener("click", () => Chats.closeDrawer());
$("chatSearch").addEventListener("input", () => Chats.render());
$("starFilter").addEventListener("click", (e) => { Chats.starOnly = !Chats.starOnly; e.currentTarget.setAttribute("aria-pressed", String(Chats.starOnly)); Chats.render(); });
$("topSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") { Chats.openDrawer(e.target.value); e.target.value = ""; } });
onConfig(() => Chats.refresh());

// ---------- markets: trending crypto and stocks, loaded on startup (no chat, no voice needed) ----------
// A tiny inline sparkline for a market row: no library, just a normalised polyline.
function sparkSVG(points, up) {
  if (!points || points.length < 2) return el("span", { class: "spark" });
  const lo = Math.min(...points), hi = Math.max(...points), span = hi - lo || 1;
  const pts = points.map((v, i) => `${(i / (points.length - 1) * 100).toFixed(1)},${(20 - (v - lo) / span * 18 - 1).toFixed(1)}`).join(" ");
  return frag(`<svg class="spark ${up === false ? "down" : "up"}" viewBox="0 0 100 20" preserveAspectRatio="none"><polyline points="${pts}"/></svg>`);
}

const Markets = {
  interval: null, data: null,

  async load() {
    try {
      const r = await fetch("/api/markets");
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      this.data = data;
      this.render(data);
      return data;
    } catch {
      $("marketsList").replaceChildren(el("li", { class: "empty" }, "Couldn't reach the market right now."));
      return null;
    }
  },

  // Find a trending row by name or symbol, for "open the bitcoin chart".
  find(query) {
    const q = (query || "").trim().toLowerCase();
    if (!q) return null;
    const rows = [...(this.data?.crypto || []).map(c => ({ ...c, kind: "Crypto" })),
                  ...(this.data?.stocks || []).map(c => ({ ...c, kind: "Stock" }))];
    return rows.find(r => r.symbol?.toLowerCase() === q) || rows.find(r => r.name?.toLowerCase().includes(q))
      || rows.find(r => q.includes(r.name?.toLowerCase()) || q.includes(r.symbol?.toLowerCase())) || null;
  },

  // A bigger line chart for one row, in a modal: "open the bitcoin chart".
  // TradingView resolves plain US tickers on its own; crypto needs a quote currency to find a market.
  tvSymbol(row) { return row.kind === "Crypto" ? `${row.symbol}USD` : row.symbol; },

  openChart(query) {
    const row = this.find(query);
    if (!row) return `I don't have a chart for ${query || "that"} right now -- it isn't in today's trending list.`;
    const up = row.change_pct == null ? null : row.change_pct >= 0;
    const symbol = this.tvSymbol(row);
    Modal.close();
    $("chartTitle").textContent = `${row.name} · ${row.kind}`;
    $("chartHead").replaceChildren(
      el("span", { class: "chart-price" }, row.price == null ? "—" : "$" + row.price.toLocaleString()),
      up === null ? null : el("span", { class: "chg " + (up ? "up" : "down") }, (up ? "▲ " : "▼ ") + Math.abs(row.change_pct) + "%"),
      el("span", { class: "muted", style: "color:var(--dim);font-size:11px" }, "Live · TradingView"));
    $("chartFrame").title = row.name + " live chart";
    $("chartFrame").src = `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(symbol)}&interval=15&theme=dark&style=1&locale=en&hidevolume=0&hidelegend=0&hide_top_toolbar=0&hide_side_toolbar=0&withdateranges=1&studies=%5B%5D`;
    $("chartView").hidden = false;
    document.body.classList.add("chart-open");
    return "";
  },

  closeChart() {
    $("chartView").hidden = true;
    document.body.classList.remove("chart-open");
    $("chartFrame").src = "about:blank";   // stop the live stream while it's closed
  },

  render(data) {
    const rows = [
      ...(data.crypto || []).map(c => ({ ...c, kind: "Crypto" })),
      ...(data.stocks || []).map(c => ({ ...c, kind: "Stock" })),
    ];
    if (!rows.length) {
      $("marketsList").replaceChildren(el("li", { class: "empty" }, "The market feeds aren't reachable right now."));
      return;
    }
    $("marketsList").replaceChildren(...rows.map(c => {
      const up = c.change_pct == null ? null : c.change_pct >= 0;
      return el("li", { class: "row" },
        el("span", { class: "sym" }, (c.symbol || c.name || "?").slice(0, 4)),
        el("span", { class: "tx" }, el("span", { class: "name" }, c.name || c.symbol), el("span", { class: "kind" }, c.kind)),
        sparkSVG(c.spark, up),
        el("span", { class: "num" },
          el("span", { class: "price" }, c.price == null ? "—" : (c.kind === "Crypto" && c.price < 1 ? "$" + c.price : "$" + c.price.toLocaleString())),
          up === null ? null : el("span", { class: "chg " + (up ? "up" : "down") }, (up ? "▲ " : "▼ ") + Math.abs(c.change_pct) + "%")));
    }));
    $("marketsRefreshed").textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  },

  // A short spoken line the first time Ultron starts up in a session -- "shows me the market" visually
  // always happens (the card above); this adds the "and tells me" part, once, quietly.
  briefLine(data) {
    const top = (data.crypto || [])[0], stock = (data.stocks || [])[0];
    if (!top && !stock) return null;
    const say = (c) => `${c.name} ${c.change_pct == null ? "" : (c.change_pct >= 0 ? "up" : "down") + " " + Math.abs(c.change_pct) + " percent"}`;
    const bits = [top && `${say(top)} in crypto`, stock && `${say(stock)} in stocks`].filter(Boolean);
    return `Markets are up. ${bits.join(", and ")} trending right now.`;
  },
};

(async () => {
  const data = await Markets.load();
  Markets.interval = setInterval(() => Markets.load(), 90000);
  let brand = false;
  try { brand = !sessionStorage.getItem("ultron.marketBrief"); sessionStorage.setItem("ultron.marketBrief", "1"); } catch {}
  if (brand && data && store.get("marketBrief", true)) {
    const line = Markets.briefLine(data);
    if (line) { await bootReady; voiceTurn = false; speak(line, "calm"); }
  }
})();


// ---------- images ----------
const Media = {
  last: null,   // { url, prompt } of the most recently generated image, for the hologram viewer

  showImage(url, prompt, left = null) {
    Media.last = { url, prompt };
    const info = left !== null && App.config ? `${left} of ${App.config.images.limit} images left in this ${App.config.images.window_hours}-hour window` : "";
    Modal.open(el("div", { class: "box wide", role: "dialog", "aria-label": "Image" },
      el("header", {}, el("h2", {}, "Generated image"), el("span", { class: "muted", style: "color:var(--dim);font-size:13px" }, info),
        el("a", { class: "pill primary", href: url, download: "ultron-image.png" }, "Download"),
        el("button", { class: "icon-btn", "aria-label": "Close", onclick: () => Modal.close() }, "×")),
      el("div", { class: "body" }, el("img", { class: "full", src: url, alt: prompt }),
        el("p", { style: "color:var(--dim);text-align:center;margin:12px 0 0" }, prompt))));
  },
};

const Gallery = {
  async load() {
    const c = App.config, q = $("imageQuota"), g = $("gallery");
    if (!App.user) {
      q.textContent = "Create a free account to generate images.";
      g.replaceChildren(el("div", { class: "empty" }, el("button", { class: "pill primary", "data-act": "signup" }, "Sign up free")));
      return;
    }
    q.textContent = !c.images.enabled ? "Image generation isn't set up on this server (it needs an OpenAI API key)."
      : c.images.limit > 0 ? `${c.images.left} of ${c.images.limit} images left · the limit resets over a rolling ${c.images.window_hours}-hour window`
      : "Unlimited images.";
    try {
      const items = await (await fetch("/api/images")).json();
      g.replaceChildren(...(items.length ? items.map(i => el("figure", { onclick: () => Media.showImage(i.url, i.prompt) },
        el("img", { src: i.url, alt: i.prompt, loading: "lazy" }), el("figcaption", {}, i.prompt || ago(i.created))))
        : [el("div", { class: "empty" }, "Your generated images will appear here.")]));
    } catch { g.replaceChildren(); }
  },
};
$("genForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!Account.require("generate images", "images")) return;
  const p = $("genPrompt").value.trim();
  if (!p) { $("genPrompt").focus(); return; }
  $("genPrompt").value = "";
  ask(`Generate an image (${$("genShape").value}): ${p}`);
});
