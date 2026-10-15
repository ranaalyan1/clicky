import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ustaadWakeWordScript } from "./wake-word-script";

/** "off" is idle-by-choice; "stopped" never reaches the panel. */
export type WakeWordListenerState = "stopped" | "starting" | "listening" | "unavailable" | "error";

export interface WakeWordDetection {
  /** 0-100, straight from Windows' recognizer. */
  confidence: number;
  phrase: string;
}

export type WakeWordListenerEvent =
  | { kind: "ready" }
  | { kind: "wake"; detection: WakeWordDetection }
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string };

/**
 * Turns one line of the listener's output into an event. Anything Ustaad does
 * not recognise is ignored, so PowerShell noise can never be mistaken for the
 * user calling its name.
 */
export function parseWakeWordListenerLine(line: string): WakeWordListenerEvent | null {
  const trimmedLine = line.trim();
  if (!trimmedLine) {
    return null;
  }

  if (trimmedLine === "READY") {
    return { kind: "ready" };
  }

  // The event words have to stand alone. "WAKEUP 90 ustaad" is a diagnostic,
  // not the user calling Ustaad's name, and must never open the microphone.
  if (/^WAKE\b/u.test(trimmedLine)) {
    const [, rawConfidence, ...phraseParts] = trimmedLine.split(/\s+/u);
    const confidence = Number.parseInt(rawConfidence ?? "", 10);
    const phrase = phraseParts.join(" ").trim();
    if (!Number.isFinite(confidence) || !phrase) {
      return null;
    }
    return {
      kind: "wake",
      detection: {
        confidence: Math.max(0, Math.min(confidence, 100)),
        phrase,
      },
    };
  }

  if (/^UNAVAILABLE\b/u.test(trimmedLine)) {
    return {
      kind: "unavailable",
      message: trimmedLine.slice("UNAVAILABLE".length).trim() || "the offline listener could not start",
    };
  }

  if (/^ERROR\b/u.test(trimmedLine)) {
    return {
      kind: "error",
      message: trimmedLine.slice("ERROR".length).trim() || "the offline listener stopped unexpectedly",
    };
  }

  return null;
}

export interface WakeWordListenerCallbacks {
  onStateChanged: (state: WakeWordListenerState, message: string) => void;
  onWakeWordDetected: (detection: WakeWordDetection) => void;
}

export interface WakeWordListenerOptions {
  /** How many times a dying listener is restarted before Ustaad gives up. */
  maximumRestarts?: number;
  restartDelayMilliseconds?: number;
}

/**
 * Runs the offline wake word listener as a child process.
 *
 * Ustaad starts it only when the wake word is switched on and stops it the
 * moment it is switched off, so the microphone is never open behind the user's
 * back. An unavailable speech engine is reported, never retried in a loop.
 */
export class WakeWordListener {
  private listenerProcess: ReturnType<typeof spawn> | null = null;
  private scriptPath = "";
  private restartsUsed = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private isStopping = false;
  private state: WakeWordListenerState = "stopped";
  private message = "";
  private readonly maximumRestarts: number;
  private readonly restartDelayMilliseconds: number;

  constructor(
    private readonly userDataDirectory: string,
    private readonly callbacks: WakeWordListenerCallbacks,
    options: WakeWordListenerOptions = {},
  ) {
    this.maximumRestarts = options.maximumRestarts ?? 3;
    this.restartDelayMilliseconds = options.restartDelayMilliseconds ?? 1_500;
  }

  getState(): WakeWordListenerState {
    return this.state;
  }

  getMessage(): string {
    return this.message;
  }

  isListening(): boolean {
    return this.state === "listening" || this.state === "starting";
  }

  get isSupported(): boolean {
    return process.platform === "win32";
  }

  start(): void {
    if (!this.isSupported) {
      this.updateState("unavailable", "the wake word needs Windows speech recognition, which only exists on Windows.");
      return;
    }
    if (this.listenerProcess || this.restartTimer) {
      return;
    }

    this.isStopping = false;
    this.restartsUsed = 0;
    this.updateState("starting", "warming up the offline listener");
    this.spawnListenerProcess();
  }

  stop(): void {
    this.isStopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.listenerProcess?.kill();
    this.listenerProcess = null;
    this.updateState("stopped", "");
  }

  private spawnListenerProcess(): void {
    this.writeScriptToDisk();

    const listenerProcess = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        this.scriptPath,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );

    this.listenerProcess = listenerProcess;
    let unfinishedLine = "";

    listenerProcess.stdout?.on("data", (rawChunk: Buffer) => {
      unfinishedLine += rawChunk.toString("utf8");
      const completeLines = unfinishedLine.split(/\r?\n/u);
      unfinishedLine = completeLines.pop() ?? "";
      for (const completeLine of completeLines) {
        this.handleListenerLine(completeLine);
      }
    });

    listenerProcess.stderr?.on("data", (rawChunk: Buffer) => {
      console.warn("[ustaad-wake-word]", rawChunk.toString("utf8").trim().slice(0, 500));
    });

    listenerProcess.on("error", (error) => {
      this.listenerProcess = null;
      this.updateState("error", `the offline listener could not start: ${error.message}`);
    });

    listenerProcess.on("close", () => {
      if (this.listenerProcess === listenerProcess) {
        this.listenerProcess = null;
      }
      if (this.isStopping || this.state === "unavailable" || this.state === "error") {
        return;
      }
      this.handleUnexpectedExit();
    });
  }

  private handleListenerLine(rawLine: string): void {
    const listenerEvent = parseWakeWordListenerLine(rawLine);
    if (!listenerEvent) {
      return;
    }

    switch (listenerEvent.kind) {
      case "ready":
        // A listener that got this far has proven it works, so the restart
        // budget is fresh again.
        this.restartsUsed = 0;
        this.updateState("listening", "listening for \"hitodama\" on this pc");
        return;
      case "wake":
        this.callbacks.onWakeWordDetected(listenerEvent.detection);
        return;
      case "unavailable":
        this.updateState("unavailable", listenerEvent.message);
        return;
      case "error":
        this.updateState("error", listenerEvent.message);
        return;
      default:
        return;
    }
  }

  private handleUnexpectedExit(): void {
    if (this.restartsUsed >= this.maximumRestarts) {
      this.updateState(
        "error",
        "the offline listener kept stopping, so I stopped restarting it. toggle the wake word off and on to try again.",
      );
      return;
    }

    this.restartsUsed += 1;
    this.updateState("starting", "restarting the offline listener");
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.isStopping) {
        return;
      }
      this.spawnListenerProcess();
    }, this.restartDelayMilliseconds);
  }

  private updateState(state: WakeWordListenerState, message: string): void {
    if (this.state === state && this.message === message) {
      return;
    }
    this.state = state;
    this.message = message;
    this.callbacks.onStateChanged(state, message);
  }

  private writeScriptToDisk(): void {
    this.scriptPath = join(this.userDataDirectory, "ustaad-wake-word.ps1");
    // Windows PowerShell reads files without a byte-order mark as ANSI, so the
    // script is written with a UTF-8 BOM even though it is ASCII-only today.
    writeFileSync(this.scriptPath, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(ustaadWakeWordScript, "utf8"),
    ]));
  }
}
