# Ustaad

Ustaad is the voice companion that lives on your Windows desktop. Hold a key, ask, and it answers out loud, points at things on your screen, and does the work — opening apps, clicking real buttons, typing, reading and writing files, running diagnostics.

This repository is **TypeScript end to end**: an Electron client in `windows/` and a Cloudflare Worker in `worker/`. There is no Swift code and no macOS client.

## Ustaad was Clickaa

Renamed in 1.2, along with the interface: soft, neumorphic surfaces, a three-step start card, and the same engine underneath. Settings, to-do lists, schedules, memory, skills and snippets are imported from the older `%APPDATA%\Clickaa` (and `%APPDATA%\Clicky`) folders on first launch, so nothing is retyped. Uninstall an older Clickaa before installing Ustaad — the installer identity changed with the name.

## What it does

- **Hold Ctrl + Alt** anywhere and talk about whatever is on your screen. Ustaad sees every display, answers in speech, and flies its cursor to the thing it mentions.
- **Multi-step tasks.** "go to youtube and play anything" is not a search result: Ustaad opens the page, looks at the screen, clicks the right spot, checks whether it worked, and corrects itself when it did not. One approval covers the task, **Escape** stops it.
- **Wake word.** Say "ustaad" and the island comes up with the microphone already open. It listens with the speech recognizer Windows ships, so no audio leaves the machine. Off until you switch it on.
- **Skills.** Do the same task a few times and Ustaad offers to save it by name. It only saves when you say yes, and every run still checks the screen and asks before it clicks or types.
- **Dictation (Ctrl + Windows).** Talk however you like; cleaned, punctuated text lands in the app you are already typing in.
- **Circle to ask (Ctrl + Shift).** Lasso part of the screen and ask about just that.
- **Snips (Ctrl + Alt + S).** Drag over any region; those pixels land on your clipboard and in `Pictures\Ustaad Snips`.
- **Clipboard brain.** "fix what i copied", "summarize this", "translate my clipboard into Urdu" — rewritten in place, with one click to put the old text back.
- **Timers and snippets.** "set a timer for 12 minutes" ticks in the island and ends with a notification; "insert my address" types a phrase you saved once.
- **Presence.** It wakes up on its own: a morning brief at the time you pick — today's routines, open and overdue to-dos, what ran overnight — and an evening recap of what it did and what is still open. Written from what is already on your PC, so it works offline; **check in now** in the panel shows you one immediately.
- **The island**, the notch at the top of every screen: now playing, to-do list, reminders and routines, memory, clipboard clips, launchable apps, wallpapers, timers, snippets and quick switches. It summons itself when your pointer touches the top edge, plays a microphone light while Ustaad is listening, and can be muted from the tray.
- **System access**, two switches in *soul → abilities*, both off by default: read-only diagnostics, registry reads and files in your own folders; plus a separate opt-in switch for arbitrary commands. Every attempt lands in an audit log, and **Ctrl + Alt + Q** stops everything mid-task.

## Install

Download the latest installer from [Releases](https://github.com/ranaalyan1/clicky/releases):

- `Ustaad-Setup-<version>-x64.exe` for almost every PC
- `Ustaad-Setup-<version>-arm64.exe` for Windows on ARM

The installers are unsigned, and Windows treats that two ways. **SmartScreen** shows "Windows protected your PC" and **More info → Run anyway** clears it. **Smart App Control**, on by default on clean Windows 11 installs, blocks unsigned apps outright and offers no way to allow a single one — if you see "Smart App Control blocked an app that may be unsafe", read [windows/README.md](windows/README.md#troubleshooting) before switching anything off, because on older Windows 11 builds that switch is a one-way trip. Either way, check the download is the file CI built:

```powershell
Get-FileHash .\Ustaad-Setup-1.1.0-x64.exe -Algorithm SHA256
```

The digest published on the release page must match. Then paste a [Google AI Studio](https://aistudio.google.com/api-keys) Gemini API key into the setup tab; the key is stored on that PC only.

## Two ways to give Ustaad a brain

| Path | What it needs | Where the keys live |
|---|---|---|
| **Gemini key** | A Google AI Studio key pasted into the panel | On your PC, in Windows application data |
| **Cloudflare Worker** | A deployed Worker plus provider keys | In the Worker, never on the device |

The Worker route also brings Claude vision, ElevenLabs speech and AssemblyAI transcription into play. If the selected provider has no key or URL yet, Ustaad uses the other one instead of failing.

Installers are built the same way in both cases: the assets attach to a GitHub release. Run `npm run package:win` on Windows to build them yourself.

## Run from source

```powershell
cd windows
npm install
npm run dev
```

Paste either the deployed Worker base URL (then **save & test**) or your own Gemini API key into the panel's setup tab. See [`windows/README.md`](windows/README.md) for requirements, architecture, packaging, tests, permissions and troubleshooting.

## The Cloudflare Worker

The Worker is a small proxy that holds long-lived provider keys so they never ship in a client.

```bash
cd worker
npm install
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ASSEMBLYAI_API_KEY
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler deploy
```

Set `ELEVENLABS_VOICE_ID` in `wrangler.toml` (it is not sensitive). For local development, `npx wrangler dev` runs the same routes against `http://localhost:8787` with a `worker/.dev.vars` file holding the same three keys.

| Route | Upstream | Purpose |
|---|---|---|
| `POST /chat` | `api.anthropic.com/v1/messages` | Claude vision and streaming chat |
| `POST /tts` | `api.elevenlabs.io/v1/text-to-speech/{voiceId}` | ElevenLabs speech |
| `POST /transcribe-token` | `streaming.assemblyai.com/v3/token` | A short-lived AssemblyAI websocket token |

## Architecture

A sandboxed Electron system-tray client. Provider networking, configuration, global shortcuts, screen capture and lifecycle state stay in the main process behind a context-isolated preload bridge (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`). The renderers are browser-native ES modules that handle only UI, microphone PCM, audio playback and overlay drawing.

The controller publishes an immutable state snapshot to the panel, the island and one transparent click-through overlay per display. `action-protocol.ts` parses the model's `<actions>` and `<task>` blocks and decides what needs confirmation; `agent-loop.ts` runs a task step by step (bounded in steps, corrections and time); `system-access.ts` is the whole safety policy for anything that touches the PC; `system-actions.ts` performs the work through a PowerShell/C# bridge. Clicks and keys go through Windows `SendInput`, coordinates are top-left-origin desktop coordinates including negative monitor origins, and every risky action offers an undo.

## Project structure

```
windows/                 # Windows system-tray client (Electron + TypeScript)
  src/main/                 #   native integrations, state machine, providers, agent loop
  src/renderer/             #   panel, island, cursor overlays, circle lasso, snip UI
  src/preload/              #   the typed IPC bridge
  tests/                    #   144 unit tests for the platform-neutral logic
  assets/                   #   icon set and installer artwork
worker/                  # Cloudflare Worker proxy (TypeScript)
  src/index.ts              #   /chat, /tts, /transcribe-token
AGENTS.md                # agent instructions and architecture notes
.github/workflows/       # build, validate, smoke-test and publish Windows releases
```

## Contributing

PRs welcome. Agents should read [`AGENTS.md`](AGENTS.md) first — `CLAUDE.md` is a symlink to it. Run `npm test` and `npm run typecheck` inside `windows/` before proposing a change.

## Credits

Ustaad is built on [Clicky](https://github.com/farzaa/clicky) by Farza, whose open-source macOS client started this project. The original Swift client has since been removed in favour of the TypeScript clients in this repository; it remains available in this repository's history at commit `629c868`. MIT licensed.
