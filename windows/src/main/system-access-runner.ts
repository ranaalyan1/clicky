import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CommandRunResult {
  exitCode: number | null;
  standardOutput: string;
  standardError: string;
  /** True when the command was killed for running too long. */
  timedOut: boolean;
}

export interface CommandRunnerOptions {
  timeoutMilliseconds?: number;
  maximumOutputCharacters?: number;
}

const defaultTimeoutMilliseconds = 20_000;
const defaultMaximumOutputCharacters = 8_000;

function trimOutput(rawOutput: string, maximumCharacters: number): string {
  const trimmedOutput = rawOutput.trim();
  if (trimmedOutput.length <= maximumCharacters) {
    return trimmedOutput;
  }
  return `${trimmedOutput.slice(0, maximumCharacters)}\n… output shortened, ${trimmedOutput.length - maximumCharacters} more characters were dropped.`;
}

/**
 * Does the actual system-access work: runs one PowerShell command in its own
 * short-lived process, and reads or writes a single file.
 *
 * A separate process matters for two reasons: the long-lived Windows helper
 * stays alive even when a command misbehaves, and a command that hangs can be
 * killed on its own without taking anything else down with it. Every caller
 * checks system-access.ts first; nothing here decides what is allowed.
 */
export class SystemAccessRunner {
  private readonly timeoutMilliseconds: number;
  private readonly maximumOutputCharacters: number;

  constructor(options: CommandRunnerOptions = {}) {
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? defaultTimeoutMilliseconds;
    this.maximumOutputCharacters = options.maximumOutputCharacters ?? defaultMaximumOutputCharacters;
  }

  get isSupported(): boolean {
    return process.platform === "win32";
  }

  /**
   * Writes the command to a temporary script instead of passing it on the
   * command line, so quoting and multi-line scripts cannot break it — and so the
   * audit log can be the exact text that ran.
   */
  async runPowerShell(commandText: string, workingDirectory?: string): Promise<CommandRunResult> {
    if (!this.isSupported) {
      throw new Error("Ustaad runs commands through PowerShell, which only exists on Windows.");
    }

    const scriptDirectory = await mkdtemp(join(tmpdir(), "ustaad-command-"));
    const scriptPath = join(scriptDirectory, "ustaad-command.ps1");

    try {
      // PowerShell reads files without a byte-order mark as ANSI, so the script
      // is written with a BOM to keep non-ASCII paths and text intact.
      await writeFile(scriptPath, Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(commandText, "utf8"),
      ]));

      return await new Promise<CommandRunResult>((resolve, reject) => {
        const commandProcess = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
          {
            windowsHide: true,
            cwd: workingDirectory,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );

        let standardOutput = "";
        let standardError = "";
        let timedOut = false;

        const timeout = setTimeout(() => {
          timedOut = true;
          commandProcess.kill();
        }, this.timeoutMilliseconds);

        commandProcess.stdout?.on("data", (rawChunk: Buffer) => {
          standardOutput += rawChunk.toString("utf8");
        });
        commandProcess.stderr?.on("data", (rawChunk: Buffer) => {
          standardError += rawChunk.toString("utf8");
        });

        commandProcess.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });

        commandProcess.on("close", (exitCode) => {
          clearTimeout(timeout);
          resolve({
            exitCode,
            standardOutput: trimOutput(standardOutput, this.maximumOutputCharacters),
            standardError: trimOutput(standardError, this.maximumOutputCharacters),
            timedOut,
          });
        });
      });
    } finally {
      await rm(scriptDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Reads a file the user asked about, capped so a huge file cannot flood the panel. */
  async readTextFile(filePath: string, maximumCharacters = 20_000): Promise<string> {
    const fileContents = await readFile(filePath, "utf8");
    return fileContents.length > maximumCharacters
      ? `${fileContents.slice(0, maximumCharacters)}\n… file shortened, ${fileContents.length - maximumCharacters} more characters were dropped.`
      : fileContents;
  }

  async writeTextFile(filePath: string, contents: string): Promise<void> {
    await writeFile(filePath, contents, "utf8");
  }
}
