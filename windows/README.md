# Ustaad for Windows

Ustaad is the voice companion that lives on your Windows desktop: hold a key, ask, and it answers out loud, points at things on your screen, and acts on your PC.

- Hold **Ctrl + Alt** globally to ask about whatever is on your screen.
- Hold **Ctrl + Windows** to dictate: talk however you like, and cleaned, punctuated text lands in the app you are already typing in.
- Hold **Ctrl + Shift** and circle anything on screen with the mouse to ask about just that part.
- Press **Ctrl + Alt + S** and drag over any part of the screen: those pixels land on your clipboard and in `Pictures\Ustaad Snips`.
- **Run history**: every reply and every task is written down — what you asked, how it was answered, whether it finished, and how many steps it took — in a plain **`run-history.json`** in your user folder, beside the other stores. **memory → search the run history** finds it by the words you would actually use: type *receipts* and it finds the run that mentioned a receipt, showing the matching line rather than the top of the reply. It is searched in memory, not in a database, so it stays instant on a low-spec PC, and it follows the memory switch: with memory off nothing about your own words is written beyond the audit log.
- **Skills** grow out of repetition: do the same task three times and Ustaad offers to save it by name ("save it as my morning videos?"). It only saves when you press the button, skills are renameable in **plans → skills**, and every run still checks the screen and asks before it clicks or types.
- **Skills repair themselves, with your yes**: a saved skill that fails twice in a row is offered a second chance — the island says so, and **work out a fix** asks the model for a different way of reaching the same aim using only what you have already switched on. The new way is shown before it is saved: **save the fix** keeps it, **keep the old one** changes nothing and the question is not asked again until the skill has failed twice more. A run you stopped yourself never counts against a skill, and a repaired skill is confirmed per run exactly like the spoken version — repair never widens what Ustaad is allowed to touch.
- **Presence**: Ustaad wakes up on its own. A **morning brief** at the time you pick gathers today's routines and reminders, your open to-dos (overdue ones named) and what ran while you slept; an **evening recap** says what it did today, what is still open and what is coming tomorrow. The island's reminders card shows when the next one lands, the panel's **presence** card sets both times, and **check in now** delivers one on the spot. A brief is written from what is already on this PC — no model call, no network — so it works offline and cannot invent anything. A check-in whose moment passed while the PC was asleep is delivered late, and only within four hours: a morning brief at eight at night is not a brief.
- **Phone window**: Ustaad answers on your phone too. Switch it on in **setup → phone window** and the card shows one address to open on a phone that is on the same wi-fi — nothing to install, nothing to configure. It shows what is playing, your open to-dos, the next reminders and the last answer, and lets you ask a question in writing. **A question from a phone is read-only: it can never click, type, open, delete or approve anything**, so an unattended phone cannot change your PC. The address carries the pairing token, so treat it like a password and press **rotate the link** to unpair every phone at once; the window is off until you switch it on, and **Ctrl + Alt + Q** stops it with everything else. This is your own wi-fi only — the window is never exposed to the internet.
- **System access** is two switches in **soul → abilities**, both off until you ask. Tier 1 covers read-only diagnostics, registry reads and files inside your own six folders, each confirmed per action; Tier 2 covers arbitrary commands that change the PC, with its own warning. Ustaad refuses credential stores, browser password databases, elevation and anything that weakens Windows security whatever is switched on, and every attempt lands in an audit log in **memory → system access** with the raw command visible. **Ctrl + Alt + Q** stops everything mid-task.
- Say **"ustaad"** (once switched on) and the island comes up with the microphone already open: keep talking, and Ustaad submits on its own when you stop. It listens with the speech recognizer Windows already ships, so no audio leaves the machine, and the tray can mute it instantly.
- Give it a **task** rather than a single order — "go to youtube and play anything", "open my orders and check the last one" — and it works step by step: it clicks real buttons, looks at the screen to check what happened, and corrects itself when a step did not work. One approval covers the whole task; **Escape** stops it mid-task.
- Ask Ustaad to **summarise, tighten, grammar-check or translate** whatever you copied, and the clipboard is rewritten in place with one click to put the old text back.
- **Timers** ("set a timer for 12 minutes") tick down in the island and end with a notification, a chime-free spoken line, and a stop button.
- **Snippets** ("save this as my address", then "insert my address") type a saved phrase into whatever window has focus.
- Keep a transparent, click-through cursor next to the pointer that flies to the screen element it mentions.
- Jump to a spoken answer with the **island**, the notch at the top of every screen: now playing, to-do list, reminders and routines, clipboard, launchable apps, wallpapers and quick switches.
- Say "remember my brother's birthday is 4 March", "every morning at 9 open Unity and Spotify", or "search how to cook spaghetti on YouTube" and Ustaad keeps it and does it.
- Anything that touches your PC (**open apps, type text, press keys, change the wallpaper**) waits for a quick yes — in the island, or by saying "yes" out loud. Reminders, routines, to-dos and memory never interrupt.

## This build is called Ustaad

The app was **Clickaa**, and **Clicky** before that. Nothing about how it works changed with the name: on first launch Ustaad copies your settings, to-do list, schedules, memory, clipboard history, saved skills and snippets out of the older folder (`%APPDATA%\Clickaa`, then `%APPDATA%\Clicky`) and leaves the old folder in place. An existing file always wins, so the import can never overwrite newer settings.

Because the Windows installer keys off the app id, an older Clickaa install should be uninstalled before installing Ustaad.

## The mark

One shape, one colour: a folded, faceted "U" with a lit blade held in its counter, and the blade's lime is the accent the whole interface is built around. It is drawn as vector art in `assets/ustaad-mark.svg` (for light backgrounds) and `assets/ustaad-mark-light.svg` (for dark ones), and **everything else is rendered from those**: `tray.svg` and `tray.png` for the notification area, `icon.png` and the seven sizes inside `icon.ico` for the installer and the taskbar, `ustaad-mark-64.png` for the mark inlined into the interface, and `ustaad-mark-transparent.png` for documentation.

The tray and the app tile are deliberately different renders. A bare dark mark vanishes into a dark Windows 11 taskbar, so the tile carries the high-key mark on a graphite slab; the tray keeps a dark hairline so it holds up on a light taskbar, and its blade is deepened one step so the colour survives being reduced to a handful of pixels.

## The interface

The surface language is **neumorphism**: shapes are moulded out of one background rather than drawn on top of it. Raised controls carry a soft highlight from the top-left and a shade to the bottom-right, and anything pressed — inputs, toggles, the active tab, a button mid-click — carries the same two shadows turned inward. There are no borders separating things that share a surface, and text contrast is never sacrificed to the effect.

Practically, that means: the tabs are an inset track with the active one raised out of it, buttons physically press down when clicked, the microphone button sinks while it listens, and every card is the same slab of surface lifted by light rather than a differently coloured box.

The panel also opens with a **three-step start card** — connect a brain, hold a key and talk, then let it work — that ticks each step off from real state and removes itself once all three are done.

## What a task looks like

For anything that takes more than one action, the model replies with a goal instead of an order:

```text
opening youtube now.
<task>play a video on youtube</task>
<actions>[{"type":"open_url","url":"https://youtube.com"}]</actions>
```

Ustaad then does one step, takes a fresh screenshot of every display, and asks the model a single question: is the goal met? The answer is `DONE`, `NEXT` (one more step, usually a `click_at` on a spot read off that screenshot) or `GIVE_UP`. The loop is bounded — 8 steps, 2 re-plans per step, 75 seconds — and a model that asks for the identical step twice is treated as stuck and handed back to you. Playback goals skip the screenshot question entirely: Ustaad asks Windows what is playing, which is cheaper and much harder to get wrong.

## Two ways to give Ustaad a brain

Ustaad needs a model to think with. Pick either, in the panel's **setup** tab:

1. **Your own Gemini API key** — make a free key at <https://aistudio.google.com/api-keys>, paste it into **setup → your own gemini key**, and press **save & test**. Talking, seeing your screen, dictation and acting all run on that one key, stored on this PC only, in `%APPDATA%\Ustaad\settings.json`. No Worker, no other account.
2. **A deployed Cloudflare Worker** — the original path, which keeps the Claude, AssemblyAI and ElevenLabs keys off this PC (see the repository's root `README.md`). Paste the Worker base URL into **setup → cloudflare worker**.

If both are configured, the provider selected in **setup** wins; if that provider has no key or URL yet, Ustaad uses the other one instead of failing.

## Requirements

- Windows 10 version 22H2 or Windows 11 (64-bit x64 or ARM64)
- Node.js 22.12 or newer when building from source
- A Gemini API key **or** a deployed Ustaad Cloudflare Worker
- Microphone access when Windows asks on the first interaction

Ustaad needs no Accessibility or Screen Recording permission: it captures the desktop through Electron's Windows capture API, and only sends a screenshot while an interaction you started is running.

## Run from source

From PowerShell:

```powershell
cd windows
npm install
npm run dev
```

Ustaad appears in the Windows notification area. On first launch its panel opens on the **setup** tab:

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

- `Ustaad-Setup-<version>-x64.exe`
- `Ustaad-Setup-<version>-arm64.exe`

The installer is per-user, offers an install location, creates Start Menu and desktop shortcuts, and preserves Ustaad's settings on uninstall. The app can register itself to start when the user signs in; this is controllable in the panel.

CI also launches the packaged x64 application for ten seconds before accepting a build. This catches missing native binaries, invalid preload paths, and main-process startup crashes that compilation alone cannot detect.

To create an unpacked application directory while developing:

```powershell
npm run package:win:dir
```

### Publish a Windows release

Maintainers can publish durable GitHub Release assets from **Actions → Windows client → Run workflow** on the `main` branch. Enter a release tag matching the package version, such as `windows-v1.0.0`. The workflow rebuilds and smoke-tests both installers before creating the release. Publishing a `windows-v*` GitHub Release through the CLI or web UI also triggers the same guarded build and attaches both installers to that release.

The installers are unsigned unless the signing secrets below are configured, so Windows may refuse them — see **Code signing** for both refusal modes and how to fix them properly.

### Code signing

Nothing in this repository requires a certificate. With the two signing secrets unset, `npm run package:win` produces the same unsigned installers it always has, and CI passes. Signing is what makes those installers installable on machines that refuse unknown publishers.

Windows refuses an unsigned installer in two different ways, and they are not the same problem:

- **SmartScreen** shows "Windows protected your PC", and **More info → Run anyway** clears it. That is a speed bump.
- **Smart App Control**, on by default on clean Windows 11 installs (22H2 and later), blocks unsigned apps outright. Its dialog offers **Okay** and **Get apps from the Store** and nothing else: there is no per-app exception, and adding Ustaad to Defender exclusions does not help because Smart App Control is a separate feature. It allows an app when Microsoft's cloud intelligence already recognizes it, or when the app is signed with a certificate from a CA in the Microsoft Trusted Root Program.

Two signing providers are wired up. Set up one, or neither.

#### A `.pfx` certificate

```bash
gh secret set WINDOWS_CODE_SIGNING_CERTIFICATE < certificate.pfx.base64
gh secret set WINDOWS_CODE_SIGNING_CERTIFICATE_PASSWORD
```

`WINDOWS_CODE_SIGNING_CERTIFICATE` holds the base64 of your `.pfx` (electron-builder accepts base64, an https URL, or a file path); the workflow passes both secrets to electron-builder as `CSC_LINK` and `CSC_KEY_PASSWORD`.

When signing is configured, electron-builder signs the app executable, the uninstaller and the generated installer, and `build.win.signExts` also signs the bundled `.node` native module — an unsigned module loaded by a signed app is its own Smart App Control refusal ("blocked part of this app"). CI then checks every one of those files with `Get-AuthenticodeSignature` and fails the build if a signature is missing or invalid, so a silently unsigned release cannot ship.

This only works for a certificate you can actually export as a `.pfx`. Since June 2023 code-signing certificates are issued onto a hardware token or a cloud HSM, and a token that never exports its key cannot sign on a GitHub-hosted runner. If yours is token-only, either sign on a Windows machine and upload the installers to the release yourself, or use a provider below.

#### Azure Artifact Signing (formerly Trusted Signing)

Electron-builder drives it through the `TrustedSigning` PowerShell module, and it authenticates with Azure's `EnvironmentCredential`, so CI needs seven secrets:

```bash
gh secret set AZURE_TENANT_ID
gh secret set AZURE_CLIENT_ID
gh secret set AZURE_CLIENT_SECRET
gh secret set AZURE_CODE_SIGNING_ENDPOINT            # e.g. https://eus.codesigning.azure.net/
gh secret set AZURE_CODE_SIGNING_ACCOUNT_NAME
gh secret set AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME
gh secret set AZURE_CODE_SIGNING_PUBLISHER_NAME      # must match the certificate's subject exactly
```

`electron-builder.signing.js` adds the Azure block to the packaging config only when those four `AZURE_CODE_SIGNING_*` values are present, which is how the config stays in `package.json` while signing stays optional. **Setting some of them but not all fails the build on purpose**: a half-configured signing setup would otherwise ship installers that look signed in the CI log and are not, which is precisely the "we could not verify its publisher" dialog users see. The `publisherName` also has to match the certificate subject exactly, or Windows reports the signature as invalid even though signing succeeded.

Eligibility is the catch, and it is about where the **signing account** is, not where your users are:

| Applicant | Eligible locations |
|---|---|
| Organization | United States, Canada, the European Union, the United Kingdom, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway, Israel |
| Individual | United States and Canada only |

Basic is $9.99/month for 5,000 signatures with one certificate profile. Certificates are short-lived and timestamped by Microsoft, which keeps the signature valid after they expire.

#### If you are outside those locations

Azure is not available to an individual outside the United States and Canada, so pick one of these instead. All are sold worldwide:

| Route | Roughly | CI-ready? |
|---|---|---|
| **SSL.com OV + eSigner** | $129/year + from $15/month (Tier 1: 240 signings) | Yes — cloud HSM, and SSL.com ships an official GitHub Action |
| **DigiCert OV + KeyLocker** | $370–440/year | Yes, via `smctl` in the workflow. KeyLocker is capped at 1,000 signings per certificate-year, and hitting the cap fails the build until you buy more |
| **Sectigo OV/EV + CodeGuard** | From ~$220/year | Yes — lower priced than DigiCert for the same cloud-HSM model |
| **A token-based certificate from any CA** | ~$150–300/year | No. Sign on a Windows PC and upload the installers to the release by hand |
| **Microsoft Store** | Store account fee | Not needed — Store installs are exempt from the Smart App Control refusal, at the cost of MSIX packaging and Store review |

Whichever you choose, the cheaper tiers are per-signature or capped, which matters because a two-architecture release signs several files per build: the installer, the app executable, and the bundled `.node` native module.

One caveat on reputation: a valid signature gets past SmartScreen immediately, but Smart App Control also weighs Microsoft's app intelligence. A brand-new certificate with no download history can still be held back for a while, and reputation accumulates with installs over time.

None of this has been exercised end to end yet: no signed build of any kind has been produced, because every route needs something paid. The Azure wiring is tested for its three configurations (none, complete, partial) and the CI step verifies signatures with `Get-AuthenticodeSignature`, but the signing call itself has never run — the first build after the secrets exist will either sign correctly or fail loudly.

## Test and type-check

```powershell
npm test
npm run typecheck
```

The tests cover configuration and key validation, to-do, memory and schedule stores, action-protocol parsing and risk rules, spoken confirmation answers, dictation cleanup prompts, search targets, text matching, audio buffering and WAV encoding, chunked SSE parsing, skill health and repair, global modifier transitions (including AltGr avoidance), point-tag parsing, and coordinate mapping for monitors with negative desktop origins.

## Architecture

```text
windows/
  src/main/
    main.ts                    Electron lifecycle, tray, and secure IPC
    ustaad-controller.ts      interactions, actions, confirmations, scheduler
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
    presence-schedule.ts       when a check-in is due, and what the island says
    presence-store.ts          which check-ins already ran today, so none repeats
    briefing.ts                the morning brief and evening recap, built from local data
    skill-store.ts             tasks the user saved by name
    skill-suggestions.ts       when repeating a task becomes an offer to save it
    wake-word-listener.ts      the offline "ustaad" listener and its lifecycle
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

Ustaad tracks physical key-down and key-up events through `uiohook-napi`, which is necessary for true push-to-talk behavior. Either Control key works, and the talk shortcut requires **left Alt**. Requiring left Alt intentionally avoids triggering on the Windows AltGr sequence used by many international keyboard layouts. **Escape** cancels a circling session, closes a snip, and stops a running task.

The wake word is **off until you switch it on** in **setup → wake word**. When it is on, saying the name summons the island and opens one listening window: silence for a moment closes it again without sending anything, and speech is submitted after a short pause. The microphone light in the island's notch stays visible the whole time Ustaad is listening, and the tray menu can mute it without changing the setting.

The dictation shortcut is configurable in **setup → keys**: **Ctrl + Windows** (default), **Ctrl + Shift + Space**, or **Caps Lock**. Windows itself opens the Start menu when Ctrl + Windows is released; if that bothers you, pick another shortcut.

If the global listener cannot start, the tray panel remains usable through its **hold to talk** button.

## Troubleshooting

- **"Smart App Control blocked an app that may be unsafe" while installing:** this is Smart App Control, not SmartScreen, and it has no **Run anyway** option to click. Check **Windows Security → App & browser control → Smart App Control settings**. On Windows 11 with the April 2026 update (24H2/25H2, build 26100.8116 or later) it can be switched off and back on freely; on older builds, switching it off is one-way until Windows is reinstalled, so decide with that in mind. Adding Ustaad to Defender exclusions will not help — Smart App Control is a separate feature with no per-app exception. Before running an unsigned installer, confirm it is the file CI built with `Get-FileHash .\Ustaad-Setup-1.1.0-x64.exe -Algorithm SHA256` and compare it against the digest on the release page. Running from source (`npm run dev`) may or may not be allowed, since Smart App Control judges every unsigned binary it loads. Signing the builds is the real fix; see **Code signing** above.
- **The Smart App Control toggle is greyed out:** the registry is the same switch by a different door. Set `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy` → `VerifiedAndReputablePolicyState` to `0` (off), `1` (on/enforced) or `2` (evaluation), then run `CiTool.exe -r` to refresh the policy:
  ```powershell
  reg add "HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy" /v VerifiedAndReputablePolicyState /t REG_DWORD /d 0 /f
  CiTool.exe -r
  ```
  Check `winver` first: builds 26100.8116+ and 26200.8116+ (Windows 11 24H2/25H2 with the April 2026 update) have the reversible in-app toggle, and on those the registry edit is unnecessary. On older builds the registry route is known to revert on reboot, and turning it back on afterwards is unreliable — so make a restore point and treat it as a decision, not a tweak. This is machine-wide: it switches the guard off for every unknown unsigned program, not just Ustaad. Windows Defender keeps scanning regardless.
- **The panel says the brain is not connected:** paste a full Gemini key (it starts with `AIza`), or a Worker base URL without `/chat` or another route.
- **Gemini rejects the key:** make sure the key is from <https://aistudio.google.com/api-keys> and, if you are in the EEA, UK or Switzerland, that the project has billing enabled.
- **No microphone prompt appeared:** open **Settings → Privacy & security → Microphone** and allow desktop apps to access the microphone.
- **Ctrl + Alt does nothing:** exit and restart Ustaad. Security tools that block global keyboard hooks may require Ustaad to be allow-listed; the hold-to-talk button remains available.
- **Windows opens the Start menu while dictating:** change the dictation shortcut in **setup → keys**.
- **The wrong monitor is targeted:** run `npm test` first, then report the monitor layout and Windows display scaling values.
- **An action ran that you did not want:** open the island and press **undo** on the entry; clipboard writes, typed text and window moves are all reversible.
- **The app is still running after the panel closes:** this is expected. Use **Quit Ustaad** from the tray icon's context menu.
