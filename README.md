# Ultron AI

*Think · Create · Evolve.* A voice-first AI assistant with a living red core. It chats, writes and runs code, makes animations and images, reads your files, and keeps saved chats for everyone who signs up. Claude does the thinking.

![home](docs/home.png)

![chat](docs/chat.png)

## Setup

```bash
pip install -r requirements.txt
python setup_voice.py                 # one-time download of Ultron's voice (~350 MB)
export ANTHROPIC_API_KEY=sk-ant-...   # or run `ant auth login` once
export OPENAI_API_KEY=sk-...          # optional: turns on image generation
python server.py
```

Open **http://127.0.0.1:8765**. Chrome or Edge are best, because they have built-in speech recognition. Other browsers work too, but you have to type.

### Two brains: Claude, and a free one on your PC

Ultron can think with **Claude** (smartest, billed per use to your API key) or with a **free model running on your own PC** through [Ollama](https://ollama.com) (no cost, works offline, nothing sent to the cloud, but less clever). Both show up in the Model menu and you can switch any time by voice: "go free" or "use Claude".

To add the free brain on Windows: install Ollama from ollama.com, then in PowerShell run `ollama pull qwen3:8b` (about 5 GB; use `qwen3:4b` on a weaker PC). Restart `python server.py` and it appears in the menu. It needs a decent PC: a graphics card with 8 GB or more, or at least 16 GB of memory.

Claude is used by default whenever `ANTHROPIC_API_KEY` is set. To start on the free brain instead, run `python server.py --local` or set `ULTRON_BRAIN=local`. Other settings: `OLLAMA_MODEL` (default `qwen3:8b`), `OLLAMA_URL`, `OLLAMA_NUM_CTX`.

No key yet? `python server.py --mock` runs everything with a keyword bot that still uses the real tools. Try "set a timer for 10 seconds", "write code", "make an animation" or "draw a cat".

## What it does

| | |
|---|---|
| **Hands-free** | Say **"Ultron …"** or **clap twice** and speak. After Ultron answers, just reply; it keeps listening without the wake word. Say "stop" to cut it off. The whole app works by voice (see below). You can also click the core or press **Space**; **Esc** interrupts. |
| **Voice** | A low, deliberate, human-sounding voice generated locally (Kokoro), with moods (calm, warm, amused, excited, concerned, stern, sinister) that change the delivery and the core's color. Ultron's personality is cool, sardonic and a little menacing, but always helpful. |
| **Levels 1–5** | The Level menu sets how hard Claude thinks: 1 Quick, 2 Balanced, 3 Smart, 4 Genius, 5 Max. Higher levels give smarter answers but are slower and cost more. |
| **Models** | Opus 5 (default), Opus 5.5 and Sonnet 5, from the Model menu or the Models panel. |
| **Files (+)** | Attach pictures, PDFs, text and code files, and videos, using the paperclip, drag and drop, or paste. Claude can't watch video, so Ultron samples 4 to 10 still frames from it (no audio). |
| **Code** | A code panel where Claude writes, reads and fixes code. It runs **Python** in your browser (Pyodide, downloaded on first run), **JavaScript** in a sandboxed worker (stopped after 10 seconds), and **HTML** as a live preview. Matplotlib charts show inline. |
| **Animate** | Ask for any animation. It plays in a player with Replay, Fullscreen, **Record video** (WebM or MP4), **Download HTML** and **Edit code**. |
| **Images** | "Generate an image of…" uses OpenAI's image model. Each account gets **5 images per 5 hours** (a rolling window that survives restarts). The Images page shows your gallery. |
| **Chats** | Every conversation is saved to your account, with search, star, rename and delete. **New chat** starts fresh. |
| **Tools** | Timers with alarms, weather (Open-Meteo, free), the current time, trending crypto and stocks (CoinGecko + Yahoo Finance, both free, no key). |
| **Apps & music** | Ultron runs on your own PC, so it can open any app in your Start menu ("open Spotify", "open Word", "open Minecraft") or a website, and play songs: "play Believer" plays it from your Music, OneDrive Music or Downloads folders (or `ULTRON_MUSIC_DIR`) in Ultron's own player, "... on Spotify" opens it in Spotify (you press play; starting a song needs Spotify's paid developer API), and anything not on your PC plays from YouTube. Both are switched off automatically if the server is reachable from other machines. |
| **Web search** | Ask about anything current ("search for...", "what's the latest on...", "who won...") and Ultron searches the web and can open a result to read it. Free, no key: web results from Bing (Edge's search engine) and DuckDuckGo, headlines from Bing News and Google News, and Wikipedia. If one source is down or blocks the request, the others still answer. Pages on your own machine or local network are never fetched. |
| **Conversation** | Ultron keeps the thread of the conversation (the last 40 messages), asks follow-ups, banters and gives opinions, like a proper AI companion rather than a command box. With "Keep listening after replies" on (Settings), you can just keep talking without the wake word. |
| **Tutor mode** | Say "Ultron, tutor me" (or "teach me...", "help me study...") for school or work topics. It asks what you're learning and your level, teaches one step at a time, checks your understanding, quizzes you, and guides you through homework instead of just handing over answers. "Tutor Mode" shows as running on the dashboard; say "stop tutoring" to end it. |
| **Trending** | A "Trending" card in the sidebar shows the top 3 trending cryptocurrencies and top 3 trending US stocks, loaded automatically the moment Ultron opens (and refreshed every 90 seconds) -- no need to ask. It says a short spoken line about it too, once per visit, unless you turn that off in Settings. |
| **Dashboard** | A full JARVIS-style HUD surrounds the orb: real time and date, battery (level, charging state, estimated time), local temperature and conditions, your location, the nearest running timer, live system status (network, voice recognition, camera, account), an active-processes list tied to what Ultron is actually doing (listening, thinking, speaking, visual analysis, media playback), your account panel and a Quick Access grid (Generate, Code, Hologram, Media Player, Files, Settings). A few panels -- system load, the processing/network-traffic waveforms, the "global network" map -- are stylised motion, since no web page can read a device's real CPU/GPU load or network topology; everything else is genuinely live. |
| **Voice-only home** | The home screen has no typing box or text transcript -- it's the orb and the dashboard, nothing else. Voice is the only way in. Saved chats still work in the background (say "open my last chat"); there's just nowhere for the text to show. |
| **Fullscreen home** | The home screen also hides the sidebar, topbar and rail entirely, edge to edge -- just the orb and the HUD. Everything's still reachable by voice ("open settings", "show the gallery"); switching to another screen brings the normal layout back for that screen. Say "open the sidebar" (or "show the tools") to bring it all back without leaving home, and "hide the sidebar" to tuck it away again. |
| **Boot sequence** | The first time you dismiss the START screen each session, Ultron speaks a short startup announcement before anything else (including the market briefing, which waits for it). Edit `BOOT_LINE` in `static/account.js` to change it. |
| **Trading charts** | Say "open the Bitcoin chart" or "show me Tesla's chart" for a live, real candlestick chart (red and green) of anything in today's Trending list, embedded straight from TradingView -- draggable, zoomable, with its own toolbar. Opens fullscreen, with the sidebar and topbar out of the way; say "close" or press Esc to leave. |
| **Media player** | A local audio/video player in the sidebar, with a small reactive visualizer. Nothing is uploaded -- files play straight from your browser. |
| **YouTube, hands-free** | Say "play [anything] on YouTube" and it opens right inside Ultron, fully voice-controlled ("pause the video", "next video", "close the video"). Headphone/hardware media buttons (and a phone's lock-screen media controls, if you're on mobile) also control whichever local media is playing, through the browser's standard media-session hooks. |

| **Hands-free stays hands-free** | A voice conversation never jumps you to the text chat screen -- you stay wherever you are (home, code, wherever) and it's saved regardless; say "show the chat" to see it. Typing in the composer still opens the chat view as before. |

![animation player](docs/animation.png)

## Voice control

Wake Ultron by saying its name or clapping, then say what you want. App commands run instantly in the browser; anything else goes to Claude, which can also operate the app itself with its `control_app` tool (so "can you pull up my image gallery" works too). Say **"what can I say"** for the full list.

| Say | |
|---|---|
| "stop", "quiet", "never mind" | Stops talking (while it's talking, a bare "stop" works without the wake word) |
| "new chat", "open my chats", "open my last chat", "open the chat about …" | Chats |
| "go home", "show the gallery", "open settings", "go premium", "close" | Screens |
| "open the code editor", "run it", "stop the code", "close the editor" | Code |
| "replay", "record it" | The animation player |
| "level four", "genius mode", "think harder", "use Sonnet", "what level am I on" | Levels and models (locked ones show the upgrade screen) |
| "type …", "send it", "clear the message", "repeat that" | Writing |
| "scroll up", "scroll down", "go to the top" | Scrolling |
| "yes" / "no" | Confirm or cancel the open popup (e.g. "delete this chat?"). Otherwise they're answers for Ultron. |
| "go to sleep", "mute", "unmute", "turn off clapping", "single clap" | Voice settings |
| "log in", "sign up", "log out" | Account. Passwords are always typed, never spoken. |

Two things still need a tap, because browsers require one: the **START** screen (it unlocks sound for the visit), and the **file picker** for attachments.

**Clapping.** Settings has *Clap to wake* (off, one clap, two claps) and a sensitivity. The detector listens for the sharp spike of a clap that dies away fast, and only a lone clap or pair counts, so talking, music and typing don't set it off. It ignores claps while Ultron is talking and for a moment after you type or click. Two claps (the default) gives the fewest false starts.

**Keep listening after replies** (on by default) turns a question into a conversation: after answering something you said, Ultron listens for about as long as the browser's recognizer waits for speech, then goes back to standing by.

**Hand-gesture control** (Settings, off by default -- it asks for the camera) recognizes a few gestures on-device, no video ever leaves your machine: open palm to wake, a fist to stop, thumbs up/down to confirm or cancel a popup, and a peace sign for a new chat. A small preview pill in the corner shows what it currently sees.

**Hologram viewer.** Say "project a cube" (or torus, sphere, pyramid, cone, cylinder, diamond, or just "project the core" for Ultron's own orb), or click the Hologram tile. A live 3D wireframe appears, and you control it with your bare hands in front of the camera: spread both hands apart to grow it, bring them together to shrink it, move your hand to spin it, make a fist to dismiss it.

Say **"project a [anything]"** -- a Ferrari, a 747, a Victorian house, a kitchen interior, literally any description -- and Ultron generates a picture of it (the existing image tool, needs `OPENAI_API_KEY` and an account) and turns it into a depth-relief card: a plane whose surface is pushed forward or back based on the picture's own brightness and how central each point is, so it genuinely parallaxes as you turn it in your hands. It's an honest single view you can tilt, not a walk-around 3D model -- true arbitrary text-to-3D needs a paid cloud service this app doesn't use. "Project my image" does the same with your last generated image, no new generation needed.

## Artwork

Ultron ships with your robot artwork (`static/art/robot.jpg`) in four places: behind the START screen, beside the core on Home, in the sidebar card, and in the "Unlock the full power" banner.

To use your own artwork, drop image files into `static/art/` with these names. Any of `.jpg`, `.png`, `.webp`, `.avif`, `.gif` or `.svg` works:

| File | Where it appears | Best shape |
|---|---|---|
| `splash.jpg` | Full-screen behind the START screen, darkened so the logo stays readable | Wide, 1920×1080 or larger |
| `hero.jpg` | Left side of Home, fading into the page | Portrait or square |
| `card.jpg` | Behind the sidebar card | Portrait |
| `banner.jpg` | Behind the "Unlock the full power" banner | Wide |
| `login.jpg` | The close-up panel beside the log-in and sign-up forms, with a slow drift and a pulsing glow on the eye | Portrait |

You don't need to restart; just reload the page. Any slot without a file keeps the built-in robot. The current `robot.jpg` was enlarged from a small 199×191 crop, so a full-resolution copy of the same artwork will look much sharper: save it over `static/art/robot.jpg`. Also in that folder are a 3D render (`robot-3d.jpg`) and a vector version (`robot.svg`); to use it instead, rename it to `splash.svg` / `hero.svg`, and so on.

## Accounts

Everyone gets full access -- every level, every model, no paid tier. An account only exists to save your chats and images across visits.

| | Guest (not signed in) | Account |
|---|---|---|
| Voice, chat, timers, weather, markets, code, animations, hologram | ✓ | ✓ |
| Levels | 1–5 (all) | 1–5 (all) |
| Models | Opus 5, Opus 5.5, Sonnet 5 | Opus 5, Opus 5.5, Sonnet 5 |
| Attach files | ✓ | ✓ |
| Saved chats, image generation | | ✓ |

Image generation still has a per-account rate limit (`ULTRON_IMAGE_LIMIT`, default 20 per 5 hours) -- that's a plain cost-safety default, not a paywall, since each image is a real charge to whoever runs the server's OpenAI key. Set it to `0` to remove the limit entirely.

Passwords are stored hashed with scrypt and a salt. Sessions are HttpOnly cookies that last 30 days. After five wrong passwords, that username is locked for 15 minutes from the address that made them. Everything is kept under `data/`: users, sessions, chats and images, with one folder per person.

## Sign in with Google and Apple

![log in](docs/login.png)

The **Continue with Google** and **Continue with Apple** buttons appear on the log-in and sign-up screens once you configure them. Signing in creates an account linked to that Google or Apple ID, with no password. Signing in again returns to the same account.

**Security:** Ultron checks the ID token's signature against the provider's published keys, along with its issuer, audience, expiry and a one-time nonce. Google sign-in also uses PKCE. The sign-in state is single-use and tied to the browser that started it.

Set `ULTRON_PUBLIC_URL` to your site's exact address (for example `https://ultron.example.com`). It must match what you register with Google and Apple.

**Google** (free, and works on `http://localhost` for testing):
1. Go to console.cloud.google.com → APIs & Services → **OAuth consent screen**, and fill it in (app name, support email).
2. Go to **Credentials** → Create credentials → **OAuth client ID** → *Web application*. Add the authorized redirect URI `https://YOUR-DOMAIN/auth/google/callback`, or `http://localhost:8765/auth/google/callback` for local testing.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

**Apple** (needs a paid Apple Developer account, and HTTPS on a real domain; Apple doesn't allow localhost):
1. At developer.apple.com → Certificates, IDs & Profiles, create an **App ID** with *Sign in with Apple* enabled.
2. Create a **Services ID** (for example `com.yourname.ultron.web`). Enable Sign in with Apple, and configure it with your domain and the return URL `https://YOUR-DOMAIN/auth/apple/callback`.
3. Under **Keys**, create a key with Sign in with Apple and download the `.p8` file. You can only download it once.
4. Set `APPLE_CLIENT_ID` (the Services ID), `APPLE_TEAM_ID` (top right of the developer site), `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY_FILE=/path/to/AuthKey_XXXX.p8`.

Apple shares the person's name only the first time they sign in, and may hand over a private relay email address. Ultron handles both. If you set an invite code (`ULTRON_SIGNUP_CODE`), new Google and Apple sign-ups are turned off, because there's nowhere to type the code; existing linked accounts still work.

## A note on "device control"

Ultron can play YouTube inside itself and respond to hardware media buttons (headphones, a phone's lock screen) for whatever's playing in the browser tab -- that's real, and it's what "device control" means here. What it can't do, and what no website can do: reach out and open apps or take over a *separate* physical device, like actually operating your phone's YouTube app from your computer. That needs a companion app running on the phone itself, which is a different, much bigger project than a web page.

## Sharing it with other people

By default Ultron only listens on your own computer. To let others use it:

1. **Protect your API bill.** Everyone who uses Ultron spends your Anthropic (and OpenAI) credit, including guests -- and there's no paid tier to offset it. Set `ULTRON_SIGNUP_CODE=something-secret` so only people you give the code to can sign up, set `ULTRON_SIGNUP=closed` after creating accounts, and keep `ULTRON_IMAGE_LIMIT` sane (images cost real money per call).
2. **Use HTTPS.** Put it behind a reverse proxy such as Caddy or nginx, start it with `--host 0.0.0.0`, and set `ULTRON_SECURE_COOKIES=1`. Without HTTPS, passwords travel unencrypted.

## Configuration

| Env var / flag | Default | |
|---|---|---|
| `ULTRON_MODEL` | `claude-opus-5` | Default model |
| `ULTRON_EFFORT` | `low` | Level used if the page doesn't send one |
| `ULTRON_VOICE` | `am_michael:0.7,am_onyx:0.3` | Kokoro voice or weighted blend, e.g. `am_michael`, `am_onyx`, `bm_george` |
| `ULTRON_VOICE_FX` | `edge` | Adds a faint synthetic shimmer to the voice; `human` leaves it natural |
| `ULTRON_VOICE_CHEST` | `0` | Low-end "chest" weight added under the voice; try `0.3`–`0.4` |
| `ULTRON_TTS` | `kokoro` | `browser` uses the browser's built-in voice |
| `ULTRON_LOCATION` | *(unset)* | Home city for weather, e.g. `"Bangalore, India"` |
| `OPENAI_API_KEY` | *(unset)* | Turns on image generation |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` | OpenAI image model |
| `OPENAI_IMAGE_QUALITY` | `medium` | `low` / `medium` / `high` (higher costs more) |
| `ULTRON_IMAGE_LIMIT` | `20` | Images per account per window; a cost-safety default, not a paywall. `0` removes it |
| `ULTRON_IMAGE_WINDOW_HOURS` | `5` | Length of the rolling image window |
| `ULTRON_PUBLIC_URL` | *(from the request)* | Your site's address, used for the Google/Apple redirect addresses |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` / `SMTP_SECURITY` | *(unset)* / `587` / … / `starttls` | Email for password resets |
| `ULTRON_MAIL_TO_CONSOLE` | *(unset)* | `1` prints emails in the terminal instead (for development) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | *(unset)* | Turns on Sign in with Google |
| `APPLE_CLIENT_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY_FILE` | *(unset)* | Turns on Sign in with Apple |
| `ULTRON_SIGNUP` | `open` | `closed` stops new sign-ups |
| `ULTRON_SIGNUP_CODE` | *(unset)* | Invite code required to sign up |
| `ULTRON_SECURE_COOKIES` | *(unset)* | `1` when served over HTTPS |
| `--host` / `--port` | `127.0.0.1` / `8765` | |

## How it works

```
browser ── speech recognition ──► POST /api/chat ──► server.py ──► Claude (streaming, with tools)
   ▲                                                    │  └──► tools.py: timers, weather, time, code editor,
   │                                                    │                  animations, OpenAI images (quota)
   └── audio clips ◄── POST /api/tts (Kokoro) ◄─────────┘
```

- `server.py` handles HTTP, the Claude tool loop, chat storage and permissions.
- `auth.py` handles accounts, sessions, plans, and what each plan can do.
- `oauth.py` handles Sign in with Google and Apple, and `mailer.py` sends email.
- `billing.py` handles Stripe checkout, the customer portal and webhooks, and `setup_stripe.py` creates the product and prices.
- `tools.py` holds the tools Claude can call. To add one, add a schema to `TOOLS` and a handler to `HANDLERS`.
- `tts.py` generates the voice, and `setup_voice.py` downloads its model.
- `static/voice.js` handles voice commands, follow-up listening and clap detection (an AudioWorklet).
- `static/`: `index.html` (layout and theme), `app.js` (core, voice, orb), `composer.js` (message box and files), `code.js` (editor, runners, animation player), `chats.js` (transcript, history, images), `account.js` (log-in, sign-up, splash, settings).

Code from Claude never runs on the server. It runs in browser sandboxes that can't see Ultron's page, cookies or other chats.

![phone](docs/mobile.png)
