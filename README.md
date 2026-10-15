# Hitodama Open

Hitodama Open is an independent, open-source Windows desktop companion inspired by the useful parts of Hitodama: a small voice-first assistant that can see the screen you choose to share, answer out loud, and perform carefully-confirmed desktop actions.

It is **not affiliated with or endorsed by Hitodama's developers**. The project is MIT licensed and is designed to be inspectable, self-hostable, and useful without a proprietary account or hosted backend.

## The goal: a small thing that works

The previous build tried to be an entire operating system. Hitodama Open focuses on the loop that matters:

1. Open the tray panel.
2. Type a question or hold **Ctrl + Alt** and talk.
3. Optionally let it see your screen.
4. Get a concise answer, and approve any action before it clicks, types, or changes your PC.

Typing is a first-class input, not a fallback hidden behind a microphone permission. If the global keyboard hook, microphone, speech recognizer, or native Windows helper is unavailable, the panel still opens and typed questions still work.

### What is included

- **Typed chat and push-to-talk** in the same response pipeline.
- **Bring-your-own Gemini key**: no Hitodama Open server is required.
- **Local models** through Ollama, LM Studio, Jan, or another OpenAI-compatible local endpoint.
- **Optional Cloudflare Worker** for people who want Claude, AssemblyAI, or ElevenLabs behind their own deployment.
- **Screen context** from one or all displays, only when the screen-vision ability is enabled.
- **Circle to ask**, dictation, a small top-of-screen island, memory, to-dos, timers, snippets, and reminders.
- **Desktop actions** such as opening apps, typing, media control, and web searches through a typed action protocol.
- **Safety controls**: confirmations, ability switches, a panic shortcut, undo where possible, and an audit log.
- **Offline mode**: use a model running on your own machine and the installed Windows voice. Cloud transcription is disabled in this mode.
- **No telemetry**: settings, history, memory, and logs stay in the local app-data folder unless a configured model provider receives a request.

Advanced abilities are opt-in where they can surprise you. Auto-start and scheduled presence are off on a fresh install. A model never receives a screenshot unless screen vision is enabled for the request.

## Quick start

### Option A: run from source

Windows 10 or 11, Node.js 22.12 or newer:

```powershell
cd windows
npm install
npm run dev
```

The panel opens on first launch. Choose one of these in **setup → brain**:

- **Your own Gemini key** from [Google AI Studio](https://aistudio.google.com/api-keys). The key is stored on this PC only.
- **On this PC** with Ollama, LM Studio, Jan, or another compatible local server. The default Ollama address is `http://127.0.0.1:11434`.
- **Your own Worker** if you want to proxy provider keys away from the desktop.

You can use the text box immediately after connecting a brain. The microphone is optional.

### Build an installer

```powershell
cd windows
npm ci
npm test
npm run package:win
```

The unsigned installers are written to `windows/release/` as:

- `Hitodama-Open-Setup-<version>-x64.exe`
- `Hitodama-Open-Setup-<version>-arm64.exe`

Unsigned Windows binaries may trigger SmartScreen or Smart App Control. For personal builds, run from source or use a certificate you control; do not disable Windows security just to run an unknown download.

## Providers

The desktop client never requires our infrastructure:

| Provider | Best for | What leaves the PC |
| --- | --- | --- |
| Gemini | The simplest setup and vision, transcription, and speech | The prompt, enabled screenshots, and audio sent to Google |
| Local model | Privacy and no per-request bill | Nothing to a cloud provider; requests stay on the configured local endpoint |
| Worker | Your own proxy for Claude, AssemblyAI, and ElevenLabs | The request goes to your Worker, which you operate |

Use **offline mode** when the promise must be strict: Hitodama Open will only use the local brain, Windows speech, and local tools. It will refuse cloud transcription, web research, image generation, the phone window, and cloud wake-word mode instead of quietly falling back online.

The optional Worker is in [`worker/`](worker/). Deploy it with your own secrets:

```bash
cd worker
npm ci
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ASSEMBLYAI_API_KEY
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler deploy
```

No Worker URL is hard-coded into the client.

## Controls

- **Ctrl + Alt**: hold to talk.
- **Ctrl + Shift**: hold, circle a region, and ask about it.
- **Ctrl + Windows**: hold to dictate into the focused app; this can be changed in setup.
- **Ctrl + Alt + S**: make a screen snip.
- **Ctrl + Alt + Q**: stop listening, speech, queued work, confirmations, and desktop automation.
- **Escape**: cancel a circle, snip, or running task.

The panel's **type to ask** box is always available. It uses the same screen context, tools, confirmation queue, and optional spoken reply as voice input.

## Privacy and safety

The app is local-first, but a provider can only answer by receiving the data needed for the request. The panel shows which brain is active. Screen vision, clipboard history, wake word, system access, and automation can each be switched off.

Desktop actions are parsed from a constrained `<actions>` block. Risky actions wait in the island for approval unless you explicitly change confirmation settings. Commands, file operations, and registry reads are handled by one policy module and written to the audit log. Credentials, elevation, security weakening, and protected credential stores are refused.

## Troubleshooting

### The app disappears at launch

The native global keyboard hook is optional. If it cannot load, Hitodama Open now keeps running with the panel text box and hold-to-talk button. Restarting the app is not supposed to be necessary for ordinary hook failure.

If the Electron client itself cannot create a window, check:

- `hitodama-open-errors.log` in the app's user-data folder;
- that `windows/dist/src/renderer/` exists after `npm run build`;
- that the installed architecture matches the machine (`x64` or `arm64`);
- Windows microphone permission if voice is the only feature that fails.

### The brain is not connected

Open **setup**, select the provider you actually run, and use **save & test**. A local model must be running and its model name must match the name loaded by the server. A Gemini key must be copied without spaces or quotes.

### Global shortcuts do nothing

Use the panel text box first. Then restart the app, check security software that blocks keyboard hooks, and confirm that the app architecture matches the installed `uiohook-napi` binary. The panel reports when global shortcuts are unavailable instead of pretending they are active.

### Voice does not work

Allow desktop apps to use the microphone in **Windows Settings → Privacy & security → Microphone**. Text chat does not need a microphone. Gemini transcription needs a Gemini key; local text models do not automatically provide speech recognition.

## Project structure

```text
windows/
  src/main/       Electron lifecycle, providers, state, tools, safety, storage
  src/preload/    narrow context-isolated IPC bridge
  src/renderer/   panel, island, overlays, audio capture and playback
  src/shared/     contracts shared by main and renderer
  tests/          platform-neutral Node tests
worker/           optional Cloudflare Worker proxy
.github/          Windows validation, packaging, and smoke-test workflow
```

The main process owns provider networking, settings, capture, native integration, and action execution. Renderers have no Node integration and receive only the typed preload API. JSON stores use sanitized values and atomic writes so a corrupt or interrupted settings file does not take the app down.

## Development checks

```powershell
cd windows
npm run typecheck
npm test
```

`npm test` builds both main and renderer code before running the unit tests. Do not commit `node_modules`, `dist`, `release`, local Worker secrets, or generated user data.

## Contributing

Small, working changes are preferred over another feature pile. Start with an issue or a focused pull request, include a regression test for platform-neutral behavior, and keep provider keys and screenshots out of commits. See [`AGENTS.md`](AGENTS.md) for the architecture rules.

## License

MIT. See [`LICENSE`](LICENSE).
