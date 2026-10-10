import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ClickyUserConfig,
  SupportedClaudeModel,
  supportedClaudeModels,
} from "../shared/contracts";

export const defaultClickyUserConfig: ClickyUserConfig = {
  workerBaseUrl: "",
  selectedModel: "claude-sonnet-4-6",
  cursorEnabled: true,
  launchAtLogin: true,
};

export function normalizeWorkerBaseUrl(rawWorkerBaseUrl: string): string {
  const trimmedWorkerBaseUrl = rawWorkerBaseUrl.trim();
  if (!trimmedWorkerBaseUrl) {
    return "";
  }

  let parsedWorkerUrl: URL;
  try {
    parsedWorkerUrl = new URL(trimmedWorkerBaseUrl);
  } catch {
    throw new Error("Enter a valid Worker URL, for example https://clicky.example.workers.dev");
  }

  const isLocalDevelopmentHost = ["localhost", "127.0.0.1", "::1"].includes(
    parsedWorkerUrl.hostname,
  );
  const usesAllowedProtocol = parsedWorkerUrl.protocol === "https:"
    || (parsedWorkerUrl.protocol === "http:" && isLocalDevelopmentHost);

  if (!usesAllowedProtocol) {
    throw new Error("Worker URLs must use HTTPS. HTTP is allowed only for local development.");
  }

  if (parsedWorkerUrl.username || parsedWorkerUrl.password) {
    throw new Error("The Worker URL must not contain a username or password.");
  }

  if (parsedWorkerUrl.search || parsedWorkerUrl.hash) {
    throw new Error("The Worker URL must not contain a query string or fragment.");
  }

  const normalizedPath = parsedWorkerUrl.pathname.replace(/\/+$/, "");
  parsedWorkerUrl.pathname = normalizedPath;

  return parsedWorkerUrl.toString().replace(/\/$/, "");
}

function isSupportedModel(candidateModel: unknown): candidateModel is SupportedClaudeModel {
  return typeof candidateModel === "string"
    && supportedClaudeModels.includes(candidateModel as SupportedClaudeModel);
}

function sanitizeStoredConfig(storedConfig: unknown): ClickyUserConfig {
  if (!storedConfig || typeof storedConfig !== "object") {
    return { ...defaultClickyUserConfig };
  }

  const possibleConfig = storedConfig as Partial<ClickyUserConfig>;
  let workerBaseUrl = "";
  if (typeof possibleConfig.workerBaseUrl === "string") {
    try {
      workerBaseUrl = normalizeWorkerBaseUrl(possibleConfig.workerBaseUrl);
    } catch {
      workerBaseUrl = "";
    }
  }

  return {
    workerBaseUrl,
    selectedModel: isSupportedModel(possibleConfig.selectedModel)
      ? possibleConfig.selectedModel
      : defaultClickyUserConfig.selectedModel,
    cursorEnabled: typeof possibleConfig.cursorEnabled === "boolean"
      ? possibleConfig.cursorEnabled
      : defaultClickyUserConfig.cursorEnabled,
    launchAtLogin: typeof possibleConfig.launchAtLogin === "boolean"
      ? possibleConfig.launchAtLogin
      : defaultClickyUserConfig.launchAtLogin,
  };
}

export class ClickyConfigStore {
  private currentConfig: ClickyUserConfig;

  constructor(private readonly configFilePath: string) {
    this.currentConfig = this.readConfigFromDisk();
  }

  getConfig(): ClickyUserConfig {
    return { ...this.currentConfig };
  }

  updateConfig(configUpdates: Partial<ClickyUserConfig>): ClickyUserConfig {
    const updatedConfig: ClickyUserConfig = {
      ...this.currentConfig,
      ...configUpdates,
    };

    updatedConfig.workerBaseUrl = normalizeWorkerBaseUrl(updatedConfig.workerBaseUrl);
    if (!isSupportedModel(updatedConfig.selectedModel)) {
      throw new Error("That Claude model is not supported by this version of Clicky.");
    }

    this.writeConfigToDisk(updatedConfig);
    this.currentConfig = updatedConfig;
    return this.getConfig();
  }

  private readConfigFromDisk(): ClickyUserConfig {
    try {
      const serializedConfig = readFileSync(this.configFilePath, "utf8");
      return sanitizeStoredConfig(JSON.parse(serializedConfig) as unknown);
    } catch {
      return { ...defaultClickyUserConfig };
    }
  }

  private writeConfigToDisk(config: ClickyUserConfig): void {
    mkdirSync(dirname(this.configFilePath), { recursive: true });
    const temporaryConfigPath = `${this.configFilePath}.tmp`;
    writeFileSync(temporaryConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    // Windows will not consistently replace an existing file with renameSync.
    // Removing only after the complete temporary file exists keeps partial writes
    // from becoming the active configuration.
    rmSync(this.configFilePath, { force: true });
    renameSync(temporaryConfigPath, this.configFilePath);
  }
}
