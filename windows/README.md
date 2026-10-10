# Clicky for Windows

This is the Windows 10/11 client for Clicky. It is a system-tray app with the same core interaction as the original macOS client:

- Hold **Ctrl + Alt** globally to talk, then release to submit.
- Stream 16 kHz PCM microphone audio to AssemblyAI for transcription.
- Capture and label every connected monitor for Claude vision.
- Speak Claude's response with ElevenLabs, with an installed Windows voice as fallback.
- Keep a transparent, click-through blue cursor next to the pointer.
- Animate the cursor to a screen element returned in a `[POINT:x,y:label:screenN]` tag.
- Keep all provider API keys in the existing Cloudflare Worker.

## Requirements

- Windows 10 version 22H2 or Windows 11 (64-bit x64 or ARM64)
- Node.js 22.12 or newer when building from source
- A deployed Clicky Cloudflare Worker (see the repository's root `README.md`)
- Microphone access when Windows asks on the first push-to-talk interaction

Windows does not require the macOS Accessibility or Screen Recording permissions. Clicky captures the desktop through Electron's Windows capture API and never sends a screenshot until a push-to-talk request is submitted.

## Run from source

From PowerShell:

```powershell
cd windows
npm install
npm run dev
```

Clicky appears in the Windows notification area. On the first launch, its panel opens automatically:

1. Paste the base URL printed by `npx wrangler deploy`, without `/chat` or another route.
2. Select **save & test**. The test verifies the Worker's AssemblyAI token route.
3. Hold **Ctrl + Alt**, speak, and release both keys.
4. Approve microphone access if Windows asks.

For a local Worker, `http://localhost:8787` is accepted. Remote Worker URLs must use HTTPS.

## Build the installer

On Windows:

```powershell
cd windows
npm ci
npm test
npm run package:win
```

The NSIS installers are written to `windows/release/`:

- `Clicky-Setup-<version>-x64.exe`
- `Clicky-Setup-<version>-arm64.exe`

The installer is per-user, offers an install location, creates Start Menu and desktop shortcuts, and preserves Clicky's settings on uninstall. The app can register itself to start when the user signs in; this is controllable in the panel.

CI also launches the packaged x64 application for ten seconds before accepting a build. This catches missing native binaries, invalid preload paths, and main-process startup crashes that compilation alone cannot detect.

To create an unpacked application directory while developing:

```powershell
npm run package:win:dir
```

### Publish a Windows release

Maintainers can publish durable GitHub Release assets from **Actions → Windows client → Run workflow** on the `main` branch. Enter a release tag matching the package version, such as `windows-v1.0.0`. The workflow rebuilds and smoke-tests both installers before creating the release. Publishing a `windows-v*` GitHub Release through the CLI or web UI also triggers the same guarded build and attaches both installers to that release.

The generated open-source installers are not code-signed. Windows SmartScreen may therefore show an unrecognized-app warning until a signing certificate is configured.

## Test and type-check

```powershell
npm test
npm run typecheck
```

The tests cover Worker URL validation and persistence, chunked SSE parsing, global modifier transitions (including AltGr avoidance), point-tag parsing, and coordinate mapping for monitors with negative desktop origins.

## Architecture

```text
windows/
  src/main/
    main.ts                    Electron lifecycle and secure IPC
    clicky-controller.ts       Push-to-talk → vision → speech state machine
    desktop-windows.ts         tray, settings panel, and per-monitor overlays
    transcription-session.ts   AssemblyAI v3 websocket client
    claude-client.ts           Claude SSE and ElevenLabs clients
    screen-capture.ts          multi-monitor capture and labeling
    pointing.ts                [POINT] parsing and Windows coordinate mapping
  src/preload/preload.ts       context-isolated renderer API
  src/renderer/
    panel.*                    tray panel and microphone/audio runtime
    overlay.*                  click-through cursor and pointing animation
  tests/                       Node test suite for platform-neutral logic
```

The Electron renderers are sandboxed with context isolation and no Node integration. The preload exposes a narrow IPC API. Provider requests run in the main process, and raw long-lived API keys remain in the Cloudflare Worker.

## Shortcut details

Clicky tracks physical key-down and key-up events through `uiohook-napi`, which is necessary for true push-to-talk behavior. Either Control key works, and the shortcut requires **left Alt**. Requiring left Alt intentionally avoids triggering on the Windows AltGr sequence used by many international keyboard layouts.

If the global listener cannot start, the tray panel remains usable through its **hold to talk** button.

## Troubleshooting

- **The panel says the Worker is not connected:** confirm you entered only the base URL and deployed all three Worker secrets.
- **No microphone prompt appeared:** open **Settings → Privacy & security → Microphone** and allow desktop apps to access the microphone.
- **Ctrl + Alt does nothing:** exit and restart Clicky. Security tools that block global keyboard hooks may require Clicky to be allow-listed; the hold-to-talk button remains available.
- **The wrong monitor is targeted:** run `npm test` first, then report the monitor layout and Windows display scaling values.
- **The app is still running after the panel closes:** this is expected. Use **Quit Clicky** from the tray icon's context menu.
