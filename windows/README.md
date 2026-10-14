# Clickaa for Windows

Clickaa is the voice companion that lives on your Windows desktop: hold a key, ask, and it answers out loud, points at things on your screen, and acts on your PC.

- Hold **Ctrl + Alt** globally to ask about whatever is on your screen.
- Hold **Ctrl + Windows** to dictate: talk however you like, and cleaned, punctuated text lands in the app you are already typing in.
- Hold **Ctrl + Shift** and circle anything on screen with the mouse to ask about just that part.
- Press **Ctrl + Alt + S** and drag over any part of the screen: those pixels land on your clipboard and in `Pictures\Clickaa Snips`.
- **Skills** grow out of repetition: do the same task three times and Clickaa offers to save it by name ("save it as my morning videos?"). It only saves when you press the button, skills are renameable in **plans → skills**, and every run still checks the screen and asks before it clicks or types.
- **System access** is two switches in **soul → abilities**, both off until you ask. Tier 1 covers read-only diagnostics, registry reads and files inside your own six folders, each confirmed per action; Tier 2 covers arbitrary commands that change the PC, with its own warning. Clickaa refuses credential stores, browser password databases, elevation and anything that weakens Windows security whatever is switched on, and every attempt lands in an audit log in **memory → system access** with the raw command visible. **Ctrl + Alt + Q** stops everything mid-task.
- Say **"clickaa"** (once switched on) and the island comes up with the microphone already open: keep talking, and Clickaa submits on its own when you stop. It listens with the speech recognizer Windows already ships, so no audio leaves the machine, and the tray can mute it instantly.
- Give it a **task** rather than a single order — "go to youtube and play anything", "open my orders and check the last one" — and it works step by step: it clicks real buttons, looks at the screen to check what happened, and corrects itself when a step did not work. One approval covers the whole task; **Escape** stops it mid-task.
- Ask Clickaa to **summarise, tighten, grammar-check or translate** whatever you copied, and the clipboard is rewritten in place with one click to put the old text back.
- **Timers** ("set a timer for 12 minutes") tick down in the island and end with a notification, a chime-free spoken line, and a stop button.
- **Snippets** ("save this as my address", then "insert my address") type a saved phrase into whatever window has focus.
- Keep a transparent, click-through blue cursor next to the pointer that flies to the screen element it mentions.
- Jump to a spoken answer with the **island**, the notch at the top of every screen: now playing, to-do list, reminders and routines, clipboard, launchable apps, wallpapers and quick switches.
- Say "remember my brother's birthday is 4 March", "every morning at 9 open Unity and Spotify", or "search how to cook spaghetti on YouTube" and Clickaa keeps it and does it.
- Anything that touches your PC (**open apps, type text, press keys, change the wallpaper**) waits for a quick yes — in the island, or by saying "yes" out loud. Reminders, routines, to-dos and memory never interrupt.

## What a task looks like

For anything that takes more than one action, the model replies with a goal instead of an order:

```text
opening youtube now.
<task>play a video on youtube</task>
<actions>[{"type":"open_url","url":"https://youtube.com"}]</actions>
```

Clickaa then does one step, takes a fresh screenshot of every display, and asks the model a single question: is the goal met? The answer is `DONE`, `NEXT` (one more step, usually a `click_at` on a spot read off that screenshot) or `GIVE_UP`. The loop is bounded — 8 steps, 2 re-plans per step, 75 seconds — and a model that asks for the identical step twice is treated as stuck and handed back to you. Playback goals skip the screenshot question entirely: Clickaa asks Windows what is playing, which is cheaper and much harder to get wrong.

## Two ways to give Clickaa a brain

Clickaa needs a model to think with. Pick either, in the panel's **setup** tab:

1. **Your own Gemini API key** — make a free key at <https://aistudio.google.com/api-keys>, paste it into **setup → your own gemini key**, and press **save & test**. Talking, seeing your screen, dictation and acting all run on that one key, stored on this PC only, in `%APPDATA%\Clickaa\settings.json`. No Worker, no other account.
2. **A deployed Cloudflare Worker** — the original path, which keeps the Claude, AssemblyAI and ElevenLabs keys off this PC (see the repository's root `README.md`). Paste the Worker base URL into **setup → cloudflare worker**.

If both are configured, the provider selected in **setup** wins; if that provider has no key or URL yet, Clickaa uses the other one instead of failing.

## Requirements

- Windows 10 version 22H2 or Windows 11 (64-bit x64 or ARM64)
- Node.js 22.12 or newer when building from source
- A Gemini API key **or** a deployed Clickaa Cloudflare Worker
- Microphone access when Windows asks on the first interaction

Windows does not require the macOS Accessibility or Screen Recording permissions. Clickaa captures the desktop through Electron's Windows capture API and only sends a screenshot while an interaction you started is running.

## Run from source

From PowerShell:

```powershell
cd windows
npm install
npm run dev
```

Clickaa appears in the Windows notification area. On first launch its panel opens on the **setup** tab:

1. Make a key at <https://aistudio.google.com/api-keys> (or deploy the Worker).
2. Paste it and press **save & test**.
3. Hold **Ctrl + Alt**, speak, and release — then just talk to it.

There is a four-minute walkthrough of the whole setup at <https://youtu.be/bei_Cc8-CBw>.

## Build the installer

On Windows:

```powershell
cd windows
npm ci
npm test
npm run package:win
```

The NSIS installers are written to `windows/release/`:

- `Clickaa-Setup-<version>-x64.exe`
- `Clickaa-Setup-<version>-arm64.exe`

The installer is per-user, offers an install location, creates Start Menu and desktop shortcuts, and preserves Clickaa's settings on uninstall. The app can register itself to start when the user signs in; this is controllable in the panel.

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

The tests cover configuration and key validation, to-do, memory and schedule stores, action-protocol parsing and risk rules, spoken confirmation answers, dictation cleanup prompts, search targets, text matching, audio buffering and WAV encoding, chunked SSE parsing, global modifier transitions (including AltGr avoidance), point-tag parsing, and coordinate mapping for monitors with negative desktop origins.

## Architecture

```text
windows/
  src/main/
    main.ts                    Electron lifecycle, tray, and secure IPC
    clickaa-controller.ts      interactions, actions, confirmations, scheduler
    desktop-windows.ts         tray, panel, island, and per-monitor overlays
    brain-router.ts            Gemini key vs Cloudflare Worker, speech fallback
    gemini-client.ts           Gemini chat, speech, transcription, key checks
    claude-client.ts           Claude SSE, ElevenLabs speech, AssemblyAI tokens
    system-actions.ts          every Windows action, with undo where possible
    windows-bridge.ts          PowerShell/C# helper for keys, media, wallpaper
    action-protocol.ts         <actions> and <task> parsing, risk rules, ability filtering
    agent-loop.ts              plan, act, look, correct: the bounded task runner
    system-access.ts           the whole safety policy: what may run, and why not
    system-access-runner.ts    runs one command or one file operation, isolated
    audit-log-store.ts         the on-disk record of everything that was attempted
    skill-store.ts             tasks the user saved by name
    skill-suggestions.ts       when repeating a task becomes an offer to save it
    wake-word-listener.ts      the offline "clickaa" listener and its lifecycle
    wake-word-script.ts        the System.Speech helper that hears its own name
    screen-capture.ts          multi-monitor capture and circled-region crops
    pointing.ts                [POINT] parsing and Windows coordinate mapping
  src/preload/preload.ts       context-isolated renderer API
  src/renderer/
    panel.*                    settings, soul loadout, plans, memory, setup
    island.*                   the notch: music, plans, clips, apps, look, control
    overlay.*                  click-through cursor and pointing animation
    selection.*                circle-to-ask lasso
  tests/                       Node test suite for platform-neutral logic
```

The Electron renderers are sandboxed with context isolation and no Node integration. The preload exposes a narrow IPC API, and the main process re-checks the sender of every message. Provider requests run in the main process; when a Worker is used instead of a local Gemini key, the long-lived provider keys stay in the Worker.

## Shortcut details

Clickaa tracks physical key-down and key-up events through `uiohook-napi`, which is necessary for true push-to-talk behavior. Either Control key works, and the talk shortcut requires **left Alt**. Requiring left Alt intentionally avoids triggering on the Windows AltGr sequence used by many international keyboard layouts. **Escape** cancels a circling session, closes a snip, and stops a running task.

The wake word is **off until you switch it on** in **setup → wake word**. When it is on, saying the name summons the island and opens one listening window: silence for a moment closes it again without sending anything, and speech is submitted after a short pause. The microphone light in the island's notch stays visible the whole time Clickaa is listening, and the tray menu can mute it without changing the setting.

The dictation shortcut is configurable in **setup → keys**: **Ctrl + Windows** (default), **Ctrl + Shift + Space**, or **Caps Lock**. Windows itself opens the Start menu when Ctrl + Windows is released; if that bothers you, pick another shortcut.

If the global listener cannot start, the tray panel remains usable through its **hold to talk** button.

## Troubleshooting

- **The panel says the brain is not connected:** paste a full Gemini key (it starts with `AIza`), or a Worker base URL without `/chat` or another route.
- **Gemini rejects the key:** make sure the key is from <https://aistudio.google.com/api-keys> and, if you are in the EEA, UK or Switzerland, that the project has billing enabled.
- **No microphone prompt appeared:** open **Settings → Privacy & security → Microphone** and allow desktop apps to access the microphone.
- **Ctrl + Alt does nothing:** exit and restart Clickaa. Security tools that block global keyboard hooks may require Clickaa to be allow-listed; the hold-to-talk button remains available.
- **Windows opens the Start menu while dictating:** change the dictation shortcut in **setup → keys**.
- **The wrong monitor is targeted:** run `npm test` first, then report the monitor layout and Windows display scaling values.
- **An action ran that you did not want:** open the island and press **undo** on the entry; clipboard writes, typed text and window moves are all reversible.
- **The app is still running after the panel closes:** this is expected. Use **Quit Clickaa** from the tray icon's context menu.
