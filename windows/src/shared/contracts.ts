/**
 * Shared contracts between the Clickaa main process, preload bridge, and renderers.
 *
 * This file is compiled for both the main process (CommonJS) and the renderers
 * (browser ES modules), so it must never import from Node or Electron.
 */

export type CompanionVoiceState = "idle" | "listening" | "processing" | "responding";

/* -------------------------------------------------------------------------- */
/* Brain                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * "gemini" runs everything (chat, speech, transcription) on the user's own
 * Google AI Studio key stored on this PC. "worker" keeps the original Cloudflare
 * Worker proxy that hides a shared Claude / AssemblyAI / ElevenLabs key set.
 */
export const brainProviderIds = ["gemini", "worker"] as const;
export type BrainProviderId = (typeof brainProviderIds)[number];

export const geminiChatModels = ["gemini-2.5-flash", "gemini-2.5-pro"] as const;
export type GeminiChatModel = (typeof geminiChatModels)[number];

export const geminiVoiceNames = [
  "Kore",
  "Puck",
  "Charon",
  "Fenrir",
  "Aoede",
  "Leda",
  "Orus",
  "Schedar",
  "Zephyr",
  "Enceladus",
] as const;
export type GeminiVoiceName = (typeof geminiVoiceNames)[number];

export const supportedClaudeModels = ["claude-sonnet-4-6", "claude-opus-4-6"] as const;
export type SupportedClaudeModel = (typeof supportedClaudeModels)[number];

export const speechProviderIds = ["auto", "gemini", "elevenlabs", "windows"] as const;
export type SpeechProviderId = (typeof speechProviderIds)[number];

export interface WorkerConnectionTestResult {
  ok: boolean;
  message: string;
}

export interface BrainConnectionTestResult {
  ok: boolean;
  message: string;
}

/* -------------------------------------------------------------------------- */
/* Soul (personality, voice, abilities)                                       */
/* -------------------------------------------------------------------------- */

export const personalityPresetIds = ["companion", "focused", "coach", "playful", "custom"] as const;
export type PersonalityPresetId = (typeof personalityPresetIds)[number];

export const responseLengthIds = ["short", "balanced", "detailed"] as const;
export type ResponseLengthId = (typeof responseLengthIds)[number];

export const abilityIds = [
  "screenVision",
  "elementPointing",
  "automation",
  "dictation",
  "circleToAsk",
  "webSearch",
  "systemControl",
  "scheduling",
  "toDoList",
  "memory",
  "clipboardHistory",
  "island",
  "wakeWord",
  "systemAccessTier1",
  "systemAccessTier2",
] as const;
export type AbilityId = (typeof abilityIds)[number];
export type AbilitySettings = Record<AbilityId, boolean>;

/**
 * Where Clickaa listens for its name. "offline" uses the speech recognizer
 * Windows already ships, so no audio leaves the machine. "cloud" keeps a local
 * loudness gate and only sends the clip that followed speech.
 */
export const wakeWordProviderIds = ["offline", "cloud"] as const;
export type WakeWordProviderId = (typeof wakeWordProviderIds)[number];

/** How the wake word surface reports itself to the island and the panel. */
export type WakeWordSurfaceState = "off" | "starting" | "listening" | "unavailable" | "error";

export const confirmationModes = ["risky", "all", "never"] as const;
export type ConfirmationMode = (typeof confirmationModes)[number];

export interface SoulSettings {
  assistantName: string;
  personalityPreset: PersonalityPresetId;
  customInstructions: string;
  responseLength: ResponseLengthId;
  speechProvider: SpeechProviderId;
  geminiVoiceName: GeminiVoiceName;
  windowsSpeechRate: number;
}

/* -------------------------------------------------------------------------- */
/* Automations                                                                */
/* -------------------------------------------------------------------------- */

export const searchTargets = ["default", "google", "youtube", "amazon", "bing", "wikipedia"] as const;
export type SearchTarget = (typeof searchTargets)[number];

export const scheduleRepeats = ["none", "daily", "weekdays", "weekends"] as const;
export type ScheduleRepeat = (typeof scheduleRepeats)[number];

export interface OpenAppAction {
  type: "open_app";
  name: string;
}

export interface OpenUrlAction {
  type: "open_url";
  url: string;
}

export interface SearchWebAction {
  type: "search_web";
  query: string;
  target: SearchTarget;
}

export interface TypeTextAction {
  type: "type_text";
  text: string;
}

export interface PressKeysAction {
  type: "press_keys";
  keys: string;
}

export interface ClipboardWriteAction {
  type: "clipboard_write";
  text: string;
}

export interface VolumeAction {
  type: "volume";
  operation: "up" | "down" | "mute" | "unmute" | "set";
  level: number | null;
}

export interface MediaAction {
  type: "media";
  operation: "play_pause" | "next" | "previous" | "stop";
}

export interface WindowAction {
  type: "window";
  operation: "minimize" | "maximize" | "restore" | "close" | "focus";
  app: string;
}

export interface NotifyAction {
  type: "notify";
  title: string;
  body: string;
}

export interface ScrollAction {
  type: "scroll";
  direction: "up" | "down";
  amount: number;
}

export interface TodoAddAction {
  type: "todo_add";
  text: string;
  dueAt: string | null;
}

export interface TodoCompleteAction {
  type: "todo_complete";
  text: string;
}

export interface TodoRemoveAction {
  type: "todo_remove";
  text: string;
}

export interface ScheduleAddAction {
  type: "schedule_add";
  name: string;
  prompt: string;
  startAt: string;
  repeat: ScheduleRepeat;
}

export interface RoutineAddAction {
  type: "routine_add";
  name: string;
  timeOfDay: string;
  repeat: ScheduleRepeat;
  actions: ClickaaAction[];
}

export interface RememberAction {
  type: "remember";
  fact: string;
}

export interface ForgetAction {
  type: "forget";
  query: string;
}

export interface WallpaperAction {
  type: "wallpaper";
  operation: "set" | "solid" | "refresh";
  path: string | null;
  color: string | null;
}

/** "Set a timer for 12 minutes." Timers are in-memory and die with the process. */
export interface TimerStartAction {
  type: "timer_start";
  durationMinutes: number;
  label: string;
}

export interface TimerCancelAction {
  type: "timer_cancel";
  /** Matching words, or null to drop every running timer. */
  query: string | null;
}

/** A phrase the user saves once and inserts anywhere later. */
export interface SnippetSaveAction {
  type: "snippet_save";
  name: string;
  text: string;
}

export interface SnippetInsertAction {
  type: "snippet_insert";
  name: string;
}

export type ClipboardTransformOperation = "summarize" | "fix_grammar" | "shorten" | "translate";

/** Rewrites whatever is on the clipboard, in place, using the user's brain. */
export interface ClipboardTransformAction {
  type: "clipboard_transform";
  operation: ClipboardTransformOperation;
  targetLanguage: string | null;
}

/**
 * Clicks a point on screen, given in the pixel space of the screenshot the
 * model was just shown (the same space as its [POINT:x,y] tags).
 */
export interface ClickAtAction {
  type: "click_at";
  x: number;
  y: number;
  screenNumber: number | null;
  label: string;
}

/**
 * Runs a PowerShell command or script. Whether it may run at all, and how loud
 * the confirmation is, is decided by system-access.ts — never by this shape.
 */
export interface RunCommandAction {
  type: "run_command";
  command: string;
  /** Why Clickaa wants to run it, shown on the confirmation card. */
  reason: string;
}

/** Reads or writes one file inside the user's own folders. */
export interface ManageFileAction {
  type: "manage_file";
  operation: "read" | "write" | "list";
  path: string;
  /** Only for a write. */
  content: string;
}

/** Reads one registry key, values only, and changes nothing. */
export interface ReadRegistryAction {
  type: "read_registry";
  path: string;
  valueName: string | null;
}

/** "wait a second" — used between steps of a task so the screen can catch up. */
export interface WaitAction {
  type: "wait";
  seconds: number;
}

/** "screenshot this area" — opens the snipping overlay and waits for a drag. */
export interface ScreenshotRegionAction {
  type: "screenshot_region";
}

export interface OpenPanelAction {
  type: "open_panel";
  page: string;
}

export type ClickaaAction =
  | OpenAppAction
  | OpenUrlAction
  | SearchWebAction
  | TypeTextAction
  | PressKeysAction
  | ClipboardWriteAction
  | VolumeAction
  | MediaAction
  | WindowAction
  | NotifyAction
  | ScrollAction
  | TodoAddAction
  | TodoCompleteAction
  | TodoRemoveAction
  | ScheduleAddAction
  | RoutineAddAction
  | RememberAction
  | ForgetAction
  | WallpaperAction
  | OpenPanelAction
  | TimerStartAction
  | TimerCancelAction
  | SnippetSaveAction
  | SnippetInsertAction
  | ClipboardTransformAction
  | ScreenshotRegionAction
  | ClickAtAction
  | WaitAction
  | RunCommandAction
  | ManageFileAction
  | ReadRegistryAction;

export type ClickaaActionType =
  | "open_app"
  | "open_url"
  | "search_web"
  | "type_text"
  | "press_keys"
  | "clipboard_write"
  | "volume"
  | "media"
  | "window"
  | "notify"
  | "scroll"
  | "todo_add"
  | "todo_complete"
  | "todo_remove"
  | "schedule_add"
  | "routine_add"
  | "remember"
  | "forget"
  | "wallpaper"
  | "open_panel"
  | "timer_start"
  | "timer_cancel"
  | "snippet_save"
  | "snippet_insert"
  | "clipboard_transform"
  | "screenshot_region"
  | "click_at"
  | "wait"
  | "run_command"
  | "manage_file"
  | "read_registry";

/** Canonical action list, kept in the shared contracts so both sides agree. */
export const clickaaActionTypes: readonly ClickaaActionType[] = [
  "open_app",
  "open_url",
  "search_web",
  "type_text",
  "press_keys",
  "clipboard_write",
  "volume",
  "media",
  "window",
  "notify",
  "scroll",
  "todo_add",
  "todo_complete",
  "todo_remove",
  "schedule_add",
  "routine_add",
  "remember",
  "forget",
  "wallpaper",
  "open_panel",
  "timer_start",
  "timer_cancel",
  "snippet_save",
  "snippet_insert",
  "clipboard_transform",
  "screenshot_region",
  "click_at",
  "wait",
  "run_command",
  "manage_file",
  "read_registry",
];

export type ActionRisk = "safe" | "confirm";

export interface ActionExecutionResult {
  status: "completed" | "failed" | "needs_choice";
  message: string;
  undoLabel: string | null;
  choices: ClickaaAction[];
}

/* -------------------------------------------------------------------------- */
/* Persistent user data                                                       */
/* -------------------------------------------------------------------------- */

export interface ClickaaUserConfig {
  workerBaseUrl: string;
  brainProvider: BrainProviderId;
  geminiApiKey: string;
  geminiChatModel: GeminiChatModel;
  selectedClaudeModel: SupportedClaudeModel;

  cursorEnabled: boolean;
  launchAtLogin: boolean;
  automationPaused: boolean;
  confirmationMode: ConfirmationMode;
  autoApprovedActionTypes: ClickaaActionType[];

  dictationShortcut: DictationShortcutId;
  dictationCleanupEnabled: boolean;
  speakScheduledResults: boolean;

  islandEnabled: boolean;
  /** Slide the island in when the pointer touches the top edge of a display. */
  islandSummonEnabled: boolean;
  /** Keep the island open all the time instead of summoning it. */
  islandAlwaysVisible: boolean;
  islandShowNowPlaying: boolean;
  islandShowClipboard: boolean;
  clipboardHistoryEnabled: boolean;

  wakeWordProvider: WakeWordProviderId;

  soul: SoulSettings;
  abilities: AbilitySettings;
}

export const dictationShortcutIds = ["ctrl+windows", "ctrl+shift+space", "capslock"] as const;
export type DictationShortcutId = (typeof dictationShortcutIds)[number];

export interface TodoItem {
  id: string;
  text: string;
  dueAt: string | null;
  isDone: boolean;
  createdAtIso: string;
}

export interface Snippet {
  id: string;
  name: string;
  text: string;
  createdAtIso: string;
}

export interface MemoryFact {
  id: string;
  text: string;
  createdAtIso: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  kind: "reminder" | "routine";
  prompt: string;
  actions: ClickaaAction[];
  timeOfDay: string | null;
  startAtIso: string | null;
  repeat: ScheduleRepeat;
  isEnabled: boolean;
  nextRunAtIso: string | null;
  lastRunAtIso: string | null;
}

export interface ClipboardClip {
  id: string;
  text: string;
  createdAtIso: string;
}

export type ActivityKind = "action" | "automation" | "system" | "confirmation";

export interface ActivityFeedEntry {
  id: string;
  kind: ActivityKind;
  message: string;
  detail: string;
  createdAtIso: string;
  isUndoable: boolean;
  isUndone: boolean;
}

export interface PendingConfirmation {
  id: string;
  interactionId: number;
  actions: ClickaaAction[];
  reason: string;
  createdAtIso: string;
}

export interface LaunchableAppView {
  id: string;
  name: string;
  source: "startMenu" | "uwp" | "alias";
  isPinned: boolean;
}

export interface NowPlayingInfo {
  isSupported: boolean;
  title: string;
  artist: string;
  appName: string;
  isPlaying: boolean;
}

/* -------------------------------------------------------------------------- */
/* Runtime state                                                              */
/* -------------------------------------------------------------------------- */

export type InteractionKind = "talk" | "dictation" | "circle" | "scheduled";

export type DictationStage = "idle" | "recording" | "cleaning" | "typing";

export interface ClickaaPublicState {
  voiceState: CompanionVoiceState;
  interactionKind: InteractionKind | null;
  dictationStage: DictationStage;
  configured: boolean;
  configurationHint: string;
  brainLabel: string;
  shortcutAvailable: boolean;
  shortcutLabel: string;
  dictationShortcutLabel: string;
  circleShortcutLabel: string;
  lastTranscript: string;
  partialTranscript: string;
  responseText: string;
  audioPowerLevel: number;
  errorMessage: string | null;
  lastActionSummary: string;
  cursorEnabled: boolean;
  automationPaused: boolean;
  islandEnabled: boolean;
  clipboardHistoryEnabled: boolean;
  wakeWordState: WakeWordSurfaceState;
  wakeWordMessage: string;
  wakeWordMuted: boolean;
  config: ClickaaUserConfig;
  /** The last few system-access entries, newest first, for the panel's log. */
  auditLog: AuditLogEntry[];
  auditLogCounts: { allowed: number; refused: number; blocked: number; failed: number; total: number };
}

/** One line of the record Clickaa keeps of everything it did on this pc. */
export interface AuditLogEntry {
  id: string;
  createdAtIso: string;
  summary: string;
  detail: string;
  tier: "tier1" | "tier2" | "blocked";
  outcome: "allowed" | "refused" | "blocked" | "failed";
  resultPreview: string;
}

export interface ActiveTimer {
  id: string;
  label: string;
  endsAtIso: string;
  remainingSeconds: number;
}

export interface IslandStatusSummary {
  voiceState: CompanionVoiceState;
  label: string;
  detail: string;
  interactionKind: InteractionKind | null;
  dictationStage: DictationStage;
  audioPowerLevel: number;
}

/**
 * What the island is doing right now:
 *
 * - `hidden`   nothing on screen,
 * - `revealed` a mark peeking out of the top edge, waiting to be clicked,
 * - `open`     the full island.
 */
export type IslandPresentation = "hidden" | "revealed" | "open";

export interface IslandState {
  isExpanded: boolean;
  isEnabled: boolean;
  presentation: IslandPresentation;
  cursorEnabled: boolean;
  automationPaused: boolean;
  status: IslandStatusSummary;
  nowPlaying: NowPlayingInfo | null;
  showNowPlaying: boolean;
  showClipboard: boolean;
  activityFeed: ActivityFeedEntry[];
  pendingConfirmations: PendingConfirmation[];
  activeTimers: ActiveTimer[];
  snippets: Snippet[];
  wakeWordState: WakeWordSurfaceState;
  wakeWordMuted: boolean;
  /** Why the wake word is in that state, shown as the indicator's tooltip. */
  wakeWordMessage: string;
  todos: TodoItem[];
  scheduledTasks: ScheduledTask[];
  memoryFacts: MemoryFact[];
  clipboardClips: ClipboardClip[];
  quickLaunchApps: LaunchableAppView[];
  brainLabel: string;
  shortcuts: Array<{ label: string; description: string; hint: string }>;
}

/* -------------------------------------------------------------------------- */
/* Renderer payloads                                                          */
/* -------------------------------------------------------------------------- */

export interface AudioPlaybackPayload {
  interactionId: number;
  audioBase64: string;
  contentType: string;
}

export interface FallbackSpeechPayload {
  interactionId: number;
  text: string;
}

export interface OverlayCursorPayload {
  x: number;
  y: number;
  visible: boolean;
}

export interface OverlayPointPayload {
  interactionId: number;
  x: number;
  y: number;
  label: string;
  responseText: string;
}

export interface OverlayModePayload {
  interactionKind: InteractionKind | null;
  hint: string;
  typedText: string;
}

/** A rect the user drew, in display-relative pixels from the selection window. */
export interface SelectionBoundsPayload {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The same selection converted to desktop coordinates for capture. */
export interface RegionSelectorSelection {
  displayId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Switches the island can flip without opening the full panel. */
export type IslandToggleKey = "cursor" | "island" | "clipboard" | "paused";

export interface RegionSelectorState {
  isActive: boolean;
  hint: string;
}

export interface CapturedDisplayImage {
  displayId: number;
  imageBase64: string;
  mediaType: "image/jpeg";
  label: string;
  isCursorDisplay: boolean;
  imageWidth: number;
  imageHeight: number;
  displayBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * A cropped piece of a display, used by circle-to-ask. Coordinates inside the
 * image map back onto the desktop through `displayBounds` and `imageWidth`.
 */
export interface CapturedImageRegion extends CapturedDisplayImage {
  isRegion: true;
}
