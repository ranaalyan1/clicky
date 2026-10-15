# Hitodama Open for Windows

This directory is the Windows client for Hitodama Open, an independent open-source desktop companion inspired by Hitodama's voice-first interaction model. It is not affiliated with Hitodama's developers.

The client is an Electron 44 application written in TypeScript. It lives in the notification area, provides a compact panel and optional island, and keeps provider calls and desktop automation in the main process. Renderers are sandboxed, context-isolated, and have no Node integration.

## Requirements

- Windows 10 or Windows 11 for the full client
- Node.js 22.12 or newer
- A Gemini API key, a local model server, or your own Worker
- A microphone only for voice input; typed chat works without one

The code can be built and unit-tested on other operating systems, but Windows-only pieces such as the keyboard hook, PowerShell bridge, screen capture, and Windows speech are unavailable there.

## Development

```powershell
npm ci
npm run dev
```

Useful commands:

```powershell
npm run typecheck       # main, preload, renderer
npm test                # build and run the Node test suite
npm run build           # produce dist/ without launching Electron
npm run package:win     # x64 + arm64 NSIS installers
npm run package:win:dir # unpacked directories for local smoke testing
```

The Electron binary is downloaded by npm from the Electron distribution during install. If a restricted network prevents that download, `npm run typecheck` and `npm test` still validate the TypeScript build, but Electron itself cannot be launched until the binary is available.

## First run

The first panel opens on **setup → brain**. Hitodama Open has no required hosted service:

1. Select **your own Gemini key** and paste a Google AI Studio key, or select **on this PC** and enter an Ollama/LM Studio-compatible endpoint.
2. Press **save & test**.
3. Use **type to ask** on the home page. A microphone and the global hook are optional.
4. Enable screen vision, automation, wake word, clipboard history, and other abilities only when you want them.

The optional Worker provider is for a Worker deployed by you. Its source is in `../worker` and no Worker URL or provider secret is built into the client.

## Architecture

```text
src/main/
  main.ts                 Electron lifecycle, tray, IPC authorization
  ustaad-controller.ts    interaction state, text/voice turns, scheduling
  brain-router.ts         Gemini / local / Worker provider selection
  action-protocol.ts      constrained action parsing and risk classification
  system-access.ts        file, registry, and command policy
  system-actions.ts       approved desktop actions and undo hooks
  windows-bridge.ts       long-lived PowerShell/C# input/media helper
  screen-capture.ts       display capture and region crops
src/preload/
  preload.ts              narrow typed IPC surface
src/renderer/
  panel.*                 setup, typed chat, push-to-talk, history
  island.*                optional top-of-screen status and confirmations
  overlay.*               optional cursor and pointing UI
  selection.*             circle-to-ask and snip lasso
src/shared/
  contracts.ts            main/renderer data contracts
```

The `Ustaad*` class and IPC names are compatibility internals retained from the earlier Clicky/Ustaad builds; the installed product and user-facing name are Hitodama Open.

### Interaction flow

- Voice and typed questions enter the same `UstaadController.completeInteraction` pipeline.
- The controller chooses whether to capture screen images based on the `screenVision` ability.
- `BrainRouter` selects the configured provider. Offline mode can only select the local provider.
- The model's spoken text and constrained actions are separated by `action-protocol.ts`.
- Actions are filtered by ability and confirmation mode, then run by `system-actions.ts` or the controller's safe stores.
- Every update is published to the panel and island through the preload bridge.

### Failure boundaries

The app is intentionally resilient at optional boundaries:

- `uiohook-napi` is loaded lazily. A missing or incompatible native hook leaves typed chat available.
- The cursor overlay and island are best-effort renderer windows. A failed optional renderer does not take down the panel.
- Startup rejection is caught and written to `hitodama-open-errors.log` before a readable error dialog is shown.
- Unexpected runtime exceptions are logged and surfaced in the panel rather than becoming a silent process exit.
- Settings and feature stores sanitize corrupt JSON and use temporary files for writes.

## Data and privacy

Settings and local stores live under Electron's user-data directory. Typical files include `settings.json`, `memory.json`, `todos.json`, `schedules.json`, `skills.json`, `clipboard-history.json`, and `audit-log.json`.

No telemetry or project-owned backend is present. A configured cloud provider receives only the requests the user submits, along with enabled screenshots or audio needed for that request. Local mode keeps model traffic on the configured local endpoint. Offline mode refuses features that require a network rather than silently using one.

## Packaging and signing

`npm run package:win` creates:

```text
release/Hitodama-Open-Setup-<version>-x64.exe
release/Hitodama-Open-Setup-<version>-arm64.exe
```

The build is unsigned unless the CI signing environment is fully configured. See `electron-builder.signing.js` and `.github/workflows/windows.yml`. Do not claim an installer is signed unless `Get-AuthenticodeSignature` reports `Valid`.

## Troubleshooting

### The app will not open

Run `npm run build` and check that these files exist:

```text
dist/src/main/main.js
dist/src/preload/preload.js
dist/src/renderer/panel.html
dist/src/renderer/panel.js
```

On a packaged build, check `hitodama-open-errors.log` in the app-data directory. A native hook failure is non-fatal; the panel should still offer typed chat and the hold-to-talk control.

### Typed chat says no brain is connected

Choose a provider in setup. Gemini keys must be at least 20 characters and are stored locally. Local endpoints must be on this computer or your own network. Start the selected model before pressing **save & test**.

### The screen is black or the cursor is missing

Screen vision and the cursor overlay are independent abilities. Turn them on in **soul → abilities**, then retry. Windows display drivers, secure surfaces, UAC prompts, lock screens, and protected games can refuse capture or synthetic input.

### The global shortcut is unavailable

This is expected on a machine where the native hook cannot load or security software blocks it. The panel text box remains usable. Check the architecture, reinstall dependencies with `npm ci`, and restart the app after changing security policy.

## Testing

The tests cover the provider router, settings sanitization, action protocol, safety policy, agent loop, stores, timing, capture coordinate math, wake-word parsing, renderer asset references, and packaging configuration. Run them from this directory with `npm test`.
