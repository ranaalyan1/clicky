import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NowPlayingInfo } from "../shared/contracts";
import { clickaaWindowsBridgeScript } from "./windows-bridge-script";

interface BridgeResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingBridgeRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export type BridgeCommand =
  | { command: "ping" }
  | { command: "send_keys"; keys: string }
  | { command: "type_unicode"; text: string }
  | { command: "scroll"; direction: "up" | "down"; amount: number }
  | { command: "move_mouse"; x: number; y: number }
  | { command: "click"; x: number; y: number; button: "left" | "right" | "middle"; double: boolean }
  | { command: "cursor_position" }
  | { command: "volume"; operation: "up" | "down" | "mute" | "unmute" | "set"; level?: number }
  | { command: "media"; operation: "play_pause" | "next" | "previous" | "stop" }
  | { command: "media_status" }
  | { command: "foreground_window" }
  | { command: "window_control"; operation: string; app: string }
  | { command: "wallpaper"; path: string; style: number }
  | { command: "wallpaper_solid"; color: string }
  | { command: "list_start_apps" }
  | { command: "open_path"; path: string };

export interface ForegroundWindowSnapshot {
  title: string;
  processName: string;
}

export interface StartMenuAppRecord {
  name: string;
  appId: string;
}

export interface MediaSessionSnapshot {
  supported: boolean;
  hasSession: boolean;
  title: string;
  artist: string;
  album: string;
  appName: string;
  isPlaying: boolean;
}

export const unsupportedBridgePlatformMessage =
  "Clickaa controls Windows through a small PowerShell helper, which is only available on Windows.";

/**
 * Keeps one PowerShell helper alive and speaks its line-delimited JSON protocol.
 *
 * A single long-lived process matters: starting PowerShell takes a few hundred
 * milliseconds, and Clickaa asks it for the now-playing track every few seconds.
 * If the helper dies (or Windows kills it), the next request starts a fresh one.
 */
export class ClickaaWindowsBridge {
  private bridgeProcess: ReturnType<typeof spawn> | null = null;
  private readonly pendingRequests = new Map<number, PendingBridgeRequest>();
  private nextRequestId = 1;
  private scriptPath = "";
  private isStopping = false;
  private readonly requestTimeoutMilliseconds = 9_000;

  constructor(private readonly userDataDirectory: string) {}

  get isSupported(): boolean {
    return process.platform === "win32";
  }

  isRunning(): boolean {
    return this.bridgeProcess !== null;
  }

  async start(): Promise<void> {
    if (!this.isSupported || this.isStopping) {
      return;
    }

    this.writeScriptToDisk();
    await this.ensureBridgeProcess();
  }

  stop(): void {
    this.isStopping = true;
    this.rejectAllPendingRequests(new Error("Clickaa is shutting down."));
    this.bridgeProcess?.kill();
    this.bridgeProcess = null;
  }

  async send<TResult>(bridgeCommand: BridgeCommand): Promise<TResult> {
    if (!this.isSupported) {
      throw new Error(unsupportedBridgePlatformMessage);
    }

    const bridgeProcess = await this.ensureBridgeProcess();
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<TResult>((resolve, reject) => {
      const requestTimeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`The Windows helper did not answer ${bridgeCommand.command} in time.`));
      }, this.requestTimeoutMilliseconds);

      this.pendingRequests.set(requestId, {
        resolve: (result) => resolve(result as TResult),
        reject,
        timeout: requestTimeout,
      });

      bridgeProcess.stdin?.write(`${JSON.stringify({ id: requestId, ...bridgeCommand })}\n`);
    });
  }

  async readNowPlaying(): Promise<NowPlayingInfo> {
    const mediaSession = await this.send<MediaSessionSnapshot>({ command: "media_status" });
    const appName = mediaSession.appName.includes("!")
      ? mediaSession.appName.split("!")[0]!.replace(/^[^.]*\./u, "")
      : mediaSession.appName;

    return {
      isSupported: mediaSession.supported,
      title: mediaSession.title || (mediaSession.hasSession ? "playing" : ""),
      artist: mediaSession.artist,
      appName: appName.replace(/\.exe$/iu, ""),
      isPlaying: mediaSession.isPlaying,
    };
  }

  /** Moves the real pointer and clicks, so hover states and focus behave. */
  async clickAtScreenPoint(
    screenPoint: { x: number; y: number },
    options: { button?: "left" | "right" | "middle"; double?: boolean } = {},
  ): Promise<void> {
    await this.send({
      command: "click",
      x: Math.round(screenPoint.x),
      y: Math.round(screenPoint.y),
      button: options.button ?? "left",
      double: options.double ?? false,
    });
  }

  async moveMouseTo(screenPoint: { x: number; y: number }): Promise<void> {
    await this.send({
      command: "move_mouse",
      x: Math.round(screenPoint.x),
      y: Math.round(screenPoint.y),
    });
  }

  async readCursorPosition(): Promise<{ x: number; y: number }> {
    return this.send<{ x: number; y: number }>({ command: "cursor_position" });
  }

  async readForegroundWindow(): Promise<ForegroundWindowSnapshot> {
    return this.send<ForegroundWindowSnapshot>({ command: "foreground_window" });
  }

  async listStartMenuApps(): Promise<StartMenuAppRecord[]> {
    const listResult = await this.send<{ apps: StartMenuAppRecord[] }>({ command: "list_start_apps" });
    return Array.isArray(listResult.apps) ? listResult.apps : [];
  }

  private writeScriptToDisk(): void {
    this.scriptPath = join(this.userDataDirectory, "clickaa-windows-helper.ps1");
    // Windows PowerShell reads files without a byte-order mark as ANSI, so the
    // script is written with a UTF-8 BOM even though it is ASCII-only today.
    writeFileSync(this.scriptPath, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(clickaaWindowsBridgeScript, "utf8"),
    ]));
  }

  private async ensureBridgeProcess(): Promise<NonNullable<ClickaaWindowsBridge["bridgeProcess"]>> {
    if (this.bridgeProcess) {
      return this.bridgeProcess;
    }

    const bridgeProcess = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        this.scriptPath,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );

    this.bridgeProcess = bridgeProcess;
    let unfinishedLine = "";

    bridgeProcess.stdout?.on("data", (rawChunk: Buffer) => {
      unfinishedLine += rawChunk.toString("utf8");
      const completeLines = unfinishedLine.split(/\r?\n/u);
      unfinishedLine = completeLines.pop() ?? "";
      for (const completeLine of completeLines) {
        this.handleBridgeResponseLine(completeLine);
      }
    });

    bridgeProcess.stderr?.on("data", (rawChunk: Buffer) => {
      console.warn("[clickaa-helper]", rawChunk.toString("utf8").trim().slice(0, 500));
    });

    bridgeProcess.on("exit", (exitCode) => {
      if (this.bridgeProcess === bridgeProcess) {
        this.bridgeProcess = null;
      }
      this.rejectAllPendingRequests(
        new Error(`The Windows helper stopped unexpectedly (exit code ${exitCode ?? "unknown"}).`),
      );
    });

    bridgeProcess.on("error", (error) => {
      console.error("Clickaa could not start its Windows helper:", error);
      if (this.bridgeProcess === bridgeProcess) {
        this.bridgeProcess = null;
      }
      this.rejectAllPendingRequests(new Error(`The Windows helper could not start: ${error.message}`));
    });

    // The helper compiles its native block on start-up, so wait for it to answer
    // before reporting success. A failure here must not reject the caller: the
    // bridge is created lazily again on the next command.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });
    return bridgeProcess;
  }

  private handleBridgeResponseLine(responseLine: string): void {
    const trimmedLine = responseLine.trim();
    if (!trimmedLine) {
      return;
    }

    let parsedResponse: BridgeResponse;
    try {
      parsedResponse = JSON.parse(trimmedLine) as BridgeResponse;
    } catch {
      console.warn("[clickaa-helper] unreadable output:", trimmedLine.slice(0, 200));
      return;
    }

    const pendingRequest = this.pendingRequests.get(parsedResponse.id);
    if (!pendingRequest) {
      return;
    }

    clearTimeout(pendingRequest.timeout);
    this.pendingRequests.delete(parsedResponse.id);

    if (parsedResponse.ok) {
      pendingRequest.resolve(parsedResponse.result ?? {});
    } else {
      pendingRequest.reject(new Error(parsedResponse.error || "The Windows helper reported a failure."));
    }
  }

  private rejectAllPendingRequests(error: Error): void {
    for (const pendingRequest of this.pendingRequests.values()) {
      clearTimeout(pendingRequest.timeout);
      pendingRequest.reject(error);
    }
    this.pendingRequests.clear();
  }
}
