"use strict";
// Accounts (sign up, log in, the user menu), the splash screen, the greeting,
// settings, and "sign up to unlock" prompts. The server enforces every limit;
// this only explains them.

const ICON_USER = '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';
const ICON_LOCK = '<svg class="i" viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const ICON_KEY = '<svg class="i" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/></svg>';
const ICON_ID = '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="12" r="2.5"/><path d="M14 10h4M14 14h4"/></svg>';
const ICON_CROWN = '<svg class="i" viewBox="0 0 24 24"><path d="m3 7 4.5 4L12 5l4.5 6L21 7l-2 11H5z"/><path d="M5 21h14"/></svg>';
const LOGO_GOOGLE = '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
const LOGO_APPLE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M16.37 12.6c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.72-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.88-.76-1.48.02-2.85.86-3.61 2.19-1.54 2.67-.39 6.63 1.11 8.8.73 1.06 1.6 2.25 2.75 2.2 1.1-.04 1.52-.71 2.85-.71 1.33 0 1.71.71 2.88.69 1.19-.02 1.94-1.08 2.66-2.14.84-1.23 1.19-2.42 1.21-2.48-.03-.01-2.32-.89-2.32-3.56zM14.2 6.13c.61-.74 1.02-1.76.91-2.78-.88.04-1.94.59-2.57 1.32-.56.65-1.06 1.69-.93 2.69.98.08 1.98-.5 2.59-1.23z"/></svg>';
const ICON_MAIL = '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>';
const ICON_EYE = '<svg class="i" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';

const Account = {
  // True if allowed; otherwise explains why and offers sign-up (guests) or Premium (members).
  require(reason, perm) {
    if (App.perms[perm]) return true;
    if (!App.user) this.open("signup", reason); else Premium.open(reason);
    return false;
  },

  open(tab = "login", reason = "") {
    const signup = tab === "signup", needsCode = App.config?.signup?.needs_code, open = App.config?.signup?.open !== false;
    const field = (iconHtml, attrs) => {
      const input = el("input", attrs);
      const wrap = el("label", { class: "field" }, frag(iconHtml), input);
      if (attrs.type === "password") wrap.append(el("button", { type: "button", class: "eye", title: "Show password", "aria-label": "Show password",
        onclick: () => { input.type = input.type === "password" ? "text" : "password"; } }, frag(ICON_EYE)));
      return wrap;
    };
    const err = el("div", { class: "form-error", role: "alert" });
    const submit = el("button", { class: "btn", type: "submit" }, signup ? "Sign Up" : "Login");
    const form = el("form", { onsubmit: (e) => this.submit(e, signup, err, submit) },
      signup && emailOn() ? field(ICON_MAIL, { name: "email", type: "email", placeholder: "Email (for password reset)", autocomplete: "email", "aria-label": "Email" }) : null,
      field(ICON_USER, { name: "username", placeholder: signup ? "Username" : "Username or email", autocomplete: "username", required: true, autofocus: true, "aria-label": signup ? "Username" : "Username or email" }),
      signup ? field(ICON_ID, { name: "name", placeholder: "Display name (optional)", autocomplete: "nickname", "aria-label": "Display name" }) : null,
      field(ICON_LOCK, { name: "password", type: "password", placeholder: signup ? "Password (8+ characters)" : "Password", autocomplete: signup ? "new-password" : "current-password", required: true, "aria-label": "Password" }),
      signup && needsCode ? field(ICON_KEY, { name: "code", placeholder: "Invite code", required: true, "aria-label": "Invite code" }) : null,
      err, submit);
    const box = el("div", { class: "box auth-split", role: "dialog", "aria-label": signup ? "Sign up" : "Log in" },
      authArt(signup),
      el("div", { class: "auth" },
        frag('<svg class="logo"><use href="#ultron-logo"/></svg>'),
        el("h2", { class: "wordmark" }, "ULTRON ", el("b", {}, "AI")),
        el("p", { class: "sub" }, signup ? "Create your account" : "Welcome back"),
        reason ? el("div", { class: "perks" }, "Sign up to ", el("b", {}, reason),
          ". A free account also unlocks saved chats, file attachments, image generation and levels 3 to 5.") : null,
        signup && !open ? el("p", { class: "form-error" }, "Sign-up is closed on this server.") : form,
        ...providerButtons(),
        el("p", { class: "swap" }, signup ? "Already have an account? " : "Don't have an account? ",
          el("button", { type: "button", onclick: () => this.open(signup ? "login" : "signup", reason) }, signup ? "Login" : "Sign Up")),
        signup ? null : emailOn()
          ? el("p", { class: "swap", style: "margin-top:6px" }, el("button", { type: "button", onclick: () => this.forgot() }, "Forgot password?"))
          : el("p", { class: "swap", style: "font-size:12px;margin-top:6px" }, "Forgot your password? Ask whoever runs this Ultron server.")));
    Modal.open(box);
  },

  async submit(e, signup, err, button) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    err.textContent = ""; button.disabled = true;
    try {
      const res = await fetch(signup ? "/api/signup" : "/api/login", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { err.textContent = body.error || "Something went wrong. Try again."; return; }
      Modal.close();
      await loadConfig();
      toast(signup ? `Welcome to Ultron, ${body.user.name}.` : `Welcome back, ${body.user.name}.`);
      if (Premium.pending) { Premium.pending = false; Premium.open(); }
    } catch { err.textContent = "Can't reach the server."; }
    finally { button.disabled = false; }
  },

  // Step 1: ask for a reset link.
  forgot() {
    const input = el("input", { name: "login", placeholder: "Username or email", autocomplete: "username", required: true, autofocus: true, "aria-label": "Username or email" });
    const err = el("div", { class: "form-error", role: "alert" });
    const btn = el("button", { class: "btn", type: "submit" }, "Send reset link");
    const body = el("div", { class: "auth" },
      frag('<svg class="logo"><use href="#ultron-logo"/></svg>'),
      el("h2", { style: "margin:10px 0 2px;font-size:20px" }, "Reset your password"),
      el("p", { class: "sub" }, "We'll email you a link to choose a new one."),
      el("form", { onsubmit: async (e) => {
        e.preventDefault(); err.textContent = ""; btn.disabled = true;
        try {
          const res = await fetch("/api/password/forgot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login: input.value }) });
          const out = await res.json().catch(() => ({}));
          if (!res.ok) { err.textContent = out.error || "Something went wrong."; return; }
          body.replaceChildren(frag('<svg class="logo"><use href="#ultron-logo"/></svg>'),
            el("h2", { style: "margin:10px 0 2px;font-size:20px" }, "Check your email"),
            el("p", { class: "sub" }, "If that account has an email address, a reset link is on its way. It works once, for the next hour. Check your spam folder if it doesn't arrive."),
            el("button", { class: "btn", onclick: () => Modal.close() }, "OK"));
        } catch { err.textContent = "Can't reach the server."; }
        finally { btn.disabled = false; }
      } }, el("label", { class: "field" }, frag(ICON_USER), input), err, btn),
      el("p", { class: "swap" }, el("button", { type: "button", onclick: () => this.open("login") }, "Back to log in")));
    Modal.open(el("div", { class: "box", role: "dialog", "aria-label": "Reset password" }, body));
  },

  // Step 2: the emailed link (/?reset=...) lands here.
  resetPassword(token) {
    const pw = el("input", { name: "password", type: "password", placeholder: "New password (8+ characters)", autocomplete: "new-password", required: true, autofocus: true, "aria-label": "New password" });
    const pw2 = el("input", { name: "password2", type: "password", placeholder: "Type it again", autocomplete: "new-password", required: true, "aria-label": "Repeat new password" });
    const err = el("div", { class: "form-error", role: "alert" });
    const btn = el("button", { class: "btn", type: "submit" }, "Save new password");
    Modal.open(el("div", { class: "box", role: "dialog", "aria-label": "Choose a new password" }, el("div", { class: "auth" },
      frag('<svg class="logo"><use href="#ultron-logo"/></svg>'),
      el("h2", { style: "margin:10px 0 2px;font-size:20px" }, "Choose a new password"),
      el("p", { class: "sub" }, "You'll be signed out on your other devices."),
      el("form", { onsubmit: async (e) => {
        e.preventDefault(); err.textContent = "";
        if (pw.value !== pw2.value) { err.textContent = "The two passwords don't match."; return; }
        btn.disabled = true;
        try {
          const res = await fetch("/api/password/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password: pw.value }) });
          const out = await res.json().catch(() => ({}));
          if (!res.ok) { err.textContent = out.error || "Something went wrong."; return; }
          Modal.close(); await loadConfig(); toast(`Password changed. Welcome back, ${out.user.name}.`);
        } catch { err.textContent = "Can't reach the server."; }
        finally { btn.disabled = false; }
      } }, el("label", { class: "field" }, frag(ICON_LOCK), pw), el("label", { class: "field" }, frag(ICON_LOCK), pw2), err, btn),
      el("p", { class: "swap" }, el("button", { type: "button", onclick: () => this.forgot() }, "Send a new link")))));
  },

  changeEmail() {
    const u = App.user;
    const email = el("input", { type: "email", value: u.email || "", placeholder: "you@example.com", required: true, autofocus: true, "aria-label": "Email" });
    const pw = u.has_password ? el("input", { type: "password", placeholder: "Current password", autocomplete: "current-password", required: true, "aria-label": "Current password" }) : null;
    const err = el("div", { class: "form-error", role: "alert" });
    Modal.open(el("div", { class: "box", role: "dialog", "aria-label": "Email address" },
      el("header", {}, el("h2", {}, u.email ? "Change email" : "Add an email"), el("button", { class: "icon-btn", "aria-label": "Close", onclick: () => Modal.close() }, "×")),
      el("form", { class: "body", onsubmit: async (e) => {
        e.preventDefault(); err.textContent = "";
        const res = await fetch("/api/account/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email.value, password: pw?.value || "" }) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) { err.textContent = out.error || "Something went wrong."; return; }
        Modal.close(); await loadConfig(); toast("Email saved.");
      } }, el("p", { class: "muted", style: "color:var(--dim);margin-top:0" }, "Used only for password reset links."),
        el("label", { class: "field" }, frag(ICON_MAIL), email), pw ? el("label", { class: "field" }, frag(ICON_LOCK), pw) : null, err,
        el("button", { class: "btn" }, "Save"))));
  },

  async logout() {
    await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
    Chat.reset();
    await loadConfig();
    toast("Logged out.");
  },

  settings() {
    const c = App.config || {};
    const check = (label, small, checked, onchange) => el("label", { class: "opt" },
      el("span", {}, label, el("small", {}, small)), el("input", { type: "checkbox", checked, onchange: (e) => onchange(e.target.checked) }));
    Modal.open(el("div", { class: "box settings", role: "dialog", "aria-label": "Settings" },
      el("header", {}, el("h2", {}, "Settings"), el("button", { class: "icon-btn", "aria-label": "Close", onclick: () => Modal.close() }, "×")),
      el("div", { class: "body" },
        check("Wake word", "Say “Ultron …” to talk hands-free. In Chrome and Edge, the microphone streams to the browser's speech service while this is on.", wakeEnabled, (v) => setWake(v)),
        check("Keep listening after replies", "After Ultron answers something you said, it listens for your reply without the wake word.", Voice.followUp, (v) => Voice.run("follow_up", v ? "on" : "off")),
        el("label", { class: "opt" }, el("span", {}, "Hand-gesture control", el("small", {}, "Open palm to wake, a fist to stop, thumbs up/down to confirm, peace sign for a new chat. Uses the camera, on-device only.")),
          el("input", { type: "checkbox", checked: Gesture.enabled, onchange: (e) => Gesture.toggle(e.target.checked) })),
        el("label", { class: "opt" }, el("span", {}, "Clap to wake", el("small", {}, "Clap to start talking, like saying “Ultron”. Two claps avoids false starts.")),
          el("span", { class: "row" },
            el("select", { "aria-label": "Clap to wake", onchange: (e) => Voice.setClap(e.target.value) },
              [["off", "Off"], ["single", "One clap"], ["double", "Two claps"]].map(([v, t]) => el("option", { value: v, selected: Voice.clapMode === v }, t))),
            el("select", { "aria-label": "Clap sensitivity", title: "Sensitivity", onchange: (e) => Clap.sensitivity(e.target.value) },
              [["low", "Low"], ["normal", "Normal"], ["high", "High"]].map(([v, t]) => el("option", { value: v, selected: Voice.clapSense === v }, t))))),
        check("Speak replies", "Read answers aloud. Say “mute” or “unmute” any time.", !muted, (v) => Voice.run("voice_output", v ? "on" : "off")),
        check("Market briefing on start", "Say the top trending crypto and stock out loud when Ultron opens. The Trending card always shows either way.", store.get("marketBrief", true), (v) => store.set("marketBrief", v)),
        el("label", { class: "opt" }, el("span", {}, "Voice commands", el("small", {}, "Everything you can do by voice. Or say “what can I say”.")),
          el("button", { class: "pill", onclick: () => Voice.showHelp() }, "Show")),
        check("Start screen", "Show the START screen when Ultron opens.", store.get("splash", true), (v) => store.set("splash", v)),
        el("label", { class: "opt" }, el("span", {}, "Voice", el("small", {}, c.tts === "kokoro" ? "Ultron’s neural voice, generated on the server" : "Your browser's built-in voice")), el("span", {})),
        App.user && c.billing?.enabled ? el("label", { class: "opt" }, el("span", {}, "Plan", el("small", {}, planLine())),
          App.user.plan === "premium" || App.user.has_billing
            ? el("button", { class: "pill", onclick: () => Premium.manage() }, "Manage subscription")
            : el("button", { class: "pill primary", onclick: () => Premium.open() }, "Go Premium")) : null,
        App.user ? el("label", { class: "opt" }, el("span", {}, "Email", el("small", {}, App.user.email || "Not set. Add one so you can reset your password.")),
          el("button", { class: "pill", onclick: () => this.changeEmail() }, App.user.email ? "Change" : "Add")) : null,
        el("label", { class: "opt" }, el("span", {}, "Account", el("small", {}, App.user
          ? `Signed in as @${App.user.username}` + (App.user.via !== "password" ? ` with ${App.user.via === "google" ? "Google" : "Apple"}` : "")
          : "Not signed in")),
          App.user ? el("button", { class: "pill", onclick: () => { Modal.close(); this.logout(); } }, "Log out")
            : el("button", { class: "pill primary", onclick: () => this.open("signup") }, "Sign up")))));
  },

  render() {
    const box = $("account"), u = App.user;
    if (!u) {
      box.replaceChildren(el("button", { class: "pill", "data-act": "login" }, "Log in"), el("button", { class: "pill primary", "data-act": "signup" }, "Sign up"));
    } else {
      const billingOn = App.config.billing?.enabled, premium = u.plan === "premium";
      const chip = el("button", { class: "userchip", "aria-label": "Account menu", onclick: () => openMenu(chip, [
        { note: `Signed in as @${u.username}` },
        billingOn && !premium ? { label: "👑 Upgrade to Premium", run: () => Premium.open() } : null,
        billingOn && (premium || u.has_billing) ? { label: "Manage subscription", run: () => Premium.manage() } : null,
        { label: "Settings", run: () => this.settings() },
        { label: "Log out", danger: true, run: () => this.logout() },
      ].filter(Boolean)) }, el("span", { class: "avatar" + (premium ? " gold" : "") }, (u.name || u.username)[0].toUpperCase()),
        el("span", { class: "tx" }, el("span", { class: "nm", style: "display:block" }, u.name),
          el("span", { class: "pl" + (premium ? " prem" : "") }, premium ? "👑 Premium" : billingOn ? "Free plan" : "Member")),
        frag('<svg class="i" viewBox="0 0 24 24" style="width:16px;height:16px;color:var(--dim)"><path d="m6 9 6 6 6-6"/></svg>'));
      box.replaceChildren(chip);
    }
    const h = new Date().getHours();
    $("greeting").textContent = (h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening") + (u ? `, ${u.name}` : "");
    renderUpsell();
    const card = $("sideCard"), img = App.config.images, billingOn = App.config.billing?.enabled;
    const credits = () => img.enabled ? [el("div", { class: "meter" }, el("i", { style: `width:${img.limit ? (img.left / img.limit) * 100 : 0}%` })),
      el("p", {}, `${img.left} of ${img.limit} images left · refills over ${img.window_hours} hours`)] : [];
    if (u && u.plan === "premium" && billingOn) {
      card.replaceChildren(el("span", { class: "spaced gold-text" }, "👑 Premium"),
        el("h3", {}, u.interval === "year" ? "Yearly plan" : "Monthly plan"), el("p", {}, planLine()), ...credits(),
        el("button", { class: "pill", style: "width:100%;justify-content:center", onclick: () => Premium.manage() }, "Manage subscription"));
    } else if (u && billingOn) {
      card.replaceChildren(el("span", { class: "spaced", style: "color:var(--red)" }, "👑 Premium"),
        el("h3", {}, "Upgrade to Premium"), el("p", {}, `${img.premium_limit} images every ${img.window_hours} hours, Genius and Max levels, and Opus 5.5.`),
        ...credits(),
        el("button", { class: "pill primary", style: "width:100%;justify-content:center", onclick: () => Premium.open() }, "Go Premium"));
    } else if (u && img.enabled) {
      card.replaceChildren(el("span", { class: "spaced", style: "color:var(--red)" }, "Image credits"),
        el("h3", {}, `${img.left} of ${img.limit} left`), ...credits());
    } else if (!u) {
      card.replaceChildren(el("span", { class: "spaced", style: "color:var(--red)" }, "Free account"),
        el("h3", {}, "Unlock everything"), el("p", {}, "Images, files, saved chats and levels 3 to 5."),
        el("button", { class: "pill primary", "data-act": "signup", style: "width:100%;justify-content:center" }, "Sign up free"));
    }
  },
};
// The robot close-up beside the log-in / sign-up form: slow drift, pulsing eye, scanlines.
function authArt(signup) {
  return el("div", { class: "auth-art", "aria-hidden": "true" },
    el("div", { class: "pic" }), el("div", { class: "eye" }), el("div", { class: "scan" }),
    el("div", { class: "caption" },
      el("span", { class: "spaced" }, "Ultron AI"),
      el("b", {}, signup ? "Join the network." : "Your mind. Amplified."),
      el("i")));
}

const emailOn = () => !!App.config?.email?.enabled;

// "Continue with Google / Apple", shown only for providers the server has configured.
function providerButtons() {
  const o = App.config?.oauth || {};
  const go = (p) => { if (Premium.pending) try { sessionStorage.setItem("ultron.premiumAfterAuth", "1"); } catch {} location.href = "/auth/" + p; };
  const btns = [
    o.google ? el("button", { type: "button", class: "social", onclick: () => go("google") }, frag(LOGO_GOOGLE), "Continue with Google") : null,
    o.apple ? el("button", { type: "button", class: "social", onclick: () => go("apple") }, frag(LOGO_APPLE), "Continue with Apple") : null,
  ].filter(Boolean);
  return btns.length ? [el("div", { class: "or" }, "or"), ...btns] : [];
}

// Back from Google/Apple: the server has already signed us in (or explains why not).
function handleAuthReturn() {
  const q = new URLSearchParams(location.search);
  const reset = q.get("reset");
  if (reset) { history.replaceState(null, "", location.pathname); Account.resetPassword(reset); return; }
  const ok = q.get("auth"), err = q.get("auth_error");
  if (!ok && !err) return;
  history.replaceState(null, "", location.pathname);
  if (err) { toast(err, 6000); Account.open("login"); return; }
  if (App.user) toast(`Welcome, ${App.user.name}.`);
  let again = false;
  try { again = sessionStorage.getItem("ultron.premiumAfterAuth") === "1"; sessionStorage.removeItem("ultron.premiumAfterAuth"); } catch {}
  if (again) Premium.open();
}

function planLine() {
  const u = App.user;
  if (!u || u.plan !== "premium") return u?.has_billing ? "Free plan (subscription ended)" : "Free plan";
  if (!u.renews) return "Premium";
  const d = new Date(u.renews * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return u.cancels ? `Premium until ${d} (won't renew)` : `Renews ${d}`;
}

// The home page banner: sign up (guests) or go Premium (free accounts).
function renderUpsell() {
  const box = $("upsell"), u = App.user, c = App.config, billingOn = c.billing?.enabled;
  const show = !u || (billingOn && u.plan !== "premium");
  box.hidden = !show;
  if (!show) return;
  const [title, text, btn, perks] = !u
    ? ["UNLOCK THE FULL POWER", "Create a free account to save your chats, attach files, generate images and use smarter levels.",
       el("button", { class: "pill primary", "data-act": "signup" }, "Create free account"),
       ["Image generation", billingOn ? "Levels 1 to 3" : "Levels 1 to 5 and model choice", "Pictures, PDFs, files and videos", "Saved chat history"]]
    : ["UNLOCK THE FULL POWER", "Get more images, premium models, the smartest levels and more.",
       el("button", { class: "pill primary", onclick: () => Premium.open() }, frag(ICON_CROWN), "Upgrade to Premium"),
       [`${c.images.premium_limit} images every ${c.images.window_hours} hours`, "Genius and Max levels", "Opus 5.5, the newest model", "Everything in the free plan"]];
  box.replaceChildren(
    el("div", {}, el("h3", {}, el("b", {}, title[0]), title.slice(1)), el("p", {}, text), btn),
    el("ul", {}, perks.map(p => el("li", {}, p))));
}

// ---------- Premium (Stripe) ----------
const Premium = {
  pending: false,   // "Subscribe" pressed while logged out: reopen after sign-up

  open(reason = "") {
    const c = App.config;
    if (!c?.billing?.enabled) { toast("Premium isn't available on this server."); return; }
    if (App.user?.plan === "premium") { this.manage(); return; }
    const img = c.images, plans = c.billing.plans;
    const names = { monthly: "Monthly", yearly: "Yearly" }, per = { month: "/ month", year: "/ year" };
    const cards = plans.map(p => {
      const btn = el("button", { class: p.id === "monthly" ? "btn" : "btn ghost", onclick: () => this.subscribe(p.id, btn) }, "Subscribe");
      return el("div", { class: "plan" }, p.save ? el("span", { class: "save" }, p.save) : null,
        el("div", { class: "nm" }, names[p.id] || p.id), el("div", { class: "amt" }, p.price), el("div", { class: "per" }, per[p.interval] || ""), btn);
    });
    Modal.open(el("div", { class: "box premium", role: "dialog", "aria-label": "Go Premium" },
      el("div", { class: "auth" },
        el("div", { class: "crown" }, frag(ICON_CROWN)),
        el("h2", { style: "margin:0;font-size:24px" }, "Go Premium"),
        el("p", { class: "sub" }, "Unlock the full power of Ultron AI"),
        reason ? el("div", { class: "perks" }, "Premium lets you ", el("b", {}, reason), ".") : null,
        el("ul", { class: "checks" },
          el("li", {}, `${img.premium_limit} images every ${img.window_hours} hours (free: ${img.free_limit})`),
          el("li", {}, "Levels 4 and 5: Genius and Max reasoning"),
          el("li", {}, "Opus 5.5, the newest model"),
          el("li", {}, "Everything in the free plan")),
        cards.length ? el("div", { class: "plans" }, cards)
          : el("p", { class: "form-error" }, "Prices aren't set up yet. The server owner needs to run setup_stripe.py."),
        el("p", { class: "swap", style: "font-size:12.5px" }, "Cancel anytime. Secure payment by Stripe."))));
  },

  async subscribe(plan, btn) {
    if (!App.user) { this.pending = true; Account.open("signup", "go Premium"); return; }
    btn.disabled = true; btn.textContent = "Opening Stripe…";
    try {
      const res = await fetch("/api/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      location.href = body.url;
    } catch (err) {
      toast(err.message || "Couldn't reach Stripe.", 5000);
      btn.disabled = false; btn.textContent = "Subscribe";
    }
  },

  async manage() {
    try {
      const res = await fetch("/api/billing/portal", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      location.href = body.url;
    } catch (err) { toast(err.message || "Couldn't reach Stripe.", 5000); }
  },

  // Back from Stripe Checkout: confirm right away instead of waiting for the webhook.
  async handleReturn() {
    const q = new URLSearchParams(location.search), result = q.get("billing");
    if (!result) return;
    history.replaceState(null, "", location.pathname);
    if (result === "cancel") { toast("Checkout cancelled. You weren't charged."); return; }
    if (result !== "success" || !App.user) return;
    let plan = null;
    try {
      const res = await fetch("/api/billing/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: q.get("session_id") }) });
      plan = (await res.json()).plan;
    } catch {}
    for (let i = 0; i < 5 && plan !== "premium"; i++) {         // the webhook may land a moment later
      await new Promise(r => setTimeout(r, 2000));
      await loadConfig(); plan = App.user?.plan;
    }
    await loadConfig();
    if (plan === "premium") { toast("Welcome to Premium 👑", 5000); flare = 2; }
    else toast("Payment received. Premium will switch on in a moment.", 6000);
  },
};

// Artwork: static/art/<slot>.jpg (etc.) if present, otherwise the built-in robot.
function applyArt() {
  const art = App.config?.art;
  if (!art) return;
  const root = document.documentElement.style;
  for (const slot of ["splash", "hero", "card", "banner", "login"]) root.setProperty(`--art-${slot}`, `url("${art[slot]}")`);
  $("splash").classList.toggle("custom-art", art.custom.includes("splash"));
  document.querySelector("#homeView .hero-art")?.classList.toggle("custom", art.custom.includes("hero"));
  for (const [box, cls, slot] of [[$("sideCard"), "card-art", "card"], [$("upsell"), "banner-art", "banner"]]) {
    if (!box.querySelector("." + cls)) box.prepend(el("div", { class: "art " + cls, "aria-hidden": "true" }));
    box.querySelector("." + cls).classList.toggle("custom", art.custom.includes(slot));
  }
}

{ const render = Account.render; Account.render = function () { render.call(this); applyArt(); }; }   // keep the art after re-renders

let returnHandled = false;
onConfig(() => {
  Account.render();
  if (!returnHandled) { returnHandled = true; Premium.handleReturn(); handleAuthReturn(); }
});

// ---------- splash ----------
(() => {
  let seen = false;
  try { seen = sessionStorage.getItem("ultron.splash") === "1"; } catch {}
  if (seen || !store.get("splash", true) || /[?&](billing|auth|auth_error|reset)=/.test(location.search)) return;
  const s = $("splash");
  s.hidden = false;
  $("startBtn").focus();
  $("startBtn").addEventListener("click", () => {
    try { sessionStorage.setItem("ultron.splash", "1"); getAudioCtx(); } catch {}
    s.classList.add("leaving");
    setTimeout(() => { s.hidden = true; $("text").focus(); }, 500);
  });
})();
