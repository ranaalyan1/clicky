import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  AbilitySettings,
  brainProviderIds,
  defaultLocalBrainBaseUrl,
  defaultLocalBrainModel,
  BrainProviderId,
  UstaadUserConfig,
  dictationShortcutIds,
  DictationShortcutId,
  geminiChatModels,
  GeminiChatModel,
  SoulSettings,
  supportedClaudeModels,
  SupportedClaudeModel,
  wakeWordProviderIds,
  WakeWordProviderId,
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
import { defaultPresenceSettings, sanitizePresenceSettings } from "./presence-schedule";
import { normalizeLocalBrainBaseUrl } from "./local-brain-client";

export const defaultUstaadUserConfig: UstaadUserConfig = {
  workerBaseUrl: "",
  brainProvider: "gemini",
  localBrainBaseUrl: defaultLocalBrainBaseUrl,
  localBrainModel: defaultLocalBrainModel,
  localBrainSeesScreen: false,
  offlineMode: false,
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
  wakeWordProvider: "offline",
  soul: { ...defaultSoulSettings },
  abilities: { ...defaultAbilitySettings },
  presence: { ...defaultPresenceSettings },
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
    throw new Error("Enter a valid Worker URL, for example https://ustaad.example.workers.dev");
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

function isSupportedWakeWordProvider(
  candidateProvider: unknown,
): candidateProvider is WakeWordProviderId {
  return typeof candidateProvider === "string"
    && (wakeWordProviderIds as readonly string[]).includes(candidateProvider);
}

function isSupportedDictationShortcut(candidateShortcut: unknown): candidateShortcut is DictationShortcutId {
  return typeof candidateShortcut === "string"
    && (dictationShortcutIds as readonly string[]).includes(candidateShortcut);
}

function readBoolean(storedValue: unknown, fallbackValue: boolean): boolean {
  return typeof storedValue === "boolean" ? storedValue : fallbackValue;
}

export function sanitizeStoredConfig(storedConfig: unknown): UstaadUserConfig {
  if (!storedConfig || typeof storedConfig !== "object") {
    return { ...defaultUstaadUserConfig };
  }

  const possibleConfig = storedConfig as Partial<UstaadUserConfig>;

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

  let localBrainBaseUrl = defaultUstaadUserConfig.localBrainBaseUrl;
  if (typeof possibleConfig.localBrainBaseUrl === "string") {
    try {
      localBrainBaseUrl = normalizeLocalBrainBaseUrl(possibleConfig.localBrainBaseUrl)
        || defaultUstaadUserConfig.localBrainBaseUrl;
    } catch {
      localBrainBaseUrl = defaultUstaadUserConfig.localBrainBaseUrl;
    }
  }

  return {
    workerBaseUrl,
    brainProvider: isSupportedBrainProvider(possibleConfig.brainProvider)
      ? possibleConfig.brainProvider
      : defaultUstaadUserConfig.brainProvider,
    localBrainBaseUrl,
    localBrainModel: typeof possibleConfig.localBrainModel === "string" && possibleConfig.localBrainModel.trim()
      ? possibleConfig.localBrainModel.trim().slice(0, 120)
      : defaultUstaadUserConfig.localBrainModel,
    localBrainSeesScreen: readBoolean(
      possibleConfig.localBrainSeesScreen,
      defaultUstaadUserConfig.localBrainSeesScreen,
    ),
    offlineMode: readBoolean(possibleConfig.offlineMode, defaultUstaadUserConfig.offlineMode),
    geminiApiKey,
    geminiChatModel: isSupportedGeminiModel(possibleConfig.geminiChatModel)
      ? possibleConfig.geminiChatModel
      : defaultUstaadUserConfig.geminiChatModel,
    selectedClaudeModel: isSupportedModel(possibleConfig.selectedClaudeModel)
      ? possibleConfig.selectedClaudeModel
      : defaultUstaadUserConfig.selectedClaudeModel,
    cursorEnabled: readBoolean(possibleConfig.cursorEnabled, defaultUstaadUserConfig.cursorEnabled),
    launchAtLogin: readBoolean(possibleConfig.launchAtLogin, defaultUstaadUserConfig.launchAtLogin),
    automationPaused: readBoolean(possibleConfig.automationPaused, defaultUstaadUserConfig.automationPaused),
    confirmationMode: sanitizeConfirmationMode(possibleConfig.confirmationMode),
    autoApprovedActionTypes: sanitizeAutoApprovedActionTypes(possibleConfig.autoApprovedActionTypes),
    wakeWordProvider: isSupportedWakeWordProvider(possibleConfig.wakeWordProvider)
      ? possibleConfig.wakeWordProvider
      : defaultUstaadUserConfig.wakeWordProvider,
    dictationShortcut: isSupportedDictationShortcut(possibleConfig.dictationShortcut)
      ? possibleConfig.dictationShortcut
      : defaultUstaadUserConfig.dictationShortcut,
    dictationCleanupEnabled: readBoolean(
      possibleConfig.dictationCleanupEnabled,
      defaultUstaadUserConfig.dictationCleanupEnabled,
    ),
    speakScheduledResults: readBoolean(
      possibleConfig.speakScheduledResults,
      defaultUstaadUserConfig.speakScheduledResults,
    ),
    islandEnabled: readBoolean(possibleConfig.islandEnabled, defaultUstaadUserConfig.islandEnabled),
    islandSummonEnabled: readBoolean(
      possibleConfig.islandSummonEnabled,
      defaultUstaadUserConfig.islandSummonEnabled,
    ),
    islandAlwaysVisible: readBoolean(
      possibleConfig.islandAlwaysVisible,
      defaultUstaadUserConfig.islandAlwaysVisible,
    ),
    islandShowNowPlaying: readBoolean(
      possibleConfig.islandShowNowPlaying,
      defaultUstaadUserConfig.islandShowNowPlaying,
    ),
    islandShowClipboard: readBoolean(
      possibleConfig.islandShowClipboard,
      defaultUstaadUserConfig.islandShowClipboard,
    ),
    clipboardHistoryEnabled: readBoolean(
      possibleConfig.clipboardHistoryEnabled,
      defaultUstaadUserConfig.clipboardHistoryEnabled,
    ),
    soul: sanitizeSoulSettings(possibleConfig.soul),
    abilities: sanitizeAbilitySettings(possibleConfig.abilities),
    presence: sanitizePresenceSettings(possibleConfig.presence),
  };
}

/** Settings live on this PC only, in the same JSON file the panel edits. */
export class UstaadConfigStore {
  private readonly jsonFileStore: JsonFileStore<UstaadUserConfig>;
  private currentConfig: UstaadUserConfig;

  constructor(private readonly configFilePath: string) {
    this.jsonFileStore = new JsonFileStore(configFilePath, sanitizeStoredConfig);
    this.currentConfig = this.jsonFileStore.read();
  }

  getConfig(): UstaadUserConfig {
    return {
      ...this.currentConfig,
      soul: { ...this.currentConfig.soul },
      abilities: { ...this.currentConfig.abilities },
      presence: { ...this.currentConfig.presence },
    };
  }

  updateConfig(configUpdates: Partial<UstaadUserConfig>): UstaadUserConfig {
    const updatedConfig: UstaadUserConfig = {
      ...this.currentConfig,
      ...configUpdates,
      soul: configUpdates.soul
        ? { ...this.currentConfig.soul, ...configUpdates.soul }
        : this.currentConfig.soul,
      abilities: configUpdates.abilities
        ? { ...this.currentConfig.abilities, ...configUpdates.abilities }
        : this.currentConfig.abilities,
      // Merged field by field so the panel can send just "the morning time
      // changed" without wiping the rest of the check-in settings.
      presence: configUpdates.presence
        ? { ...this.currentConfig.presence, ...configUpdates.presence }
        : this.currentConfig.presence,
    };

    // Values that arrive from the panel are validated strictly so the user sees
    // exactly what is wrong; everything else is sanitised back to a safe default.
    if ("workerBaseUrl" in configUpdates) {
      updatedConfig.workerBaseUrl = normalizeWorkerBaseUrl(updatedConfig.workerBaseUrl);
    }
    if ("geminiApiKey" in configUpdates) {
      updatedConfig.geminiApiKey = normalizeGeminiApiKey(updatedConfig.geminiApiKey);
    }
    if ("localBrainBaseUrl" in configUpdates) {
      // Throws with the reason ("that address is on the internet") so the
      // panel can show it beside the field instead of replacing it silently.
      updatedConfig.localBrainBaseUrl = normalizeLocalBrainBaseUrl(updatedConfig.localBrainBaseUrl)
        || defaultUstaadUserConfig.localBrainBaseUrl;
    }
    if ("localBrainModel" in configUpdates) {
      const requestedModel = updatedConfig.localBrainModel.trim();
      if (!requestedModel) {
        throw new Error("Name the model your local server has loaded.");
      }
      updatedConfig.localBrainModel = requestedModel.slice(0, 120);
    }
    if ("selectedClaudeModel" in configUpdates && !isSupportedModel(updatedConfig.selectedClaudeModel)) {
      throw new Error("That Claude model is not supported by this version of Ustaad.");
    }
    if ("geminiChatModel" in configUpdates && !isSupportedGeminiModel(updatedConfig.geminiChatModel)) {
      throw new Error("That Gemini model is not supported by this version of Ustaad.");
    }
    if ("brainProvider" in configUpdates && !isSupportedBrainProvider(updatedConfig.brainProvider)) {
      throw new Error("That brain is not supported by this version of Ustaad.");
    }
    if ("dictationShortcut" in configUpdates && !isSupportedDictationShortcut(updatedConfig.dictationShortcut)) {
      throw new Error("That dictation shortcut is not supported by this version of Ustaad.");
    }
    if ("wakeWordProvider" in configUpdates && !isSupportedWakeWordProvider(updatedConfig.wakeWordProvider)) {
      throw new Error("That wake word mode is not supported by this version of Ustaad.");
    }

    const sanitizedConfig = sanitizeStoredConfig(updatedConfig);
    this.writeConfigToDisk(sanitizedConfig);
    this.currentConfig = sanitizedConfig;
    return this.getConfig();
  }

  private writeConfigToDisk(config: UstaadUserConfig): void {
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
