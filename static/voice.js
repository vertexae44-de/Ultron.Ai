"use strict";
// Hands-free control. Everything said aloud comes through Voice.route():
//   - app commands ("open the code editor", "level four", "new chat") run instantly in the browser
//   - anything else goes to Claude, which can also operate the app through its control_app tool
// Plus clap-to-wake: a small audio worklet listens for the sharp spike of a hand clap.

const WORD_NUM = { one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, tree: 3, four: 4, for: 4, fore: 4, five: 5 };
const SHAPES_HINT = new Set(["core", "sphere", "ball", "orb", "cube", "box", "pyramid", "cone", "torus", "donut", "cylinder", "diamond", "star"]);
const LEVEL_NAMES = { quick: 1, fast: 1, balanced: 2, smart: 3, genius: 4, max: 5, maximum: 5 };

// Normalise what the recognizer heard: "Please, open the Code Editor." -> "open the code editor"
function norm(text) {
  return text.toLowerCase()
    .replace(/[.,!?;:"“”]/g, " ")
    .replace(/\s+/g, " ").trim()
    .replace(/^(?:(?:hey|ok|okay|ultron|please|can you|could you|would you|will you|go ahead and|i want to|i'd like to|let's)\s+)+/, "")
    .replace(/\s+(?:please|for me|now|thanks|thank you)$/, "")
    .trim();
}

function modelFor(said) {
  if (/sonnet/.test(said)) return "claude-sonnet-5";
  if (/opus/.test(said)) return /5\s*\.?\s*5\b|five point five/.test(said) ? "claude-opus-5-5" : "claude-opus-5";
  return null;
}

function scrollTarget() {
  if (View.current === "chat") return $("transcript");
  return document.querySelector(".view.active");
}

// Spoken commands: [pattern, handler(match) -> what to say (or "" to stay quiet)].
// Order matters: the first match wins.
const COMMANDS = [
  [/^(?:stop|cancel|never ?mind|be quiet|quiet|shush|shut up|silence|enough|that's enough|stop talking|stop the (?:alarm|timer))$/,
    () => { interrupt(); return ""; }],
  [/^(?:what can i say|help|voice commands|commands|show (?:me )?(?:the )?(?:voice )?commands|what can you do)$/,
    () => Voice.run("show_voice_commands")],
  [/^(?:(?:start |open |make )?(?:a )?new (?:chat|conversation)|start over|clear (?:the )?(?:chat|conversation)|reset(?: the)? chat)$/,
    () => Voice.run("new_chat")],
  [/^(?:(?:go |take me )?(?:back )?home|(?:go to|open|show)(?: the)? (?:home|dashboard)(?: page| screen)?)$/,
    () => Voice.run("show_home")],
  [/^(?:open|show|go to|back to)(?: the| my)? (?:chat|conversation|transcript)$/,
    () => Voice.run("show_chat")],
  [/^(?:open|show|go to|view)(?: the| my)? (?:images|image gallery|gallery|pictures|photos|generated images)$/,
    () => Voice.run("show_images")],
  [/^(?:open|show)(?: the| my)? (?:code|editor|code editor|code panel)$/, () => Voice.run("open_code")],
  [/^(?:close|hide)(?: the| my)? (?:code|editor|code editor|code panel)$/, () => Voice.run("close_code")],
  [/^(?:(?:run|execute|preview)(?: (?:it|this|that|the code|my code|the program|the script|the page))?|test (?:it|the code|my code))$/, () => Voice.run("run_code")],
  [/^stop (?:the |my )?(?:code|program|script|running)$/, () => Voice.run("stop_code")],
  [/^(?:open|show|find|load)(?: my| the)? (?:last|latest|previous|recent|most recent) (?:chat|conversation)$/,
    () => Voice.run("open_chat", "")],
  [/^(?:open|find|load|show)(?: my| the)? (?:chat|conversation) (?:about|called|named|on|with) (.+)$/,
    (m) => Voice.run("open_chat", m[1])],
  [/^(?:open|show)(?: my| the)? (?:chats|chat history|history|saved chats|conversations|old chats)$/,
    () => Voice.run("open_chats")],
  [/^(?:search|find)(?: my)? (?:chats|conversations) (?:for|about) (.+)$/, (m) => Voice.run("open_chats", m[1])],
  [/^(?:(?:set|switch|change|put|turn)(?: it)?(?: the)? (?:level|effort)(?: up| down)? to|(?:switch|change|go|move) to level|use level|level) (\w+)$/, (m) => Voice.run("set_level", m[1])],
  [/^(?:switch to |use |go )?(quick|fast|balanced|smart|genius|max|maximum) mode$/, (m) => Voice.run("set_level", m[1])],
  [/^(?:level up|think harder|be smarter|smarter|more effort|higher level)$/, () => Voice.run("set_level", String(Composer.levelNum() + 1))],
  [/^(?:level down|be quicker|quicker|faster|less effort|lower level)$/, () => Voice.run("set_level", String(Composer.levelNum() - 1))],
  [/^(?:use|switch to|change to|select|pick)(?: the)?(?: model)? ((?:claude )?(?:opus|sonnet).*)$/, (m) => Voice.run("set_model", m[1])],
  [/^what (?:level|model)(?: am i on| is (?:this|it|selected)| are you(?: on| using)?)?$/, () => {
    const l = Composer.levelNum(), m = App.config?.models?.find(x => x.id === Composer.model());
    return `Level ${l}, ${LEVELS[l - 1].name}, on ${m ? m.label : "the default model"}.`;
  }],
  [/^(?:open |show )?(?:the )?settings$/, () => Voice.run("open_settings")],
  [/^(?:log ?in|sign ?in|let me log in|let me sign in)$/, () => Voice.run("log_in")],
  [/^(?:sign ?up|create (?:an |my )?account|register|make (?:an |me an )?account)$/, () => Voice.run("sign_up")],
  [/^(?:log ?out|sign ?out|log me out|sign me out)$/, () => Voice.run("log_out")],
  [/^(?:go to sleep|stop listening|sleep|turn off (?:the )?wake word|wake word off|disable (?:the )?wake word)$/, () => Voice.run("wake_word", "off")],
  [/^(?:turn on (?:the )?wake word|wake word on|enable (?:the )?wake word)$/, () => Voice.run("wake_word", "on")],
  [/^(?:turn |switch )?(on|off) (?:the )?clap(?:ping)?(?: detection| to wake)?$/, (m) => Voice.run("clap", m[1] === "on" ? "double" : "off")],
  [/^(?:turn |switch )?clap(?:ping)?(?: detection| to wake)? (on|off)$/, (m) => Voice.run("clap", m[1] === "on" ? "double" : "off")],
  [/^(?:one|single|1) clap(?: mode)?$/, () => Voice.run("clap", "single")],
  [/^(?:two|double|2) claps?(?: mode)?$/, () => Voice.run("clap", "double")],
  [/^(?:mute|mute (?:your )?voice|go silent|text only|stop speaking out loud)$/, () => Voice.run("voice_output", "off")],
  [/^(?:unmute|talk (?:to me )?again|speak again|voice on|turn (?:your )?voice (?:back )?on)$/, () => Voice.run("voice_output", "on")],
  [/^(?:repeat(?: that| it)?|say (?:that|it) again|what did you say|read (?:that|it) again|come again)$/, () => {
    const last = [...Chat.history].reverse().find(m => m.role === "assistant");
    const text = last && (typeof last.content === "string" ? last.content : last.content.filter(b => b.type === "text").map(b => b.text).join(" "));
    return text ? stripTags(text) : "I haven't said anything yet.";
  }],
  [/^scroll (up|down)$/, (m) => { scrollTarget()?.scrollBy({ top: (m[1] === "up" ? -1 : 1) * innerHeight * .6, behavior: "smooth" }); return ""; }],
  [/^(?:scroll |go )?(?:to )?(?:the )?(top|bottom)$/, (m) => { const t = scrollTarget(); t?.scrollTo({ top: m[1] === "top" ? 0 : t.scrollHeight, behavior: "smooth" }); return ""; }],
  [/^(?:type|write down|dictate|put in the box) (.+)$/, (m) => {
    const ta = $("text"); ta.value = (ta.value ? ta.value.replace(/\s*$/, " ") : "") + m[1]; autogrow();
    return "";
  }],
  [/^(?:clear|delete|erase) (?:the )?(?:message|text|box|draft)$/, () => { $("text").value = ""; autogrow(); return ""; }],
  [/^(?:send|send it|send (?:the |my )?message|submit)$/, () => {
    if (!$("text").value.trim() && !Composer.items.length) return "There's nothing to send yet.";
    $("composer").requestSubmit(); return "";
  }],
  [/^(?:attach|upload|add)(?: a| an| some| my)? (?:file|files|photo|photos|picture|pictures|image|video|document|pdf)s?$/, () => {
    toast("Tap + to pick a file. Browsers only open the file picker from a tap or click.", 6000);
    return "Tap the plus button to pick a file. Browsers need a tap for that one.";
  }],
  [/^(?:open|show|start)(?: the| a)? hologram$/, () => Voice.run("project", "core")],
  [/^(?:project|show)(?: me)?(?: my)? (?:the )?(?:image|picture|photo)(?: in 3d| as a hologram)?$/, () => Voice.run("project", "image")],
  [/^(?:close|dismiss|exit|stop)(?: the)? hologram$/, () => Voice.run("close_hologram")],
  // "project a cube" / "project a red ferrari" / "show me a hologram of the eiffel tower" -- anything
  // after "project"/"hologram of" is either a known primitive shape or a free description to generate.
  [/^(?:play|watch)(?: a| an| the)? (.+?) (?:video )?on youtube$/, (m) => Voice.run("play_youtube", m[1])],
  [/^youtube (.+)$/, (m) => Voice.run("play_youtube", m[1])],
  [/^(?:pause|stop) the video$/, () => Voice.run("pause_video")],
  [/^(?:resume|play|unpause) the video$/, () => Voice.run("resume_video")],
  [/^next video$/, () => Voice.run("next_video")],
  [/^close(?: the)? (?:video|youtube)$/, () => Voice.run("close_video")],
  [/^(?:open|show)(?: me)?(?: the)? (.+?) (?:trading )?chart$/, (m) => Voice.run("open_chart", m[1])],
  [/^(?:open|show)(?: me)?(?: the)? chart (?:for|of) (.+)$/, (m) => Voice.run("open_chart", m[1])],
  [/^(?:show|what'?s)(?: me)? (.+?)'?s? (?:chart|trading chart)$/, (m) => Voice.run("open_chart", m[1])],
  [/^project(?: the| a| an)? (.+)$/, (m) => Voice.run("project", m[1])],
  [/^show me(?: the| a| an)? hologram of (.+)$/, (m) => Voice.run("project", m[1])],
  [/^(?:replay|play (?:it |that )?again|restart(?: the animation)?)$/, () => Voice.run("replay_animation")],
  [/^(?:record|record (?:it|that|the animation|a video|video)|save (?:it |the animation )?as (?:a )?video)$/, () => Voice.run("record_animation")],
  [/^(?:yes|yeah|yep|confirm|do it|go ahead|delete it|ok|okay)$/, () => Modal.isOpen ? Voice.confirm() : null],
  [/^(?:no|nope|cancel that)$/, () => Modal.isOpen ? Voice.run("close") : null],
  [/^(?:close|close (?:it|this|that|the (?:panel|drawer|window|popup|menu|chats|history|dialog))|dismiss|go back|back)$/,
    () => Voice.run("close")],
];

const VOICE_HELP = [
  ["Talking", "“Ultron …” or two claps, then speak. After a reply, just answer — no wake word needed."],
  ["Stop", "“stop”, “quiet”, “never mind” (“Ultron, stop” while it's talking)"],
  ["Chats", "“new chat”, “open my chats”, “open my last chat”, “open the chat about …”"],
  ["Screens", "“go home”, “show the gallery”, “open settings”, “close”"],
  ["Code", "“open the code editor”, “run it”, “stop the code”, “close the editor”"],
  ["Animations", "“make an animation of …”, “replay”, “record it”"],
  ["Smarts", "“level four”, “genius mode”, “think harder”, “use Sonnet”, “what level am I on”"],
  ["Writing", "“type …”, “send it”, “clear the message”, “repeat that”"],
  ["Scrolling", "“scroll up”, “scroll down”, “go to the top”"],
  ["Voice", "“go to sleep”, “mute”, “unmute”, “turn off clapping”, “single clap”"],
  ["Account", "“log in”, “sign up”, “log out”"],
  ["Anything else", "Just ask — Ultron can also operate the app itself."],
];

const Voice = {
  followUp: store.get("followUp", true),
  clapMode: store.get("clap", "double"),          // off | single | double
  clapSense: store.get("clapSense", "normal"),    // low | normal | high

  // Something was said aloud: run it as a command, or send it to Claude.
  route(text) {
    const said = norm(text);
    for (const [re, run] of COMMANDS) {
      const m = said.match(re);
      if (!m) continue;
      const reply = run(m);
      if (reply === null) continue;          // doesn't apply right now; let Claude have it
      if (mode === "listening") setMode("idle");
      if (reply) { voiceTurn = !this.quiet; speak(reply, "calm"); if (muted) toast(reply); }
      this.quiet = false;
      return;
    }
    ask(text, { voice: true });
  },
  isCommand(text) { const said = norm(text); return COMMANDS.some(([re]) => re.test(said)); },   // (never runs one)

  // Heard without the wake word. Only "stop"-style words, and only while Ultron is busy.
  bareWord(text) {
    if (mode !== "speaking" && mode !== "thinking" && !alarmTimer) return;
    const said = norm(text);
    if (!/^(?:stop|stop talking|quiet|be quiet|shut up|enough|cancel|never ?mind)$/.test(said)) return;
    if (/\b(stop|quiet|enough|cancel)\b/i.test(lastReply) && !alarmTimer) return;   // probably hearing itself
    interrupt();
  },

  // Voice "yes" presses the highlighted button of the open popup (e.g. Delete, Log out).
  confirm() {
    const b = Modal.isOpen && $("modal").querySelector("button.primary[autofocus]");
    if (!b) return "There's nothing to confirm.";
    b.click(); return "";
  },

  // Do an app action; returns a short spoken confirmation. Also used by Claude's control_app tool,
  // in which case Claude does the talking and the return value is ignored.
  run(action, value = "") {
    value = String(value || "").trim().toLowerCase();
    switch (action) {
      case "new_chat": Chats.closeDrawer(); Modal.close(); Chat.reset(); return "New chat.";
      case "show_home": Modal.close(); Chats.closeDrawer(); View.show("home"); return "Home.";
      case "show_chat": Modal.close(); View.show("chat"); return Chat.history.length ? "" : "No messages yet. Go ahead.";
      case "show_images":
        if (!Account.require("see your images", "images")) return "You'll need an account for images.";
        Modal.close(); View.show("images"); return "Here's your gallery.";
      case "open_code": Code.open(); return "Code editor's open.";
      case "close_code": Code.close(); return "Closed.";
      case "run_code":
        if (!$("code").value.trim()) { Code.open(); return "The editor is empty. Ask me to write something first."; }
        Code.open(); Code.run();
        return $("codeLang").value === "html" ? "Previewing." : "Running.";
      case "stop_code": Code.stop(); return "Stopped.";
      case "open_chats":
        if (!App.user) { Account.open("login", "save and reopen your chats"); return "Log in to see your saved chats."; }
        Chats.openDrawer(value); $("chatSearch").blur(); return value ? `Chats matching ${value}.` : "Your chats.";
      case "open_chat": {
        if (!App.user) { Account.open("login", "save and reopen your chats"); return "Log in to see your saved chats."; }
        const words = value.split(/\s+/).filter(w => w.length > 2);
        const score = (c) => words.reduce((n, w) => n + (c.title.toLowerCase().includes(w) ? 1 : 0), 0);
        const best = !value ? Chats.list[0] : Chats.list.map(c => [score(c), c]).filter(([n]) => n > 0).sort((a, b) => b[0] - a[0])[0]?.[1];
        if (best) { Chat.load(best.id); return `Opening ${best.title}.`; }
        Chats.openDrawer(value); $("chatSearch").blur();
        return value ? `I couldn't find a chat about ${value}. Here's your list.` : "No saved chats yet.";
      }
      case "set_level": {
        let n = WORD_NUM[value] ?? LEVEL_NAMES[value] ?? parseInt(value, 10);
        if (!Number.isFinite(n)) return "Levels go from one to five.";
        n = Math.max(1, Math.min(LEVELS.length, n));
        if (n === Composer.levelNum()) return `Already on level ${n}.`;
        $("level").value = String(n);
        $("level").dispatchEvent(new Event("change"));      // shows the upgrade screen if locked
        return Composer.levelNum() === n ? `Level ${n}, ${LEVELS[n - 1].name}.` : `Couldn't switch to level ${n}.`;
      }
      case "set_model": {
        const id = modelFor(value) || value;
        const m = App.config?.models?.find(x => x.id === id);
        if (!m) return "I don't know that model.";
        if (!modelAllowed(m.id)) { askForModel(m); return `Couldn't switch to ${m.label}.`; }
        $("model").value = m.id; store.set("model", m.id); syncModels();
        return `Switched to ${m.label}.`;
      }
      case "open_settings": Account.settings(); return "Settings.";
      case "log_in": if (App.user) return `You're already logged in as ${App.user.username}.`; Account.open("login"); return "Log in here. I won't listen to your password, so type it.";
      case "sign_up": if (App.user) return "You already have an account."; Account.open("signup"); return "Fill this in to sign up. Type the password, don't say it.";
      case "log_out":
        if (!App.user) return "You're not logged in.";
        Modal.open(el("div", { class: "box" }, el("header", {}, el("h2", {}, "Log out?")),
          el("div", { class: "body" }, el("p", {}, "Say “yes” or “no”."),
            el("div", { class: "row" }, el("button", { class: "pill", onclick: () => Modal.close() }, "Cancel"), el("span", { class: "spacer" }),
              el("button", { class: "pill primary", autofocus: true, onclick: () => { Modal.close(); Account.logout(); } }, "Log out")))));
        return "Log out? Say yes or no.";
      case "wake_word": {
        const on = value !== "off";
        setWake(on);
        this.quiet = !on;                                   // going to sleep: don't listen for a follow-up
        return on ? "Wake word on. Say Ultron when you need me."
          : this.clapMode !== "off" ? "Going quiet. Clap to wake me." : "Going quiet. Click the core when you need me.";
      }
      case "clap": {
        const m = ["off", "single", "double"].includes(value) ? value : value === "on" ? "double" : null;
        if (!m) return "Say one clap, two claps, or clapping off.";
        this.setClap(m);
        return m === "off" ? "Clap detection off." : m === "single" ? "Clap once to wake me." : "Clap twice to wake me.";
      }
      case "follow_up": this.followUp = value !== "off"; store.set("followUp", this.followUp);
        return this.followUp ? "I'll keep listening after I answer." : "I'll wait for the wake word each time.";
      case "voice_output":
        muted = value === "off"; store.set("muted", muted);
        if (muted) { stopSpeech(); toast("Voice muted. Replies appear as text. Say “unmute” to hear them again."); return ""; }
        return "I'm back.";
      case "project": {
        const what = (value || "core").trim();
        const isKnown = what === "image" || what === "picture" || what === "photo" || SHAPES_HINT.has(what.toLowerCase());
        Hologram.open(what).then(msg => { if (msg) speak(msg, "concerned"); });   // opens the camera + 3D view async
        return isKnown
          ? `Projecting ${what === "image" ? "your image" : what}. Spread your hands to grow it, and a fist closes it.`
          : `Generating "${what}" to project. One moment.`;
      }
      case "close_hologram": Hologram.close(); return "Closed.";
      case "open_chart": return Markets.openChart(value);
      case "play_youtube": {
        const q = value || "";
        YouTube.play(q).then(msg => { if (msg) speak(msg, "concerned"); });
        return q ? `Playing ${q} on YouTube.` : "Watch what?";
      }
      case "pause_video": YouTube.pause(); return "";
      case "resume_video": YouTube.resume(); return "";
      case "next_video": YouTube.next(); return "Next.";
      case "close_video": YouTube.close(); return "Closed.";
      case "replay_animation":
        if (!Player.frame) return "There's no animation open.";
        Player.frame.srcdoc = sandboxDoc(Player.html); return "";
      case "record_animation":
        if (!Player.frame) return "Open an animation first.";
        if (Player.recordBtn.disabled) return "Already recording.";
        Player.record(); return `Recording ${Player.seconds} seconds.`;
      case "close":
        if (!$("ytView").hidden) { YouTube.close(); return ""; }
        if (Hologram.active) { Hologram.close(); return ""; }
        if (document.querySelector(".menu")) { closeMenus(); return ""; }
        if (Modal.isOpen) { Modal.close(); return ""; }
        if (!$("chatsPanel").hidden) { Chats.closeDrawer(); return ""; }
        if (Code.isOpen()) { Code.close(); return ""; }
        if (View.current !== "home") { View.show("home"); return ""; }
        return "";
      case "show_voice_commands": this.showHelp(); return "Here's what you can say.";
    }
    return "";
  },

  showHelp() {
    Modal.open(el("div", { class: "box wide voice-help", role: "dialog", "aria-label": "Voice commands" },
      el("header", {}, el("h2", {}, "Voice commands"), el("button", { class: "icon-btn", "aria-label": "Close", onclick: () => Modal.close() }, "×")),
      el("div", { class: "body" },
        el("dl", {}, VOICE_HELP.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])),
        el("p", { class: "muted" }, "Say “close” to shut this."))));
  },

  idleHint() {
    const clap = this.clapMode === "double" ? "clap twice" : this.clapMode === "single" ? "clap" : "";
    if (wakeEnabled) return `Standing by · say “Ultron”${clap ? " or " + clap : ""}`;
    if (clap && Clap.running) return `Standing by · ${clap} to talk`;
    return "Online · click the core to talk";
  },

  setClap(m) {
    this.clapMode = m; store.set("clap", m);
    if (m === "off") Clap.stop(); else Clap.start();
    renderLive();
  },

  // A clap (or two) counts like hearing the wake word.
  wake() {
    if (!SR) { toast("Voice input needs Chrome or Edge."); return; }
    interrupt();
    flare = 1.2; chime();
    ensureMic().catch(() => {});
    recStart("command");
  },
};

// ---------- clap detection ----------
// The mic goes through a high-pass filter (claps are bright, voices mostly aren't) into a
// worklet that flags sudden spikes that also die away within ~50 ms, which speech, music
// and most thumps don't.
const CLAP_WORKLET = `
class ClapDetector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bg = 0.005; this.state = 0; this.t = 0; this.peak = 0; this.loud = 0; this.cool = 0; this.min = 0.12;
    this.port.onmessage = (e) => { if (e.data.min) this.min = e.data.min; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let sum = 0, pk = 0;
    for (let i = 0; i < ch.length; i++) { const v = ch[i]; sum += v * v; const a = v < 0 ? -v : v; if (a > pk) pk = a; }
    const rms = Math.sqrt(sum / ch.length), dt = ch.length / sampleRate;
    if (this.cool > 0) this.cool -= dt;
    if (this.state === 0) {
      if (this.cool <= 0 && pk > this.min && rms > Math.max(this.min / 5, this.bg * 8)) {
        this.state = 1; this.t = 0; this.peak = rms; this.loud = 0;
      } else {
        this.bg += (rms - this.bg) * (rms > this.bg ? 0.003 : 0.03);   // background level, rises slowly
      }
    } else {
      this.t += dt;
      if (this.t < 0.012) this.peak = Math.max(this.peak, rms);
      else if (rms > this.peak * 0.3) this.loud += dt;               // still loud after the attack?
      if (this.t >= 0.1) {
        const clap = this.loud < 0.03;
        if (clap) this.port.postMessage({ at: currentTime, peak: this.peak });
        this.state = 0; this.cool = clap ? 0.04 : 0.25;
      }
    }
    return true;
  }
}
registerProcessor("clap-detector", ClapDetector);`;

const CLAP_MIN = { low: 0.3, normal: 0.15, high: 0.07 };   // minimum spike height by sensitivity
let lastInputAt = 0;     // typing and clicking make clicks the mic can mistake for claps
for (const ev of ["keydown", "pointerdown"]) addEventListener(ev, () => { lastInputAt = performance.now(); }, true);

const Clap = {
  running: false, node: null, stream: null, starting: null, recent: [], pending: null,

  async start() {
    if (this.running || this.starting) return this.starting;
    this.starting = (async () => {
      try {
        // Raw audio: echo cancellation and noise suppression flatten claps.
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        const ac = getAudioCtx();
        await ac.audioWorklet.addModule(URL.createObjectURL(new Blob([CLAP_WORKLET], { type: "text/javascript" })));
        const src = ac.createMediaStreamSource(this.stream);
        const hp = new BiquadFilterNode(ac, { type: "highpass", frequency: 1500, Q: 0.7 });
        this.node = new AudioWorkletNode(ac, "clap-detector", { numberOfOutputs: 0 });
        this.node.port.postMessage({ min: CLAP_MIN[Voice.clapSense] || CLAP_MIN.normal });
        this.node.port.onmessage = (e) => this.onClap(e.data.at);
        src.connect(hp).connect(this.node);
        this.running = true;
        if (ac.state !== "running") {
          toast("Click anywhere once to switch on clap detection.", 6000);
          const kick = () => { getAudioCtx(); removeEventListener("pointerdown", kick); };
          addEventListener("pointerdown", kick);
        }
      } catch (err) {
        toast("Clap detection needs the microphone.");
        Voice.clapMode = "off"; store.set("clap", "off");
      } finally {
        this.starting = null; renderLive();
      }
    })();
    return this.starting;
  },

  stop() {
    this.running = false;
    this.node?.disconnect(); this.node = null;
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
  },

  sensitivity(s) {
    Voice.clapSense = s; store.set("clapSense", s);
    this.node?.port.postMessage({ min: CLAP_MIN[s] });
  },

  onClap(at) {
    // Ignore our own voice and anything while already listening or thinking.
    if (mode === "speaking" || mode === "listening" || mode === "thinking" || performance.now() - lastInputAt < 1500) {
      this.recent = []; clearTimeout(this.pending); return;
    }
    // Only a lone clap (or a lone pair) counts: nothing else in the 1.5 s before, nothing
    // right after. Typing, applause, music and footsteps come in longer runs.
    this.recent = this.recent.filter(t => at - t < 1.5);
    this.recent.push(at);
    clearTimeout(this.pending);
    const want = Voice.clapMode === "single" ? 1 : 2;
    if (this.recent.length !== want) return;
    if (want === 2) {
      const gap = at - this.recent[0];
      if (gap < 0.12 || gap > 0.8) { this.recent = [at]; return; }
    }
    this.pending = setTimeout(() => {
      if (this.recent.length === want && this.recent[want - 1] === at) { this.recent = []; Voice.wake(); }
    }, 400);
  },
};

// Run once everything else has loaded.
if (Voice.clapMode !== "off") Clap.start();
renderLive();
