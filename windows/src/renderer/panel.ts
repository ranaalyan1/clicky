import type {
  AbilityId,
  ClickaaActionType,
  ClickaaPublicState,
  ClickaaUserConfig,
  ConfirmationMode,
  DictationShortcutId,
  GeminiChatModel,
  GeminiVoiceName,
  PersonalityPresetId,
  ResponseLengthId,
  SpeechProviderId,
} from "../shared/contracts";
import { createClickaaIcon, setIconButton } from "./icons.js";
import { MicrophoneCapture } from "./audio-capture.js";
import { CompanionAudioPlayback } from "./audio-playback.js";

const microphoneCapture = new MicrophoneCapture();
const companionAudioPlayback = new CompanionAudioPlayback();

/** Labels copied from the main process's ability registry, minus the plumbing. */
const abilityCopy: Array<{ id: AbilityId; label: string; description: string }> = [
  { id: "screenVision", label: "see your screen", description: "look at your screens when you ask, so answers match what you're doing" },
  { id: "elementPointing", label: "point at things", description: "fly the blue cursor to the button or menu it mentions" },
  { id: "automation", label: "act on your pc", description: "open apps, type, press keys, copy to the clipboard, show notifications" },
  { id: "dictation", label: "dictation", description: "hold the dictation shortcut to talk and have clean text land in the focused app" },
  { id: "circleToAsk", label: "circle to ask", description: "circle anything on screen and ask about it out loud" },
  { id: "webSearch", label: "web search", description: "search google, youtube, amazon and friends in your browser" },
  { id: "systemControl", label: "system control", description: "volume, media playback, windows and wallpaper" },
  { id: "scheduling", label: "reminders and routines", description: "run tasks later, by themselves, and tell you what they did" },
  { id: "toDoList", label: "to-do list", description: "keep a spoken to-do list in the island" },
  { id: "memory", label: "memory", description: "remember facts you ask it to keep" },
  { id: "clipboardHistory", label: "clipboard history", description: "keep your recent copies in the island, on this pc only" },
  { id: "island", label: "the island", description: "show the notch at the top of the screen" },
  { id: "wakeWord", label: "wake word", description: "listen for \"clickaa\" on this pc, and open the island when you say it" },
  { id: "systemAccessTier1", label: "system access", description: "read-only diagnostics, registry reads, and files in your own folders — each one asks first" },
  { id: "systemAccessTier2", label: "arbitrary commands", description: "let clickaa run commands that change your pc. leave this off unless you want that, and read every card it shows" },
];

const personalityCopy: Array<{ id: PersonalityPresetId; label: string; description: string }> = [
  { id: "companion", label: "companion", description: "warm, casual, keeps you company" },
  { id: "focused", label: "focused", description: "short, precise, no small talk" },
  { id: "coach", label: "coach", description: "pushes you to finish what you started" },
  { id: "playful", label: "playful", description: "funny, light, enthusiastic" },
  { id: "custom", label: "custom", description: "your own instructions only" },
];

const geminiVoiceNames: GeminiVoiceName[] = [
  "Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Schedar", "Zephyr", "Enceladus",
];

/** Action types the model can ask for that are worth pre-approving. */
const autoApproveCopy: Array<{ type: ClickaaActionType; label: string }> = [
  { type: "open_app", label: "open apps" },
  { type: "type_text", label: "type text" },
  { type: "press_keys", label: "press keys" },
  { type: "clipboard_write", label: "write to clipboard" },
  { type: "volume", label: "change volume" },
  { type: "window", label: "move windows" },
  { type: "wallpaper", label: "change wallpaper" },
];

const confirmationModeCopy: Record<ConfirmationMode, string> = {
  risky: "reminders and to-dos happen on their own. opening apps, typing and anything destructive wait for your yes in the island.",
  all: "every action waits for your yes, even adding a to-do.",
  never: "clickaa acts immediately and reports what it did. only pick this if you trust it fully.",
};

let latestState: ClickaaPublicState | null = null;
let panelPushToTalkIsPressed = false;
let hasInitializedFields = false;

function requireElement<ElementType extends HTMLElement>(elementId: string): ElementType {
  const element = document.getElementById(elementId);
  if (!element) {
    throw new Error(`Missing required panel element #${elementId}`);
  }
  return element as ElementType;
}

const element = {
  statusOrb: requireElement<HTMLElement>("status-orb"),
  statusTitle: requireElement<HTMLElement>("status-title"),
  statusDescription: requireElement<HTMLElement>("status-description"),
  shortcutList: requireElement<HTMLElement>("shortcut-list"),
  pushToTalkButton: requireElement<HTMLButtonElement>("push-to-talk-button"),
  activityCard: requireElement<HTMLElement>("activity-card"),
  transcriptLabel: requireElement<HTMLElement>("transcript-label"),
  activityText: requireElement<HTMLElement>("activity-text"),
  errorMessage: requireElement<HTMLElement>("error-message"),
  cursorToggle: requireElement<HTMLInputElement>("cursor-toggle"),
  islandToggle: requireElement<HTMLInputElement>("island-toggle"),
  clipboardToggle: requireElement<HTMLInputElement>("clipboard-toggle"),
  pauseToggle: requireElement<HTMLInputElement>("pause-toggle"),
  shortcutStatus: requireElement<HTMLElement>("shortcut-status"),
  brainLabel: requireElement<HTMLElement>("brain-label"),
  assistantName: requireElement<HTMLInputElement>("assistant-name"),
  personalityChips: requireElement<HTMLElement>("personality-chips"),
  personalityDescription: requireElement<HTMLElement>("personality-description"),
  customInstructions: requireElement<HTMLTextAreaElement>("custom-instructions"),
  speechProvider: requireElement<HTMLSelectElement>("speech-provider"),
  geminiVoice: requireElement<HTMLSelectElement>("gemini-voice"),
  windowsSpeechRate: requireElement<HTMLInputElement>("windows-speech-rate"),
  windowsSpeechRateValue: requireElement<HTMLElement>("windows-speech-rate-value"),
  abilityList: requireElement<HTMLElement>("ability-list"),
  confirmationHint: requireElement<HTMLElement>("confirmation-hint"),
  autoApproveList: requireElement<HTMLElement>("auto-approve-list"),
  todoCount: requireElement<HTMLElement>("todo-count"),
  todoInput: requireElement<HTMLInputElement>("todo-input"),
  todoAddButton: requireElement<HTMLButtonElement>("todo-add-button"),
  todoList: requireElement<HTMLElement>("todo-list"),
  scheduleInput: requireElement<HTMLInputElement>("schedule-input"),
  scheduleAddButton: requireElement<HTMLButtonElement>("schedule-add-button"),
  scheduleHint: requireElement<HTMLElement>("schedule-hint"),
  scheduleList: requireElement<HTMLElement>("schedule-list"),
  memoryInput: requireElement<HTMLInputElement>("memory-input"),
  memoryAddButton: requireElement<HTMLButtonElement>("memory-add-button"),
  memoryClearButton: requireElement<HTMLButtonElement>("memory-clear-button"),
  memoryList: requireElement<HTMLElement>("memory-list"),
  clipboardList: requireElement<HTMLElement>("clipboard-list"),
  clipboardClearButton: requireElement<HTMLButtonElement>("clipboard-clear-button"),
  brainBadge: requireElement<HTMLElement>("brain-badge"),
  brainProviderList: requireElement<HTMLElement>("brain-provider-list"),
  geminiSetup: requireElement<HTMLElement>("gemini-setup"),
  geminiKey: requireElement<HTMLInputElement>("gemini-key"),
  geminiModel: requireElement<HTMLSelectElement>("gemini-model"),
  geminiSaveButton: requireElement<HTMLButtonElement>("gemini-save-button"),
  geminiTestButton: requireElement<HTMLButtonElement>("gemini-test-button"),
  workerSetup: requireElement<HTMLElement>("worker-setup"),
  workerUrl: requireElement<HTMLInputElement>("worker-url"),
  claudeModel: requireElement<HTMLSelectElement>("claude-model"),
  workerSaveButton: requireElement<HTMLButtonElement>("worker-save-button"),
  workerTestButton: requireElement<HTMLButtonElement>("worker-test-button"),
  brainResult: requireElement<HTMLElement>("brain-result"),
  dictationShortcut: requireElement<HTMLSelectElement>("dictation-shortcut"),
  dictationCleanupToggle: requireElement<HTMLInputElement>("dictation-cleanup-toggle"),
  speakScheduledToggle: requireElement<HTMLInputElement>("speak-scheduled-toggle"),
  launchToggle: requireElement<HTMLInputElement>("launch-toggle"),
  islandSummonToggle: requireElement<HTMLInputElement>("island-summon-toggle"),
  islandAlwaysToggle: requireElement<HTMLInputElement>("island-always-toggle"),
  wakeWordToggle: requireElement<HTMLInputElement>("wake-word-toggle"),
  wakeWordProvider: requireElement<HTMLSelectElement>("wake-word-provider"),
  wakeWordStateChip: requireElement<HTMLElement>("wake-word-state-chip"),
  wakeWordStatus: requireElement<HTMLElement>("wake-word-status"),
  auditSummary: requireElement<HTMLElement>("audit-summary"),
  auditList: requireElement<HTMLElement>("audit-list"),
  auditClearButton: requireElement<HTMLButtonElement>("audit-clear-button"),
  islandMusicToggle: requireElement<HTMLInputElement>("island-music-toggle"),
  islandClipboardToggle: requireElement<HTMLInputElement>("island-clipboard-toggle"),
  refreshAppsButton: requireElement<HTMLButtonElement>("refresh-apps-button"),
  talkMicrophone: requireElement<HTMLElement>("talk-microphone"),
  setupVideoButton: requireElement<HTMLButtonElement>("setup-video-button"),
  closeButton: requireElement<HTMLButtonElement>("close-button"),
};

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function renderState(state: ClickaaPublicState): void {
  latestState = state;
  const config = state.config;

  element.statusOrb.dataset.state = state.voiceState;
  element.cursorToggle.checked = config.cursorEnabled;
  element.islandToggle.checked = config.islandEnabled;
  element.clipboardToggle.checked = config.clipboardHistoryEnabled;
  element.pauseToggle.checked = config.automationPaused;

  const statusMessages: Record<ClickaaPublicState["voiceState"], [string, string]> = {
    idle: state.configured
      ? ["ready when you are", `hold ${state.shortcutLabel} anywhere to talk`]
      : ["connect a brain", state.configurationHint || "pick gemini or a worker in the setup tab"],
    listening: ["i'm listening", "release when you're done"],
    processing: ["thinking", state.interactionKind === "circle" ? "looking at what you circled" : "looking at your screen"],
    responding: ["here's what i found", "press the shortcut again to interrupt"],
  };
  [element.statusTitle.textContent, element.statusDescription.textContent] = statusMessages[state.voiceState];

  const isListening = state.voiceState === "listening";
  element.pushToTalkButton.classList.toggle("is-pressed", isListening || panelPushToTalkIsPressed);
  element.pushToTalkButton.querySelector("strong")!.textContent = isListening ? "listening…" : "hold to talk";

  renderShortcuts(state);

  const displayedActivity = state.responseText || state.partialTranscript || state.lastTranscript;
  element.activityCard.hidden = !displayedActivity;
  if (displayedActivity) {
    element.transcriptLabel.textContent = state.responseText
      ? "clickaa"
      : state.partialTranscript
        ? "hearing"
        : "you said";
    element.activityText.textContent = displayedActivity;
  }

  element.errorMessage.hidden = !state.errorMessage;
  element.errorMessage.textContent = state.errorMessage || "";
  element.shortcutStatus.classList.toggle("unavailable", !state.shortcutAvailable);
  element.shortcutStatus.innerHTML = state.shortcutAvailable
    ? "<i></i> global shortcuts active"
    : "<i></i> use the hold-to-talk button";
  element.brainLabel.textContent = `brain: ${state.brainLabel}`;

  renderSoul(config);
  renderScheduleHint(state);
  renderSetup(state);
}

function renderShortcuts(state: ClickaaPublicState): void {
  const shortcutRows = [
    { keys: state.shortcutLabel.split(" + "), description: "hold, ask, release" },
    { keys: state.dictationShortcutLabel.split(" + "), description: "hold, talk badly, get clean text" },
    { keys: state.circleShortcutLabel.split(" + "), description: "hold, circle anything, ask" },
  ];

  element.shortcutList.replaceChildren(...shortcutRows.map((shortcutRow) => {
    const row = document.createElement("div");
    row.className = "shortcut-row";

    const keyContainer = document.createElement("div");
    keyContainer.className = "shortcut-keys";
    for (const keyLabel of shortcutRow.keys) {
      const keyElement = document.createElement("kbd");
      keyElement.textContent = keyLabel;
      keyContainer.append(keyElement);
    }

    const descriptionElement = document.createElement("span");
    descriptionElement.textContent = shortcutRow.description;

    row.append(keyContainer, descriptionElement);
    return row;
  }));
}

function renderSoul(config: ClickaaUserConfig): void {
  if (!hasInitializedFields || document.activeElement !== element.assistantName) {
    element.assistantName.value = config.soul.assistantName;
  }
  if (!hasInitializedFields || document.activeElement !== element.customInstructions) {
    element.customInstructions.value = config.soul.customInstructions;
  }

  element.personalityChips.replaceChildren(...personalityCopy.map((personality) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.classList.toggle("active", config.soul.personalityPreset === personality.id);
    chip.textContent = personality.label;
    chip.addEventListener("click", () => {
      void saveSettings({ soul: { ...config.soul, personalityPreset: personality.id } });
    });
    return chip;
  }));
  element.personalityDescription.textContent = personalityCopy.find(
    (personality) => personality.id === config.soul.personalityPreset,
  )?.description ?? "";

  for (const responseLengthButton of document.querySelectorAll<HTMLButtonElement>("[data-response-length]")) {
    responseLengthButton.classList.toggle(
      "active",
      responseLengthButton.dataset.responseLength === config.soul.responseLength,
    );
  }

  element.speechProvider.value = config.soul.speechProvider;
  if (element.geminiVoice.childElementCount === 0) {
    element.geminiVoice.replaceChildren(...geminiVoiceNames.map((voiceName) => {
      const option = document.createElement("option");
      option.value = voiceName;
      option.textContent = `${voiceName.toLowerCase()}${voiceName === "Kore" ? " (default)" : ""}`;
      return option;
    }));
  }
  element.geminiVoice.value = config.soul.geminiVoiceName;
  element.windowsSpeechRate.value = String(config.soul.windowsSpeechRate);
  element.windowsSpeechRateValue.textContent = `${config.soul.windowsSpeechRate.toFixed(2)}×`;

  element.abilityList.replaceChildren(...abilityCopy.map((ability) => {
    const row = document.createElement("div");
    row.className = "ability-row";

    const copy = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = ability.label;
    const description = document.createElement("span");
    description.textContent = ability.description;
    copy.append(label, description);

    const toggleLabel = document.createElement("label");
    toggleLabel.className = "toggle-control";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = config.abilities[ability.id];
    input.addEventListener("change", () => {
      void saveSettings({ abilities: { ...config.abilities, [ability.id]: input.checked } });
    });
    const slider = document.createElement("span");
    toggleLabel.append(input, slider);

    row.append(copy, toggleLabel);
    return row;
  }));

  for (const confirmationModeButton of document.querySelectorAll<HTMLButtonElement>("[data-confirmation-mode]")) {
    confirmationModeButton.classList.toggle(
      "active",
      confirmationModeButton.dataset.confirmationMode === config.confirmationMode,
    );
  }
  element.confirmationHint.textContent = confirmationModeCopy[config.confirmationMode];

  element.autoApproveList.replaceChildren(...autoApproveCopy.map((autoApprove) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.classList.toggle("active", config.autoApprovedActionTypes.includes(autoApprove.type));
    chip.textContent = autoApprove.label;
    chip.addEventListener("click", () => {
      const isCurrentlyApproved = config.autoApprovedActionTypes.includes(autoApprove.type);
      const nextApprovedTypes = isCurrentlyApproved
        ? config.autoApprovedActionTypes.filter((actionType) => actionType !== autoApprove.type)
        : [...config.autoApprovedActionTypes, autoApprove.type];
      void saveSettings({ autoApprovedActionTypes: nextApprovedTypes });
    });
    return chip;
  }));
}

function renderScheduleHint(state: ClickaaPublicState): void {
  element.scheduleHint.textContent = state.config.abilities.scheduling
    ? "say it out loud instead: \"every morning at nine, open unity and spotify\"."
    : "reminders and routines are switched off in the soul tab.";
  element.scheduleInput.disabled = !state.config.abilities.scheduling;
  element.scheduleAddButton.disabled = !state.config.abilities.scheduling;
}

function renderSetup(state: ClickaaPublicState): void {
  const config = state.config;

  for (const providerCard of element.brainProviderList.querySelectorAll<HTMLButtonElement>("[data-brain-provider]")) {
    providerCard.classList.toggle("active", providerCard.dataset.brainProvider === config.brainProvider);
  }
  element.geminiSetup.classList.toggle("active", config.brainProvider === "gemini");
  element.workerSetup.classList.toggle("active", config.brainProvider === "worker");

  if (!hasInitializedFields || document.activeElement !== element.geminiKey) {
    element.geminiKey.value = config.geminiApiKey;
  }
  if (!hasInitializedFields || document.activeElement !== element.workerUrl) {
    element.workerUrl.value = config.workerBaseUrl;
  }

  element.geminiModel.value = config.geminiChatModel;
  element.claudeModel.value = config.selectedClaudeModel;
  element.dictationShortcut.value = config.dictationShortcut;
  element.dictationCleanupToggle.checked = config.dictationCleanupEnabled;
  element.speakScheduledToggle.checked = config.speakScheduledResults;
  element.launchToggle.checked = config.launchAtLogin;
  element.islandSummonToggle.checked = config.islandSummonEnabled;
  element.islandAlwaysToggle.checked = config.islandAlwaysVisible;
  element.wakeWordToggle.checked = config.abilities.wakeWord;
  element.wakeWordProvider.value = config.wakeWordProvider;
  element.wakeWordStateChip.textContent = describeWakeWordState(state, config);
  element.wakeWordStatus.textContent = describeWakeWordStatus(state, config);
  renderAuditLog(state);
  element.islandMusicToggle.checked = config.islandShowNowPlaying;
  element.islandClipboardToggle.checked = config.islandShowClipboard;

  element.brainBadge.classList.toggle("connected", state.configured);
  element.brainBadge.textContent = state.configured ? state.brainLabel : "not connected";
  hasInitializedFields = true;
}

/* -------------------------------------------------------------------------- */
/* Settings writes                                                            */
/* -------------------------------------------------------------------------- */

function describeWakeWordState(state: ClickaaPublicState, config: ClickaaUserConfig): string {
  if (!config.abilities.wakeWord) {
    return "off";
  }
  if (state.wakeWordMuted) {
    return "muted";
  }

  const stateLabels: Record<ClickaaPublicState["wakeWordState"], string> = {
    off: "off",
    starting: "starting",
    listening: "listening",
    unavailable: "unavailable",
    error: "needs attention",
  };
  return stateLabels[state.wakeWordState];
}

function describeWakeWordStatus(state: ClickaaPublicState, config: ClickaaUserConfig): string {
  if (state.wakeWordMuted) {
    return "muted from the tray. right-click the tray icon and unmute it to start listening again.";
  }
  if (state.wakeWordMessage) {
    return state.wakeWordMessage;
  }
  return config.abilities.wakeWord
    ? "waiting for you to say the name."
    : "switched off, so the microphone is closed.";
}

const auditOutcomeLabels: Record<ClickaaPublicState["auditLog"][number]["outcome"], string> = {
  allowed: "ran",
  refused: "you said no",
  blocked: "clickaa blocked it",
  failed: "failed",
};

function renderAuditLog(state: ClickaaPublicState): void {
  const { auditLog, auditLogCounts } = state;
  element.auditSummary.textContent = auditLogCounts.total
    ? `${auditLogCounts.total} ${auditLogCounts.total === 1 ? "entry" : "entries"}: ${auditLogCounts.allowed} ran, ${auditLogCounts.refused} refused, ${auditLogCounts.blocked} blocked by clickaa, ${auditLogCounts.failed} failed. newest first.`
    : "nothing yet. every command, file and registry read shows up here, whether you allowed it or clickaa refused it.";

  element.auditList.replaceChildren(...auditLog.slice(0, 25).map((auditEntry) => {
    const row = document.createElement("div");
    row.className = "list-row";

    const copy = document.createElement("div");
    copy.className = "list-row-copy";

    const title = document.createElement("strong");
    title.textContent = auditEntry.summary;

    const meta = document.createElement("span");
    const shownTime = auditEntry.createdAtIso.slice(11, 16);
    meta.textContent = `${shownTime} · ${auditOutcomeLabels[auditEntry.outcome]}${auditEntry.tier === "tier2" ? " · arbitrary command" : ""}`;

    copy.append(title, meta);
    row.append(copy);

    if (auditEntry.detail || auditEntry.resultPreview) {
      const detail = document.createElement("code");
      detail.className = "audit-detail";
      detail.textContent = auditEntry.detail || auditEntry.resultPreview;
      row.append(detail);
    }

    return row;
  }));
}

async function saveSettings(settingsUpdates: Partial<ClickaaUserConfig>): Promise<void> {
  try {
    const updatedState = await window.clickaa.updateSettings(settingsUpdates);
    renderState(updatedState);
  } catch (error) {
    showTransientError(error);
  }
}

async function testBrain(settingsUpdates: Partial<ClickaaUserConfig>): Promise<void> {
  element.geminiTestButton.disabled = true;
  element.workerTestButton.disabled = true;
  element.brainResult.className = "connection-result";
  element.brainResult.textContent = "checking…";

  try {
    const testResult = await window.clickaa.testBrain(settingsUpdates);
    element.brainResult.classList.add(testResult.ok ? "success" : "failure");
    element.brainResult.textContent = testResult.message;
    renderState(await window.clickaa.getState());
  } catch (error) {
    element.brainResult.classList.add("failure");
    element.brainResult.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    element.geminiTestButton.disabled = false;
    element.workerTestButton.disabled = false;
  }
}

function showTransientError(error: unknown): void {
  element.errorMessage.hidden = false;
  element.errorMessage.textContent = error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

function setActivePage(pageName: string): void {
  for (const tabButton of document.querySelectorAll<HTMLButtonElement>(".tab-button")) {
    tabButton.classList.toggle("active", tabButton.dataset.page === pageName);
  }
  for (const page of document.querySelectorAll<HTMLElement>(".page")) {
    page.classList.toggle("active", page.dataset.page === pageName);
  }
  if (pageName === "plans" || pageName === "memory") {
    void refreshIslandLists();
  }
}

/**
 * The panel reuses the island's state for the to-do list, schedules, memory and
 * clipboard so there is exactly one source of truth for the user's data.
 */
async function refreshIslandLists(): Promise<void> {
  const islandState = await window.clickaa.getIslandState();

  element.todoCount.textContent = `${islandState.todos.filter((todoItem) => !todoItem.isDone).length} open`;
  element.todoList.replaceChildren(...(islandState.todos.length
    ? islandState.todos.map((todoItem) => {
      const row = document.createElement("div");
      row.className = "list-row";
      row.classList.toggle("done", todoItem.isDone);

      const checkButton = document.createElement("button");
      checkButton.type = "button";
      checkButton.className = "check-button";
      checkButton.classList.toggle("checked", todoItem.isDone);
      checkButton.addEventListener("click", () => {
        window.clickaa.toggleTodo(todoItem.id, !todoItem.isDone);
        window.setTimeout(() => void refreshIslandLists(), 120);
      });

      const copy = document.createElement("div");
      copy.className = "list-row-main";
      const title = document.createElement("div");
      title.className = "list-row-title";
      title.textContent = todoItem.text;
      copy.append(title);
      if (todoItem.dueAt) {
        const meta = document.createElement("div");
        meta.className = "list-row-meta";
        meta.textContent = `due ${todoItem.dueAt.replace("T", " at ")}`;
        copy.append(meta);
      }

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "row-action";
      setIconButton(removeButton, "close", "Remove this to-do", 13);
      removeButton.addEventListener("click", () => {
        window.clickaa.removeTodo(todoItem.id);
        window.setTimeout(() => void refreshIslandLists(), 120);
      });

      row.append(checkButton, copy, removeButton);
      return row;
    })
    : [createEmptyRow("nothing on your list yet.")]));

  element.scheduleList.replaceChildren(...(islandState.scheduledTasks.length
    ? islandState.scheduledTasks.map((scheduledTask) => {
      const row = document.createElement("div");
      row.className = "list-row";

      const copy = document.createElement("div");
      copy.className = "list-row-main";
      const title = document.createElement("div");
      title.className = "list-row-title";
      title.textContent = scheduledTask.name;
      const meta = document.createElement("div");
      meta.className = "list-row-meta";
      const nextRunText = scheduledTask.nextRunAtIso
        ? `next ${scheduledTask.nextRunAtIso.replace("T", " at ")}`
        : "finished";
      meta.textContent = `${scheduledTask.kind === "routine" ? "routine" : "reminder"} · ${scheduledTask.repeat} · ${nextRunText}`;
      copy.append(title, meta);

      const toggleButton = document.createElement("button");
      toggleButton.type = "button";
      toggleButton.className = "switch-pill";
      toggleButton.classList.toggle("on", scheduledTask.isEnabled);
      toggleButton.textContent = scheduledTask.isEnabled ? "on" : "off";
      toggleButton.addEventListener("click", () => {
        window.clickaa.toggleSchedule(scheduledTask.id, !scheduledTask.isEnabled);
        window.setTimeout(() => void refreshIslandLists(), 120);
      });

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "row-action";
      setIconButton(removeButton, "close", "Remove this reminder", 13);
      removeButton.addEventListener("click", () => {
        window.clickaa.removeSchedule(scheduledTask.id);
        window.setTimeout(() => void refreshIslandLists(), 120);
      });

      row.append(copy, toggleButton, removeButton);
      return row;
    })
    : [createEmptyRow("no reminders or routines yet.")]));

  element.memoryList.replaceChildren(...(islandState.memoryFacts.length
    ? islandState.memoryFacts.map((memoryFact) => {
      const row = document.createElement("div");
      row.className = "list-row";

      const copy = document.createElement("div");
      copy.className = "list-row-main";
      const title = document.createElement("div");
      title.className = "list-row-title";
      title.textContent = memoryFact.text;
      copy.append(title);

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "row-action";
      setIconButton(removeButton, "close", "Forget this", 13);
      removeButton.addEventListener("click", () => {
        window.clickaa.removeMemory(memoryFact.id);
        window.setTimeout(() => void refreshIslandLists(), 120);
      });

      row.append(copy, removeButton);
      return row;
    })
    : [createEmptyRow("nothing remembered yet. say \"remember …\" and it sticks.")]));

  element.clipboardList.replaceChildren(...(islandState.clipboardClips.length
    ? islandState.clipboardClips.slice(0, 12).map((clipboardClip) => {
      const row = document.createElement("div");
      row.className = "list-row";

      const copy = document.createElement("div");
      copy.className = "list-row-main";
      const title = document.createElement("div");
      title.className = "list-row-title";
      title.textContent = clipboardClip.text.replace(/\s+/gu, " ").slice(0, 120);
      copy.append(title);

      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "row-action neutral";
      setIconButton(copyButton, "copy", "Copy this clip back", 13);
      copyButton.addEventListener("click", () => void window.clickaa.copyClip(clipboardClip.id));

      row.append(copy, copyButton);
      return row;
    })
    : [createEmptyRow("nothing copied yet.")]));
}

function createEmptyRow(message: string): HTMLElement {
  const emptyRow = document.createElement("div");
  emptyRow.className = "list-empty";
  emptyRow.textContent = message;
  return emptyRow;
}

/* Panel event wiring ------------------------------------------------------ */

for (const tabButton of document.querySelectorAll<HTMLButtonElement>(".tab-button")) {
  tabButton.addEventListener("click", () => setActivePage(tabButton.dataset.page ?? "home"));
}

for (const responseLengthButton of document.querySelectorAll<HTMLButtonElement>("[data-response-length]")) {
  responseLengthButton.addEventListener("click", () => {
    if (!latestState) {
      return;
    }
    void saveSettings({
      soul: {
        ...latestState.config.soul,
        responseLength: responseLengthButton.dataset.responseLength as ResponseLengthId,
      },
    });
  });
}

for (const confirmationModeButton of document.querySelectorAll<HTMLButtonElement>("[data-confirmation-mode]")) {
  confirmationModeButton.addEventListener("click", () => {
    void saveSettings({ confirmationMode: confirmationModeButton.dataset.confirmationMode as ConfirmationMode });
  });
}

for (const providerCard of element.brainProviderList.querySelectorAll<HTMLButtonElement>("[data-brain-provider]")) {
  providerCard.addEventListener("click", () => {
    void saveSettings({ brainProvider: providerCard.dataset.brainProvider === "worker" ? "worker" : "gemini" });
  });
}

element.assistantName.addEventListener("change", () => {
  const soul = latestState?.config.soul;
  if (soul) {
    void saveSettings({ soul: { ...soul, assistantName: element.assistantName.value } });
  }
});

element.customInstructions.addEventListener("change", () => {
  const soul = latestState?.config.soul;
  if (soul) {
    void saveSettings({ soul: { ...soul, customInstructions: element.customInstructions.value } });
  }
});

element.speechProvider.addEventListener("change", () => {
  const soul = latestState?.config.soul;
  if (soul) {
    void saveSettings({ soul: { ...soul, speechProvider: element.speechProvider.value as SpeechProviderId } });
  }
});

element.geminiVoice.addEventListener("change", () => {
  const soul = latestState?.config.soul;
  if (soul) {
    void saveSettings({ soul: { ...soul, geminiVoiceName: element.geminiVoice.value as GeminiVoiceName } });
  }
});

element.windowsSpeechRate.addEventListener("input", () => {
  element.windowsSpeechRateValue.textContent = `${Number(element.windowsSpeechRate.value).toFixed(2)}×`;
});

element.windowsSpeechRate.addEventListener("change", () => {
  const soul = latestState?.config.soul;
  if (soul) {
    void saveSettings({ soul: { ...soul, windowsSpeechRate: Number(element.windowsSpeechRate.value) } });
  }
});

element.geminiModel.addEventListener("change", () => {
  void saveSettings({ geminiChatModel: element.geminiModel.value as GeminiChatModel });
});
element.claudeModel.addEventListener("change", () => {
  void saveSettings({ selectedClaudeModel: element.claudeModel.value as ClickaaPublicState["config"]["selectedClaudeModel"] });
});
element.dictationShortcut.addEventListener("change", () => {
  void saveSettings({ dictationShortcut: element.dictationShortcut.value as DictationShortcutId });
});

element.geminiSaveButton.addEventListener("click", () => void saveSettings({ geminiApiKey: element.geminiKey.value }));
element.geminiTestButton.addEventListener("click", () => void testBrain({ geminiApiKey: element.geminiKey.value }));
element.workerSaveButton.addEventListener("click", () => void saveSettings({ workerBaseUrl: element.workerUrl.value }));
element.workerTestButton.addEventListener("click", () => void testBrain({ workerBaseUrl: element.workerUrl.value }));

element.todoAddButton.addEventListener("click", () => {
  const todoText = element.todoInput.value.trim();
  if (!todoText) {
    return;
  }
  element.todoInput.value = "";
  window.clickaa.addTodo(todoText);
  window.setTimeout(() => void refreshIslandLists(), 160);
});

element.todoInput.addEventListener("keydown", (keyboardEvent) => {
  if (keyboardEvent.key === "Enter") {
    element.todoAddButton.click();
  }
});

// Reminders and routines are set by voice ("search amazon for bags tomorrow at 9"),
// because the same sentence has to be understood the same way in both places.
element.scheduleAddButton.addEventListener("click", () => {
  element.scheduleHint.textContent = "hold the talk shortcut and say it out loud — clickaa will set it up and show it here.";
  window.clickaa.showPanel("home");
});

element.memoryAddButton.addEventListener("click", () => {
  const factText = element.memoryInput.value.trim();
  if (!factText) {
    return;
  }
  element.memoryInput.value = "";
  window.clickaa.addMemory(factText);
  window.setTimeout(() => void refreshIslandLists(), 160);
});

element.memoryInput.addEventListener("keydown", (keyboardEvent) => {
  if (keyboardEvent.key === "Enter") {
    element.memoryAddButton.click();
  }
});

element.memoryClearButton.addEventListener("click", () => {
  window.clickaa.clearMemory();
  window.setTimeout(() => void refreshIslandLists(), 160);
});

element.clipboardClearButton.addEventListener("click", () => {
  window.clickaa.clearClips();
  window.setTimeout(() => void refreshIslandLists(), 120);
});

element.refreshAppsButton.addEventListener("click", () => {
  element.refreshAppsButton.textContent = "scanning…";
  void window.clickaa.refreshAppIndex().then((appCount) => {
    element.refreshAppsButton.textContent = `${appCount} apps`;
    window.setTimeout(() => {
      element.refreshAppsButton.textContent = "rescan apps";
    }, 2_500);
  });
});

element.cursorToggle.addEventListener("change", () => void saveSettings({ cursorEnabled: element.cursorToggle.checked }));
element.islandToggle.addEventListener("change", () => void saveSettings({ islandEnabled: element.islandToggle.checked }));
element.clipboardToggle.addEventListener("change", () => {
  void saveSettings({ clipboardHistoryEnabled: element.clipboardToggle.checked });
});
element.pauseToggle.addEventListener("change", () => void saveSettings({ automationPaused: element.pauseToggle.checked }));
element.dictationCleanupToggle.addEventListener("change", () => {
  void saveSettings({ dictationCleanupEnabled: element.dictationCleanupToggle.checked });
});
element.speakScheduledToggle.addEventListener("change", () => {
  void saveSettings({ speakScheduledResults: element.speakScheduledToggle.checked });
});
element.launchToggle.addEventListener("change", () => void saveSettings({ launchAtLogin: element.launchToggle.checked }));
element.islandSummonToggle.addEventListener("change", () => {
  void saveSettings({ islandSummonEnabled: element.islandSummonToggle.checked });
});
element.auditClearButton.addEventListener("click", () => {
  window.clickaa.clearAuditLog();
});
element.wakeWordToggle.addEventListener("change", () => {
  void saveSettings({
    abilities: {
      ...(latestState?.config.abilities ?? {}),
      wakeWord: element.wakeWordToggle.checked,
    } as ClickaaUserConfig["abilities"],
  });
});
element.wakeWordProvider.addEventListener("change", () => {
  void saveSettings({ wakeWordProvider: element.wakeWordProvider.value as ClickaaUserConfig["wakeWordProvider"] });
});
element.islandAlwaysToggle.addEventListener("change", () => {
  void saveSettings({ islandAlwaysVisible: element.islandAlwaysToggle.checked });
});
element.islandMusicToggle.addEventListener("change", () => {
  void saveSettings({ islandShowNowPlaying: element.islandMusicToggle.checked });
});
element.islandClipboardToggle.addEventListener("change", () => {
  void saveSettings({ islandShowClipboard: element.islandClipboardToggle.checked });
});

element.pushToTalkButton.addEventListener("pointerdown", (pointerEvent) => {
  pointerEvent.preventDefault();
  panelPushToTalkIsPressed = true;
  window.clickaa.pushToTalkPressed();
  renderPanelPressedState();
});
element.pushToTalkButton.addEventListener("pointerup", stopPanelPushToTalk);
element.pushToTalkButton.addEventListener("pointercancel", stopPanelPushToTalk);
element.pushToTalkButton.addEventListener("lostpointercapture", stopPanelPushToTalk);
element.pushToTalkButton.addEventListener("keydown", (keyboardEvent) => {
  if ((keyboardEvent.key === " " || keyboardEvent.key === "Enter") && !keyboardEvent.repeat) {
    keyboardEvent.preventDefault();
    panelPushToTalkIsPressed = true;
    window.clickaa.pushToTalkPressed();
    renderPanelPressedState();
  }
});
element.pushToTalkButton.addEventListener("keyup", (keyboardEvent) => {
  if (keyboardEvent.key === " " || keyboardEvent.key === "Enter") {
    keyboardEvent.preventDefault();
    stopPanelPushToTalk();
  }
});

function renderPanelPressedState(): void {
  if (latestState) {
    renderState(latestState);
  }
  element.pushToTalkButton.classList.toggle("is-pressed", panelPushToTalkIsPressed);
}

function stopPanelPushToTalk(): void {
  if (!panelPushToTalkIsPressed) {
    return;
  }
  panelPushToTalkIsPressed = false;
  window.clickaa.pushToTalkReleased();
  renderPanelPressedState();
}

setIconButton(element.closeButton, "close", "Hide Clickaa", 14);
element.talkMicrophone.replaceChildren(createClickaaIcon("microphone", 19));

element.setupVideoButton.addEventListener("click", () => window.clickaa.openSetupVideo());
element.closeButton.addEventListener("click", () => window.clickaa.hidePanel());
document.addEventListener("contextmenu", (event) => event.preventDefault());
window.addEventListener("blur", () => {
  if (panelPushToTalkIsPressed) {
    stopPanelPushToTalk();
  }
});

/* Bridge wiring ---------------------------------------------------------- */

window.clickaa.onState(renderState);
window.clickaa.onOpenPanelPage((page) => setActivePage(page));
window.clickaa.onAudioCaptureStart(({ interactionId }) => void microphoneCapture.start(interactionId));
window.clickaa.onAudioCaptureStop(({ interactionId }) => void microphoneCapture.stop(interactionId));
window.clickaa.onAudioPlayback((payload) => void companionAudioPlayback.playAudio(payload));
window.clickaa.onFallbackSpeech((payload) => {
  companionAudioPlayback.speakWithWindowsVoice(payload, latestState?.config.soul.windowsSpeechRate);
});
window.clickaa.onStopAudioPlayback(() => companionAudioPlayback.stop());

void window.clickaa.getState().then(renderState).catch(showTransientError);
void refreshIslandLists();
