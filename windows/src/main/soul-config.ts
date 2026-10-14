import {
  abilityIds,
  AbilityId,
  AbilitySettings,
  clickaaActionTypes,
  ConfirmationMode,
  confirmationModes,
  ClickaaActionType,
  geminiVoiceNames,
  GeminiVoiceName,
  PersonalityPresetId,
  personalityPresetIds,
  ResponseLengthId,
  responseLengthIds,
  SoulSettings,
  speechProviderIds,
  SpeechProviderId,
} from "../shared/contracts";

export interface AbilityDefinition {
  id: AbilityId;
  label: string;
  description: string;
}

/** Everything the user can switch off, in the order the panel shows it. */
export const abilityDefinitions: AbilityDefinition[] = [
  { id: "screenVision", label: "see your screen", description: "look at your screens when you ask, so answers match what you're doing" },
  { id: "elementPointing", label: "point at things", description: "fly the blue cursor to the button or menu it mentions" },
  { id: "automation", label: "act on your pc", description: "open apps, type, press keys, copy to the clipboard, show notifications" },
  { id: "dictation", label: "dictation", description: "hold the dictation shortcut to talk and have clean text land in the focused app" },
  { id: "circleToAsk", label: "circle to ask", description: "circle anything on screen and ask about it out loud" },
  { id: "webSearch", label: "web search", description: "search Google, YouTube, Amazon and friends in your browser" },
  { id: "systemControl", label: "system control", description: "volume, media playback, windows and wallpaper" },
  { id: "scheduling", label: "reminders and routines", description: "run tasks later, by themselves, and tell you what they did" },
  { id: "toDoList", label: "to-do list", description: "keep a spoken to-do list in the island" },
  { id: "memory", label: "memory", description: "remember facts you ask it to keep" },
  { id: "clipboardHistory", label: "clipboard history", description: "keep your recent copies in the island, on this pc only" },
  { id: "island", label: "the island", description: "show the notch at the top of the screen" },
];

export const defaultAbilitySettings: AbilitySettings = {
  screenVision: true,
  elementPointing: true,
  automation: true,
  dictation: true,
  circleToAsk: true,
  webSearch: true,
  systemControl: true,
  scheduling: true,
  toDoList: true,
  memory: true,
  clipboardHistory: true,
  island: true,
  // Off by default: an always-open microphone is the user's decision to make,
  // never something Clickaa switches on for them.
  wakeWord: false,
};

export interface PersonalityPresetDefinition {
  id: PersonalityPresetId;
  label: string;
  description: string;
  instructions: string;
}

export const personalityPresets: PersonalityPresetDefinition[] = [
  {
    id: "companion",
    label: "companion",
    description: "warm, casual, keeps you company",
    instructions: "you're warm, casual and a little playful. you talk like a friend who happens to be very good with computers.",
  },
  {
    id: "focused",
    label: "focused",
    description: "short, precise, no small talk",
    instructions: "you're clipped and precise. you answer the question, you skip the pleasantries, you never pad an answer.",
  },
  {
    id: "coach",
    label: "coach",
    description: "pushes you to finish what you started",
    instructions: "you're an encouraging coach. you notice what the person is working on, you keep them moving, and you nudge them back when they drift.",
  },
  {
    id: "playful",
    label: "playful",
    description: "funny, light, enthusiastic",
    instructions: "you're light and funny without being annoying. you keep the jokes short and you never let them get in the way of the answer.",
  },
  {
    id: "custom",
    label: "custom",
    description: "your own instructions below",
    instructions: "",
  },
];

export const responseLengthInstructions: Record<ResponseLengthId, string> = {
  short: "default to one sentence, two at the most, unless the user asks you to go deeper.",
  balanced: "default to one or two sentences. if the user asks you to explain more, go deeper, or elaborate, give a thorough answer.",
  detailed: "give a complete answer. explain the reasoning, cover the important caveats, and go deeper whenever the question deserves it.",
};

export const defaultSoulSettings: SoulSettings = {
  assistantName: "clickaa",
  personalityPreset: "companion",
  customInstructions: "",
  responseLength: "balanced",
  speechProvider: "auto",
  geminiVoiceName: "Kore",
  windowsSpeechRate: 1.04,
};

export function sanitizeSoulSettings(storedSoul: unknown): SoulSettings {
  if (!storedSoul || typeof storedSoul !== "object") {
    return { ...defaultSoulSettings };
  }

  const possibleSoul = storedSoul as Partial<SoulSettings>;
  const personalityPreset = typeof possibleSoul.personalityPreset === "string"
    && (personalityPresetIds as readonly string[]).includes(possibleSoul.personalityPreset)
    ? possibleSoul.personalityPreset as PersonalityPresetId
    : defaultSoulSettings.personalityPreset;

  const responseLength = typeof possibleSoul.responseLength === "string"
    && (responseLengthIds as readonly string[]).includes(possibleSoul.responseLength)
    ? possibleSoul.responseLength as ResponseLengthId
    : defaultSoulSettings.responseLength;

  const speechProvider = typeof possibleSoul.speechProvider === "string"
    && (speechProviderIds as readonly string[]).includes(possibleSoul.speechProvider)
    ? possibleSoul.speechProvider as SpeechProviderId
    : defaultSoulSettings.speechProvider;

  const geminiVoiceName = typeof possibleSoul.geminiVoiceName === "string"
    && (geminiVoiceNames as readonly string[]).includes(possibleSoul.geminiVoiceName)
    ? possibleSoul.geminiVoiceName as GeminiVoiceName
    : defaultSoulSettings.geminiVoiceName;

  const rawWindowsSpeechRate = possibleSoul.windowsSpeechRate;
  const windowsSpeechRate = typeof rawWindowsSpeechRate === "number" && Number.isFinite(rawWindowsSpeechRate)
    ? Math.max(0.5, Math.min(2, rawWindowsSpeechRate))
    : defaultSoulSettings.windowsSpeechRate;

  const assistantName = typeof possibleSoul.assistantName === "string" && possibleSoul.assistantName.trim()
    ? possibleSoul.assistantName.trim().slice(0, 30)
    : defaultSoulSettings.assistantName;

  return {
    assistantName,
    personalityPreset,
    customInstructions: typeof possibleSoul.customInstructions === "string"
      ? possibleSoul.customInstructions.slice(0, 2_000)
      : defaultSoulSettings.customInstructions,
    responseLength,
    speechProvider,
    geminiVoiceName,
    windowsSpeechRate,
  };
}

export function sanitizeAbilitySettings(storedAbilities: unknown): AbilitySettings {
  if (!storedAbilities || typeof storedAbilities !== "object") {
    return { ...defaultAbilitySettings };
  }

  const possibleAbilities = storedAbilities as Partial<Record<AbilityId, unknown>>;
  const sanitizedAbilities = { ...defaultAbilitySettings };
  for (const abilityId of abilityIds) {
    const storedAbilityValue = possibleAbilities[abilityId];
    if (typeof storedAbilityValue === "boolean") {
      sanitizedAbilities[abilityId] = storedAbilityValue;
    }
  }
  return sanitizedAbilities;
}

export function sanitizeConfirmationMode(storedMode: unknown): ConfirmationMode {
  return typeof storedMode === "string" && (confirmationModes as readonly string[]).includes(storedMode)
    ? storedMode as ConfirmationMode
    : "risky";
}

export function sanitizeAutoApprovedActionTypes(storedActionTypes: unknown): ClickaaActionType[] {
  if (!Array.isArray(storedActionTypes)) {
    return [];
  }
  const knownActionTypes = storedActionTypes.filter(
    (storedActionType): storedActionType is ClickaaActionType =>
      typeof storedActionType === "string"
      && (clickaaActionTypes as readonly string[]).includes(storedActionType),
  );
  return [...new Set(knownActionTypes)];
}

/** The personality rules the system prompt uses, resolved from the preset. */
export function resolvePersonalityInstructions(soul: SoulSettings): string {
  const presetInstructions = personalityPresets.find(
    (personalityPreset) => personalityPreset.id === soul.personalityPreset,
  )?.instructions ?? "";
  return [presetInstructions, soul.customInstructions.trim()].filter(Boolean).join(" ");
}
