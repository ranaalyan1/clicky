import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ClickaaUserConfig,
  SupportedClaudeModel,
  supportedClaudeModels,
} from "../shared/contracts";

export const defaultClickaaUserConfig: ClickaaUserConfig = {
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
    throw new Error("Enter a valid Worker URL, for example https://clickaa.example.workers.dev");
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

function sanitizeStoredConfig(storedConfig: unknown): ClickaaUserConfig {
  if (!storedConfig || typeof storedConfig !== "object") {
    return { ...defaultClickaaUserConfig };
  }

  const possibleConfig = storedConfig as Partial<ClickaaUserConfig>;
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
      : defaultClickaaUserConfig.selectedModel,
    cursorEnabled: typeof possibleConfig.cursorEnabled === "boolean"
      ? possibleConfig.cursorEnabled
      : defaultClickaaUserConfig.cursorEnabled,
    launchAtLogin: typeof possibleConfig.launchAtLogin === "boolean"
      ? possibleConfig.launchAtLogin
      : defaultClickaaUserConfig.launchAtLogin,
  };
}

export class ClickaaConfigStore {
  private currentConfig: ClickaaUserConfig;

  constructor(private readonly configFilePath: string) {
    this.currentConfig = this.readConfigFromDisk();
  }

  getConfig(): ClickaaUserConfig {
    return { ...this.currentConfig };
  }

  updateConfig(configUpdates: Partial<ClickaaUserConfig>): ClickaaUserConfig {
    const updatedConfig: ClickaaUserConfig = {
      ...this.currentConfig,
      ...configUpdates,
    };

    updatedConfig.workerBaseUrl = normalizeWorkerBaseUrl(updatedConfig.workerBaseUrl);
    if (!isSupportedModel(updatedConfig.selectedModel)) {
      throw new Error("That Claude model is not supported by this version of Clickaa.");
    }

    this.writeConfigToDisk(updatedConfig);
    this.currentConfig = updatedConfig;
    return this.getConfig();
  }

  private readConfigFromDisk(): ClickaaUserConfig {
    try {
      const serializedConfig = readFileSync(this.configFilePath, "utf8");
      return sanitizeStoredConfig(JSON.parse(serializedConfig) as unknown);
    } catch {
      return { ...defaultClickaaUserConfig };
    }
  }

  private writeConfigToDisk(config: ClickaaUserConfig): void {
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
