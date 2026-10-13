import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  AbilitySettings,
  brainProviderIds,
  BrainProviderId,
  ClickaaUserConfig,
  dictationShortcutIds,
  DictationShortcutId,
  geminiChatModels,
  GeminiChatModel,
  SoulSettings,
  supportedClaudeModels,
  SupportedClaudeModel,
} from "../shared/contracts";
import { JsonFileStore } from "./json-file-store";
import {
  defaultAbilitySettings,
  defaultSoulSettings,
  sanitizeAbilitySettings,
  sanitizeAutoApprovedActionTypes,
  sanitizeConfirmationMode,
  sanitizeSoulSettings,
} from "./soul-config";

export const defaultClickaaUserConfig: ClickaaUserConfig = {
  workerBaseUrl: "",
  brainProvider: "gemini",
  geminiApiKey: "",
  geminiChatModel: "gemini-2.5-flash",
  selectedClaudeModel: "claude-sonnet-4-6",
  cursorEnabled: true,
  launchAtLogin: true,
  automationPaused: false,
  confirmationMode: "risky",
  autoApprovedActionTypes: [],
  dictationShortcut: "ctrl+windows",
  dictationCleanupEnabled: true,
  speakScheduledResults: true,
  islandEnabled: true,
  islandSummonEnabled: true,
  islandAlwaysVisible: false,
  islandShowNowPlaying: true,
  islandShowClipboard: true,
  clipboardHistoryEnabled: true,
  soul: { ...defaultSoulSettings },
  abilities: { ...defaultAbilitySettings },
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

  const normalizedPath = parsedWorkerUrl.pathname.replace(/\/+$/u, "");
  parsedWorkerUrl.pathname = normalizedPath;

  return parsedWorkerUrl.toString().replace(/\/$/u, "");
}

/** Google AI Studio keys are long and contain no whitespace. */
export function normalizeGeminiApiKey(rawApiKey: string): string {
  const trimmedApiKey = rawApiKey.trim().replace(/^["']|["']$/gu, "");
  if (!trimmedApiKey) {
    return "";
  }

  if (/\s/u.test(trimmedApiKey) || trimmedApiKey.length < 20) {
    throw new Error("That does not look like a Google AI Studio API key. Paste the whole key.");
  }

  return trimmedApiKey;
}

function isSupportedModel(candidateModel: unknown): candidateModel is SupportedClaudeModel {
  return typeof candidateModel === "string"
    && (supportedClaudeModels as readonly string[]).includes(candidateModel);
}

function isSupportedGeminiModel(candidateModel: unknown): candidateModel is GeminiChatModel {
  return typeof candidateModel === "string"
    && (geminiChatModels as readonly string[]).includes(candidateModel);
}

function isSupportedBrainProvider(candidateProvider: unknown): candidateProvider is BrainProviderId {
  return typeof candidateProvider === "string"
    && (brainProviderIds as readonly string[]).includes(candidateProvider);
}

function isSupportedDictationShortcut(candidateShortcut: unknown): candidateShortcut is DictationShortcutId {
  return typeof candidateShortcut === "string"
    && (dictationShortcutIds as readonly string[]).includes(candidateShortcut);
}

function readBoolean(storedValue: unknown, fallbackValue: boolean): boolean {
  return typeof storedValue === "boolean" ? storedValue : fallbackValue;
}

export function sanitizeStoredConfig(storedConfig: unknown): ClickaaUserConfig {
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

  let geminiApiKey = "";
  if (typeof possibleConfig.geminiApiKey === "string") {
    try {
      geminiApiKey = normalizeGeminiApiKey(possibleConfig.geminiApiKey);
    } catch {
      geminiApiKey = "";
    }
  }

  return {
    workerBaseUrl,
    brainProvider: isSupportedBrainProvider(possibleConfig.brainProvider)
      ? possibleConfig.brainProvider
      : defaultClickaaUserConfig.brainProvider,
    geminiApiKey,
    geminiChatModel: isSupportedGeminiModel(possibleConfig.geminiChatModel)
      ? possibleConfig.geminiChatModel
      : defaultClickaaUserConfig.geminiChatModel,
    selectedClaudeModel: isSupportedModel(possibleConfig.selectedClaudeModel)
      ? possibleConfig.selectedClaudeModel
      : defaultClickaaUserConfig.selectedClaudeModel,
    cursorEnabled: readBoolean(possibleConfig.cursorEnabled, defaultClickaaUserConfig.cursorEnabled),
    launchAtLogin: readBoolean(possibleConfig.launchAtLogin, defaultClickaaUserConfig.launchAtLogin),
    automationPaused: readBoolean(possibleConfig.automationPaused, defaultClickaaUserConfig.automationPaused),
    confirmationMode: sanitizeConfirmationMode(possibleConfig.confirmationMode),
    autoApprovedActionTypes: sanitizeAutoApprovedActionTypes(possibleConfig.autoApprovedActionTypes),
    dictationShortcut: isSupportedDictationShortcut(possibleConfig.dictationShortcut)
      ? possibleConfig.dictationShortcut
      : defaultClickaaUserConfig.dictationShortcut,
    dictationCleanupEnabled: readBoolean(
      possibleConfig.dictationCleanupEnabled,
      defaultClickaaUserConfig.dictationCleanupEnabled,
    ),
    speakScheduledResults: readBoolean(
      possibleConfig.speakScheduledResults,
      defaultClickaaUserConfig.speakScheduledResults,
    ),
    islandEnabled: readBoolean(possibleConfig.islandEnabled, defaultClickaaUserConfig.islandEnabled),
    islandSummonEnabled: readBoolean(
      possibleConfig.islandSummonEnabled,
      defaultClickaaUserConfig.islandSummonEnabled,
    ),
    islandAlwaysVisible: readBoolean(
      possibleConfig.islandAlwaysVisible,
      defaultClickaaUserConfig.islandAlwaysVisible,
    ),
    islandShowNowPlaying: readBoolean(
      possibleConfig.islandShowNowPlaying,
      defaultClickaaUserConfig.islandShowNowPlaying,
    ),
    islandShowClipboard: readBoolean(
      possibleConfig.islandShowClipboard,
      defaultClickaaUserConfig.islandShowClipboard,
    ),
    clipboardHistoryEnabled: readBoolean(
      possibleConfig.clipboardHistoryEnabled,
      defaultClickaaUserConfig.clipboardHistoryEnabled,
    ),
    soul: sanitizeSoulSettings(possibleConfig.soul),
    abilities: sanitizeAbilitySettings(possibleConfig.abilities),
  };
}

/** Settings live on this PC only, in the same JSON file the panel edits. */
export class ClickaaConfigStore {
  private readonly jsonFileStore: JsonFileStore<ClickaaUserConfig>;
  private currentConfig: ClickaaUserConfig;

  constructor(private readonly configFilePath: string) {
    this.jsonFileStore = new JsonFileStore(configFilePath, sanitizeStoredConfig);
    this.currentConfig = this.jsonFileStore.read();
  }

  getConfig(): ClickaaUserConfig {
    return { ...this.currentConfig, soul: { ...this.currentConfig.soul }, abilities: { ...this.currentConfig.abilities } };
  }

  updateConfig(configUpdates: Partial<ClickaaUserConfig>): ClickaaUserConfig {
    const updatedConfig: ClickaaUserConfig = {
      ...this.currentConfig,
      ...configUpdates,
      soul: configUpdates.soul
        ? { ...this.currentConfig.soul, ...configUpdates.soul }
        : this.currentConfig.soul,
      abilities: configUpdates.abilities
        ? { ...this.currentConfig.abilities, ...configUpdates.abilities }
        : this.currentConfig.abilities,
    };

    // Values that arrive from the panel are validated strictly so the user sees
    // exactly what is wrong; everything else is sanitised back to a safe default.
    if ("workerBaseUrl" in configUpdates) {
      updatedConfig.workerBaseUrl = normalizeWorkerBaseUrl(updatedConfig.workerBaseUrl);
    }
    if ("geminiApiKey" in configUpdates) {
      updatedConfig.geminiApiKey = normalizeGeminiApiKey(updatedConfig.geminiApiKey);
    }
    if ("selectedClaudeModel" in configUpdates && !isSupportedModel(updatedConfig.selectedClaudeModel)) {
      throw new Error("That Claude model is not supported by this version of Clickaa.");
    }
    if ("geminiChatModel" in configUpdates && !isSupportedGeminiModel(updatedConfig.geminiChatModel)) {
      throw new Error("That Gemini model is not supported by this version of Clickaa.");
    }
    if ("brainProvider" in configUpdates && !isSupportedBrainProvider(updatedConfig.brainProvider)) {
      throw new Error("That brain is not supported by this version of Clickaa.");
    }
    if ("dictationShortcut" in configUpdates && !isSupportedDictationShortcut(updatedConfig.dictationShortcut)) {
      throw new Error("That dictation shortcut is not supported by this version of Clickaa.");
    }

    const sanitizedConfig = sanitizeStoredConfig(updatedConfig);
    this.writeConfigToDisk(sanitizedConfig);
    this.currentConfig = sanitizedConfig;
    return this.getConfig();
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

export type { AbilitySettings, SoulSettings };
