Update: April 27, 2026.

Hi there! I'm Farza, the guy that made Clicky.

The existing codebase remains open source. Tinker with it, make it yours, start a company out of it, do whatever you want I don't mind. But, for all the new stuff I'm hacking on, gonna keep it private. To get the latest Clicky, you can go [here](https://www.heyclicky.com/).

I also tweeted about this [here](https://x.com/FarzaTV/status/2043402737828962489).

Go crazy with this repo!! It's an MIT license.

# Hi, this is Clicky.
It's an AI teacher that lives as a buddy next to your cursor. It can see your screen, talk to you, and even point at stuff. Kinda like having a real teacher next to you.

Download it [here](https://www.clicky.so/) for free.

Here's the [original tweet](https://x.com/FarzaTV/status/2041314633978659092) that kinda blew up for a demo for more context.

![Clicky — an AI buddy that lives on your desktop](clicky-demo.gif)

This is the open-source version of Clicky for those that want to hack on it, build their own features, or just see how it works under the hood.

## Platforms

| Platform | Client | Global push-to-talk | Multi-monitor vision | Installer |
|---|---|---:|---:|---:|
| Windows 10/11 | Electron + Windows desktop APIs | Ctrl + Alt | Yes | NSIS `.exe` |
| macOS 14.2+ | SwiftUI + AppKit | Control + Option | Yes | Xcode / DMG |

### Run the Windows client

After deploying the Cloudflare Worker in the manual setup below:

```powershell
cd windows
npm install
npm run dev
```

Paste the deployed Worker base URL into the panel and select **save & test**. Clicky then lives in the Windows notification area. Hold **Ctrl + Alt** from any app, speak, and release to submit. To build x64 and ARM64 installers, run `npm run package:win` on Windows.

See [`windows/README.md`](windows/README.md) for Windows requirements, architecture, packaging, tests, permission details, and troubleshooting.

## Get started with Claude Code (macOS)

The fastest way to get this running is with [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Once you get Claude running, paste this:

```
Hi Claude.

Clone https://github.com/farzaa/clicky.git into my current directory.

Then read the CLAUDE.md. I want to get Clicky running locally on my Mac.

Help me set up everything — the Cloudflare Worker with my own API keys, the proxy URLs, and getting it building in Xcode. Walk me through it.
```

That's it. It'll clone the repo, read the docs, and walk you through the whole setup. Once you're running you can just keep talking to it — build features, fix bugs, whatever. Go crazy.

## Manual setup

If you want to do it yourself, here's the deal.

### Prerequisites

- **Windows client:** Windows 10 22H2 or Windows 11, plus Node.js 22.12+
- **macOS client:** macOS 14.2+ (for ScreenCaptureKit) and Xcode 15+
- Node.js 18+ for deploying the Cloudflare Worker
- A [Cloudflare](https://cloudflare.com) account (free tier works)
- API keys for: [Anthropic](https://console.anthropic.com), [AssemblyAI](https://www.assemblyai.com), [ElevenLabs](https://elevenlabs.io)

### 1. Set up the Cloudflare Worker

The Worker is a tiny proxy that holds your API keys. The app talks to the Worker, the Worker talks to the APIs. This way your keys never ship in the app binary.

```bash
cd worker
npm install
```

Now add your secrets. Wrangler will prompt you to paste each one:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ASSEMBLYAI_API_KEY
npx wrangler secret put ELEVENLABS_API_KEY
```

For the ElevenLabs voice ID, open `wrangler.toml` and set it there (it's not sensitive):

```toml
[vars]
ELEVENLABS_VOICE_ID = "your-voice-id-here"
```

Deploy it:

```bash
npx wrangler deploy
```

It'll give you a URL like `https://your-worker-name.your-subdomain.workers.dev`. Copy that.

### 2. Run the Worker locally (for development)

If you want to test changes to the Worker without deploying:

```bash
cd worker
npx wrangler dev
```

This starts a local server (usually `http://localhost:8787`) that behaves exactly like the deployed Worker. You'll need to create a `.dev.vars` file in the `worker/` directory with your keys:

```
ANTHROPIC_API_KEY=sk-ant-...
ASSEMBLYAI_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
```

Then update the proxy URLs in the Swift code to point to `http://localhost:8787` instead of the deployed Worker URL while developing. Grep for `clicky-proxy` to find them all.

### 3. Connect a client to the Worker

#### Windows

Run the Windows client and paste the Worker base URL into its first-launch panel. The URL is validated and stored under the current Windows user's application data; no source edit is needed.

```powershell
cd windows
npm install
npm run dev
```

#### macOS

The Swift app has the Worker URL hardcoded in a few places. Search for `your-worker-name.your-subdomain.workers.dev` and replace it with your Worker URL:

```bash
grep -r "clicky-proxy" leanring-buddy/
```

You'll find it in:
- `CompanionManager.swift` — Claude chat + ElevenLabs TTS
- `AssemblyAIStreamingTranscriptionProvider.swift` — AssemblyAI token endpoint

### 4. Open the macOS client in Xcode and run

```bash
open leanring-buddy.xcodeproj
```

In Xcode:
1. Select the `leanring-buddy` scheme (yes, the typo is intentional, long story)
2. Set your signing team under Signing & Capabilities
3. Hit **Cmd + R** to build and run

The app will appear in your menu bar (not the dock). Click the icon to open the panel, grant the permissions it asks for, and you're good.

### Permissions the apps need

**Windows:**
- **Microphone** — requested on the first push-to-talk interaction
- Desktop screenshots and the global shortcut use Windows desktop APIs and do not show separate macOS-style permission prompts

**macOS:**
- **Microphone** — for push-to-talk voice capture
- **Accessibility** — for the global keyboard shortcut (Control + Option)
- **Screen Recording** — for taking screenshots when you use the hotkey
- **Screen Content** — for ScreenCaptureKit access

## Architecture

If you want the full technical breakdown, read `CLAUDE.md`. But here's the short version:

**Windows:** a sandboxed Electron system-tray client with a frameless control panel and one transparent, click-through overlay per monitor. A native global key listener provides press/release semantics for Ctrl + Alt, Chromium captures microphone audio, and Electron captures displays. Provider networking stays in the main process behind a context-isolated preload bridge.

**macOS:** a menu bar app (no dock icon) with `NSPanel` windows for the control panel and transparent cursor overlays. AppKit, AVFoundation, and ScreenCaptureKit provide the native integrations.

On both platforms, push-to-talk streams audio over a websocket to AssemblyAI, sends the transcript plus screenshots to Claude via streaming SSE, and plays the response through ElevenLabs TTS. Claude can embed `[POINT:x,y:label:screenN]` tags in responses to make the cursor fly to a specific UI element across multiple monitors. Long-lived provider keys stay in the Cloudflare Worker; clients use only its proxy routes and short-lived AssemblyAI tokens.

## Project structure

```
leanring-buddy/          # Swift source (yes, the typo stays)
  CompanionManager.swift    # Central state machine
  CompanionPanelView.swift  # Menu bar panel UI
  ClaudeAPI.swift           # Claude streaming client
  ElevenLabsTTSClient.swift # Text-to-speech playback
  OverlayWindow.swift       # Blue cursor overlay
  AssemblyAI*.swift         # Real-time transcription
  BuddyDictation*.swift     # Push-to-talk pipeline
windows/                 # Windows system-tray client (Electron + TypeScript)
  src/main/                 # native integrations, state machine, provider clients
  src/renderer/             # settings panel, microphone runtime, cursor overlays
  tests/                    # Windows-client unit tests
worker/                  # Cloudflare Worker proxy
  src/index.ts              # Three routes: /chat, /tts, /transcribe-token
CLAUDE.md                # Full architecture doc (agents read this)
```

## Contributing

PRs welcome. If you're using Claude Code, it already knows the codebase — just tell it what you want to build and point it at `CLAUDE.md`.

Got feedback? DM me on X [@farzatv](https://x.com/farzatv).
