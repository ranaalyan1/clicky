# Ustaad - Agent Instructions

<!-- This is the single source of truth for all AI coding agents. CLAUDE.md is a symlink to this file. -->
<!-- AGENTS.md spec: https://github.com/agentsmd/agents.md — supported by Claude Code, Cursor, Copilot, Gemini CLI, and others. -->

## Overview

Ustaad is a Windows desktop companion written entirely in TypeScript: an Electron system-tray client in `windows/` and a Cloudflare Worker proxy in `worker/`. It lives in the Windows notification area and opens a floating control panel plus a notch ("the island") at the top of every screen. Global push-to-talk captures voice input and sends the transcript plus multi-monitor screenshots to the configured model. The model responds with streamed text and speech, can point at UI elements, and can act on the PC through a typed action protocol.

There is **no Swift code and no macOS client** in this repository. The original open-source Clicky macOS client was removed; it remains in this repository's history at commit `629c868` if it is ever needed for reference.

The client can think with **either** a user-supplied Gemini API key stored on that PC (`%APPDATA%\Ustaad\settings.json`) **or** the Cloudflare Worker proxy, which keeps the long-lived provider keys off the device.

## Architecture

### Windows client (`windows/`)

- **App Type**: Electron system-tray app, with no taskbar window
- **Framework**: Electron 44 + TypeScript; Chromium renderers for UI, microphone capture, audio playback, and overlay animation
- **Security Boundary**: sandboxed renderers, context isolation enabled, Node integration disabled, narrow IPC API exposed through `src/preload/preload.ts`
- **State Management**: `UstaadController` is the main-process state machine and publishes an immutable public state snapshot to the panel, the island, and the overlays
- **Brain**: `BrainRouter` picks Gemini (user's own key) or the Cloudflare Worker; if the selected provider has no key or URL yet, it uses the other one instead of failing
- **Global Shortcuts**: `uiohook-napi` tracks physical key-down and key-up. Talk is **Ctrl + Alt** (left Alt only, to avoid Windows AltGr), dictation is **Ctrl + Windows** (configurable: Ctrl + Shift + Space, or Caps Lock), circling is **Ctrl + Shift**, snip is **Ctrl + Alt + S**, panic is **Ctrl + Alt + Q**, and **Escape** cancels circling, closes a snip, and stops a running task
- **Speech-to-Text**: Gemini (single-shot WAV upload) or the AssemblyAI v3 websocket, fed 16 kHz little-endian PCM by the hidden panel renderer
- **Screen Capture**: Electron `desktopCapturer`, with the pointer display sorted first and all images constrained to 1280 pixels; circling and snips crop the drawn region instead of the whole display
- **Element Pointing**: one transparent, click-through, capture-protected `BrowserWindow` per display; Windows uses top-left global desktop coordinates, including negative monitor origins
- **Text-to-Speech**: Gemini TTS or ElevenLabs audio plays in the persistent panel renderer; Windows `speechSynthesis` is the fallback and needs no key at all
- **Actions**: the model replies with one `<actions>[…]</actions>` block; `action-protocol.ts` parses it and decides what must be confirmed, `system-actions.ts` performs it through the PowerShell/C# bridge, and `windows/src/renderer/island.*` shows the confirmation card and the undo button
- **Multi-step tasks**: a reply may also carry a `<task>goal</task>` block. `agent-loop.ts` then runs one step, screenshots every display, and asks the model for `DONE` / `NEXT` / `GIVE_UP`. The loop is bounded (8 steps, 2 re-plans per step, 75 seconds), skipping the vision check entirely for playback goals by asking Windows what is playing
- **System access**: `system-access.ts` is the single policy for `run_command`, `manage_file` and `read_registry`. Blocked beats tier 2 beats tier 1, anything unrecognised is tier 2, and files are confined to the user's own folders. `audit-log-store.ts` records every attempt
- **Skills**: `skill-store.ts` keeps tasks the user saved by name; `skill-suggestions.ts` decides when to offer one. A skill is a memory aid, never a permission: running one goes through the same approval and screen checks as a spoken task
- **Wake word**: `wake-word-listener.ts` runs the `wake-word-script.ts` System.Speech helper, which hears only the wake phrases. Off by default, muteable from the tray, and never leaves the machine
- **Island**: a click-through notch at the top of every screen that summons itself when the pointer touches the top edge (now playing, to-do list, reminders and routines, memory, clipboard, launchable apps, wallpapers, timers, snippets, skills, quick switches, microphone light)
- **Distribution**: `electron-builder` creates per-user NSIS installers for x64 and ARM64; `.github/workflows/windows.yml` validates, launches the packaged x64 app, uploads artifacts, and can publish version-matched Windows releases

### API Proxy (Cloudflare Worker)

Long-lived provider API keys never ship in the client. Claude and ElevenLabs requests go through a Cloudflare Worker (`worker/src/index.ts`); the client fetches a short-lived AssemblyAI token from the Worker and uses that temporary token for the realtime websocket.

| Route | Upstream | Purpose |
|-------|----------|---------|
| `POST /chat` | `api.anthropic.com/v1/messages` | Claude vision + streaming chat |
| `POST /tts` | `api.elevenlabs.io/v1/text-to-speech/{voiceId}` | ElevenLabs TTS audio |
| `POST /transcribe-token` | `streaming.assemblyai.com/v3/token` | Fetches a short-lived (480s) AssemblyAI websocket token |

Worker secrets: `ANTHROPIC_API_KEY`, `ASSEMBLYAI_API_KEY`, `ELEVENLABS_API_KEY`
Worker vars: `ELEVENLABS_VOICE_ID`

### Key Architecture Decisions

**Windows Main/Renderer Split**: Provider calls, configuration, global hooks, screen capture, and lifecycle state stay in Electron's main process. The renderer receives only the minimum APIs needed for UI, microphone PCM, audio playback, and overlay drawing. Do not enable Node integration or expose `ipcRenderer` directly.

**Windows Overlay Pattern**: Each display gets its own non-focusable, click-through BrowserWindow. The windows are content-protected so Ustaad's own cursor and panel do not appear in screenshots. Main-process coordinates are translated into display-local top-left coordinates before an overlay animates.

**Windows Audio Host**: The panel BrowserWindow is created once and hidden rather than destroyed. Its renderer remains the audio host while the panel is closed, allowing `getUserMedia`, provider speech playback, and the Windows speech fallback to continue in the tray.

**Island Presentation**: `island-presentation.ts` is a pure state machine (`hidden → revealed → open`) with hover, idle, and interaction-grace timers. It exists so summoning behaviour can be unit-tested instead of eyeballed, and `applyIslandPresentation` in `desktop-windows.ts` is the only place that shows, hides, or resizes the island.

**Shortcut Chords**: `shortcut-registry.ts` declares, per shortcut, which shorter shortcuts it supersedes (`Ctrl+Alt+S` and `Ctrl+Alt+Q` both start life as the `Ctrl+Alt` talk chord). Supersession is declared rather than inferred: an accidental keypress must never silently cancel something the user is holding.

**Bounded Agent Loop**: `agent-loop.ts` owns no Electron, network, or clock of its own; everything is injected, which is what makes every branch testable. A model that asks for the identical step twice is treated as stuck and handed back to the user rather than looping.

**System Access Tiers**: Two separate abilities, both off by default. Tier 1 is read-only diagnostics, registry reads, and files inside the user's own six folders. Tier 2 is arbitrary commands that change the PC, with its own warning wording and its own confirmation. Credentials, elevation, and anything that weakens Windows security are refused whatever is switched on.

**Skill Repair**: A saved skill that fails recovers by being replaced, never by being widened. The store keeps a failure streak per skill; two failures in a row (a run the user stopped themselves never counts) produce an offer, and the offered streak is remembered so "not now" is respected until two more failures. The fix is one ordinary model call whose prompt carries the same rules as the parser expects, the proposed aim is shown before it is saved, and saving it resets the health while keeping the name, the id and every run-time confirmation. Nothing about a repair grants an ability.

**Phone Window**: `phone-bridge-server.ts` is a plain `node:http` server — no framework, no dependency — that speaks three routes (`GET /` for the one-page window, `GET /api/status` for what is already on the PC, `POST /api/ask` for a typed question). Everything else is 404, and **no route can act**: a phone question is answered through the same capture, prompt and parse path as a spoken one, with actions stripped, so the read-only promise is a property of the routes rather than a rule the model is asked to respect. The pairing token is compared with `timingSafeEqual`, the address is bound to the LAN, each source address gets 60 requests a minute, bodies are capped at 4 KB, and the page carries a `default-src 'none'` CSP so it loads nothing from anywhere. It starts only while the `phoneWindow` ability is on and stops when the ability is switched off or the app quits.

## Key Files

| File | Lines | Purpose |
|------|-------|---------|
| `windows/src/main/main.ts` | ~430 | Electron entry point, secure permission policy, sender-checked IPC registration, single-instance lifecycle, display-change handling. |
| `windows/src/main/ustaad-controller.ts` | ~2,800 | The orchestrator: talk, dictation, circle-to-ask, snips, timers, snippets, the task loop, confirmations, undo, the scheduler, wake-word lifecycle, skills, audit log, island state. |
| `windows/src/main/desktop-windows.ts` | ~840 | Tray (with mute), floating panel, island presentation, per-display overlays and region selectors, cursor polling, renderer messaging. |
| `windows/src/main/action-protocol.ts` | ~960 | `<actions>` and `<task>` parsing, risk classification, ability filtering, and the action section of the system prompt. |
| `windows/src/main/agent-loop.ts` | ~340 | Plan, act, look, correct: the bounded task runner, its look protocol, and the playback shortcut. |
| `windows/src/main/system-access.ts` | ~370 | The whole safety policy for `run_command`, `manage_file` and `read_registry`, plus the tier decisions and refusal reasons. |
| `windows/src/main/system-access-runner.ts` | ~130 | Runs one PowerShell command in its own short-lived process, and reads or writes a single file. |
| `windows/src/main/audit-log-store.ts` | ~95 | The on-disk record of every system-access attempt: allowed, refused, blocked or failed, with the raw request. |
| `windows/src/main/system-actions.ts` | ~680 | Every action (apps, typing, keys, clicks, clipboard, volume, media, windows, wallpaper, files, registry, to-dos, schedules, memory) with undo where possible. |
| `windows/src/main/windows-bridge.ts` | ~283 | JSON-line bridge to a PowerShell helper that drives SendInput (including the mouse), media, volume, wallpaper, and the Start menu index. |
| `windows/src/main/windows-bridge-script.ts` | ~760 | The helper script itself: ASCII-only, written with a UTF-8 BOM because PowerShell 5.1 reads un-BOM'd files as ANSI. |
| `windows/src/main/wake-word-listener.ts` | ~264 | Starts, restarts and stops the offline wake-word listener, and parses its event lines. |
| `windows/src/main/wake-word-script.ts` | ~115 | The System.Speech helper that hears only the wake phrases, with a stricter confidence threshold for phrases that hide inside typing. |
| `windows/src/main/brain-router.ts` | ~222 | Picks Gemini or the Worker for chat and speech, falls back to the offline Windows voice, and reports configuration hints. |
| `windows/src/main/gemini-client.ts` | ~290 | Gemini chat streaming, TTS, single-shot transcription, dictation cleanup, and API-key checks. |
| `windows/src/main/claude-client.ts` | ~170 | Claude vision SSE, ElevenLabs TTS, and AssemblyAI token clients for the Worker path. |
| `windows/src/main/screen-capture.ts` | ~200 | Electron multi-display capture, pointer-display ordering, labels, and region crops for circling and snips. |
| `windows/src/main/pointing.ts` | ~81 | Pure `[POINT:...]` parser, display selection, and top-left Windows coordinate mapping (shared with `click_at`). |
| `windows/src/main/island-presentation.ts` | ~208 | The island's pure summon/dismiss state machine. |
| `windows/src/main/shortcut-registry.ts` | ~248 | Shortcut definitions, chord supersession, and the physical-key state machine behind push-to-talk. |
| `windows/src/main/global-shortcut-monitor.ts` | ~107 | The `uiohook-napi` listener that feeds physical key events to the state machine and reports Escape. |
| `windows/src/main/skill-store.ts` | ~250 | Tasks the user saved by name, with rename, remove, run counts and the health of each skill (last outcome, failure streak, how often it has been repaired). |
| `windows/src/main/skill-suggestions.ts` | ~131 | When repeating a task becomes an offer to save it, including how a "no thanks" is respected. |
| `windows/src/main/skill-repair.ts` | ~115 | When a saved skill that keeps failing deserves a second chance: the failure rule (a run the user stopped is not a failure), the offer threshold, the repair prompt, and the parser for the new aim. |
| `windows/src/main/snippet-store.ts` | ~174 | Saved phrases that can be typed into any window. |
| `windows/src/main/clipboard-history-store.ts` | ~95 | Recent clipboard text, on this PC only. |
| `windows/src/main/memory-store.ts` | ~170 | Remembered facts and the island's activity feed. |
| `windows/src/main/run-history-store.ts` | ~190 | What Ustaad was asked and what it did about it: a plain `run-history.json`, newest first, capped at 300 runs, searched in memory with `scoreTextMatch` rather than a database. Follows the memory ability — off means nothing is written. |
| `windows/src/main/phone-bridge-store.ts` | ~81 | The pairing token and port for the phone window, in `phone-bridge.json`; rotating it is what unpairs every phone. |
| `windows/src/main/phone-bridge-server.ts` | ~312 | The local HTTP server behind the phone window: token check, request budget, size caps, and three routes that cannot act. |
| `windows/src/main/phone-bridge-page.ts` | ~185 | The single self-contained page a phone opens, built as one string so it needs no assets and loads nothing external. |
| `windows/src/main/schedule-store.ts` | ~237 | Reminders and routines, their next-run maths, and overdue handling. |
| `windows/src/main/todo-store.ts` | ~166 | The spoken to-do list. |
| `windows/src/main/config-store.ts` | ~286 | Validated, atomic persistence of user settings, including what is rejected when the panel sends nonsense. |
| `windows/src/main/soul-config.ts` | ~209 | The soul, personality and ability defaults. |
| `windows/src/main/system-prompt.ts` | ~151 | Builds the system prompt from the soul, abilities, memory, to-dos, schedules, snippets and saved skills. |
| `windows/src/main/transcription-session.ts` | ~314 | The AssemblyAI websocket session used by dictation and circling. |
| `windows/src/preload/preload.ts` | ~174 | Context-isolated IPC surface shared by the panel, island, overlays, and region selectors. |
| `windows/electron-builder.signing.js` | ~70 | The packaging config the `package:win` scripts use: spreads `package.json`'s `build` block and adds Azure signing only when it is fully configured, throwing when it is only partly configured. |
| `windows/src/shared/contracts.ts` | ~758 | Every shared type: actions, abilities, config, island state, skills, audit entries. |
| `windows/src/renderer/panel.ts` | ~971 | Panel UI bindings and the persistent renderer host for microphone capture and response audio. |
| `windows/src/renderer/island.ts` | ~728 | The notch: now playing, activity with undo, confirmations, timers, snippets, skills offers, plans, memory, clips, apps, wallpapers, quick switches. |
| `windows/src/renderer/overlay.ts` | ~179 | Cursor following, response bubble, waveform, and bezier pointing animation. |
| `windows/src/renderer/selection.ts` | ~111 | The circle-to-ask lasso and the snip overlay, sharing one region-selector window. |
| `windows/src/renderer/audio-capture.ts` | ~160 | Microphone capture, PCM16 conversion, and the audio power level that drives the waveform and the wake-word silence detector. |
| `windows/src/renderer/tokens.css` | ~150 | The design system: type scale, spacing, radii, colour, elevation, motion, focus ring. Everything else references these. |
| `windows/src/renderer/icons.ts` | ~139 | The SVG icon set that replaced emoji across the UI. |
| `windows/src/renderer/brand.css` | ~15 | The Ustaad mark as an inline data URI, used by the tray, panel, island and selection UI. |
| `windows/package.json` | ~75 | TypeScript, tests, Electron runtime, and x64/ARM64 NSIS packaging configuration. |
| `worker/src/index.ts` | ~141 | Cloudflare Worker proxy. Three routes: `/chat` (Claude), `/tts` (ElevenLabs), `/transcribe-token` (AssemblyAI temp token). |

## Build & Run

### Windows

```bash
cd windows
npm install
npm test                 # compile main + renderers and run unit tests
npm run typecheck        # tsc for the main/preload project and the renderer project
npm run dev              # run from source on Windows
npm run package:win      # x64 + ARM64 NSIS installers in windows/release/
```

The Windows client needs **either** a user-supplied Gemini API key (paste it in the panel's setup tab; it is stored on that PC only) **or** a deployed Worker base URL. Neither path is required to build or test the client.

The Windows client requires Node.js 22.12+ for the pinned build toolchain. Run packaging on Windows; CI uses `windows-latest`.

Installers are unsigned unless a signing provider is configured. Two are supported: a `.pfx` through the `WINDOWS_CODE_SIGNING_CERTIFICATE` and `WINDOWS_CODE_SIGNING_CERTIFICATE_PASSWORD` secrets (electron-builder's built-in `CSC_LINK` path), or Azure Artifact Signing through the four `AZURE_CODE_SIGNING_*` secrets plus Azure's `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`. `windows/electron-builder.signing.js` is the packaging config the `package:win` scripts use: it spreads `package.json`'s `build` block and adds `win.azureSignOptions` only when all four Azure values are present, and it throws when only some are — a half-configured signing setup must never produce installers that look signed and are not. An empty `CSC_LINK` means "no certificate configured", so unsigned builds keep working unchanged. CI verifies every signature when either provider is configured, and Windows refuses unsigned installers two different ways — SmartScreen's "Run anyway" and Smart App Control's outright, machine-wide block — which `windows/README.md` documents along with provider eligibility and alternatives.

Use `./node_modules/.bin/tsc` (or the npm scripts) rather than a bare `npx tsc`, which can install an unrelated package named `tsc`.

### Cloudflare Worker

```bash
cd worker
npm install

# Add secrets
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ASSEMBLYAI_API_KEY
npx wrangler secret put ELEVENLABS_API_KEY

# Deploy
npx wrangler deploy

# Local dev (create worker/.dev.vars with your keys)
npx wrangler dev
```

## Code Style & Conventions

### Variable and Method Naming

IMPORTANT: Follow these naming rules strictly. Clarity is the top priority.

- Be as clear and specific with variable and method names as possible
- **Optimize for clarity over concision.** A developer with zero context on the codebase should immediately understand what a variable or method does just from reading its name
- Use longer names when it improves clarity. Do NOT use single-character variable names
- Example: use `originalQuestionLastAnsweredDate` instead of `originalAnswered`
- When passing props or arguments to functions, keep the same names as the original variable. Do not shorten or abbreviate parameter names. If you have `currentCardData`, pass it as `currentCardData`, not `card` or `cardData`

### Code Clarity

- **Clear is better than clever.** Do not write functionality in fewer lines if it makes the code harder to understand
- Write more lines of code if additional lines improve readability and comprehension
- Make things so clear that someone with zero context would completely understand the variable names, method names, what things do, and why they exist
- When a variable or method name alone cannot fully explain something, add a comment explaining what is happening and why

### Electron/TypeScript Conventions

- Keep provider networking and native desktop integrations in the main process
- Keep `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false` for every renderer
- Add renderer capabilities through typed, narrow preload methods; never expose Electron's `ipcRenderer` object
- Treat display coordinates as top-left-origin Windows desktop coordinates and test negative monitor origins
- The panel window is the persistent audio host; hide it instead of destroying it
- Keep renderer code as browser-native ES modules and main/preload code as CommonJS; the build intentionally compiles them into separate intermediate outputs
- Keep the PowerShell helper scripts ASCII-only and written with a UTF-8 BOM: PowerShell 5.1 reads un-BOM'd files as ANSI, and a smart quote would silently break a user's install. `tests/windows-scripts.test.ts` enforces this
- Prefer pure modules with injected dependencies for anything with rules (policy, parsing, state machines, the agent loop). It is what makes the behaviour testable without a Windows machine
- Run both `npm test` and `npm run typecheck` after Windows changes

### The Mark and the Accent

Ustaad's identity is one shape and one colour.

- The mark is a folded, faceted "U" with a lit blade in its counter: `windows/assets/ustaad-mark.svg` (low key, for light backgrounds) and `ustaad-mark-light.svg` (high key, for dark surfaces). `tray.svg`, `icon.png`, `icon.ico`, `tray.png` and the inlined mark in `brand.css` are all **rendered from those two files** — edit the SVG and re-render, never hand-edit a PNG or the base64 blob.
- The app tile and the tray icon are separate renders on purpose: a bare dark mark disappears into a dark Windows 11 taskbar, so the tile carries the high-key mark on a graphite slab, and the tray keeps a dark hairline so it holds on a light taskbar too. Every size in `icon.ico` (16 → 256) comes from that one tile.
- The blade's lime is the interface's accent: `--ustaad-accent: #b6e800`, with `--ustaad-accent-bright: #d8ff4d` for glows and hover. It is the only colour in the product. Anything that used to be blue — links, focus rings, the listening glow, the active tab — is the accent now, and the aliases (`--blue`, `--island-blue`) point at it, so do not introduce a second hue.
- Text that sits on the accent, or on an accent-tinted surface, uses an ink measured against the lime rather than a neutral: `#e6ff9c` for accent-proximate copy.

### Neumorphic Interface Conventions

The interface is soft UI (neumorphism), and two rules keep it from falling apart:

- **A shape's background must equal its parent's surface.** Depth comes from shadows, never from a lighter fill or a border. Setting a card to a different colour than the canvas flattens everything inside it, so `--ustaad-surface` is deliberately the same value as `--ustaad-canvas`.
- **Raised means two shadows outward; pressed means the same two shadows inward.** Use `--ustaad-neu-raised*` for anything that sits above the surface and `--ustaad-neu-inset*` for anything carved into it (inputs, toggles, tracks, wells, and the active state of any button).

Further rules that follow from those:

- Never draw a border to separate two things on the same surface. Use an inset hairline (`inset 0 1px 0 var(--ustaad-line)`) or a shadow, and keep those shadows out of colour: they are translucent black and translucent white, so they work on any surface.
- Anything clickable must visibly change depth on hover and again while held. A control that only changes colour reads as flat and breaks the metaphor.
- `tokens.css` owns the depth values. Do not hand-write `box-shadow` in a component sheet; add a token instead.
- Text contrast does not get softened for the sake of the look: `--ustaad-ink` on `--ustaad-canvas` stays above 4.5:1.

### Do NOT

- Do not add features that were not asked for. Feature work is in scope only when the user asks for it — and then it is fully in scope: build all of what was asked, not a convenient subset
- Do not make unrelated refactors or "improvements" while fixing something else
- Do not add docstrings, comments, or type annotations to code you did not change
- Do not enable Electron Node integration, disable renderer sandboxing, or send provider API keys to a renderer
- Do not build Windows installers on macOS/Linux and assume they work; use the Windows CI job or a Windows machine
- Do not let anything run on the PC without passing through `system-access.ts`, and do not write to a path outside the user's own folders

## Git Workflow

- Branch naming: `feature/description` or `fix/description`
- Commit messages: imperative mood, concise, explain the "why" not the "what"
- Do not force-push to main

## Self-Update Instructions

<!-- AI agents: follow these instructions to keep this file accurate. -->

When you make changes to this project that affect the information in this file, update this file to reflect those changes. Specifically:

1. **New files**: Add new source files to the "Key Files" table with their purpose and approximate line count
2. **Deleted files**: Remove entries for files that no longer exist
3. **Architecture changes**: Update the architecture section if you introduce new patterns, frameworks, or significant structural changes
4. **Build changes**: Update build commands if the build process changes
5. **New conventions**: If the user establishes a new coding convention during a session, add it to the appropriate conventions section
6. **Line count drift**: If a file's line count changes significantly (>50 lines), update the approximate count in the Key Files table

Do NOT update this file for minor edits, bug fixes, or changes that don't affect the documented architecture or conventions.
