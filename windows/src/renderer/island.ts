import { createUstaadIcon, setIconButton, updateIconButton } from "./icons.js";
import type {
  ActivityFeedEntry,
  IslandToggleKey,
  ClipboardClip,
  IslandPresentation,
  IslandState,
  LaunchableAppView,
  MemoryFact,
  NowPlayingInfo,
  ScheduledTask,
  TodoItem,
} from "../shared/contracts";

/** Flat wallpapers the island can apply straight through the Windows bridge. */
const wallpaperSwatchColors = [
  "#0f2a24",
  "#122338",
  "#2a1c3a",
  "#3a1f24",
  "#2b2a17",
  "#1d1d1f",
  "#0b3b34",
  "#243b55",
];

let latestIslandState: IslandState | null = null;
let activeSection = "now";
let isPointerOverIsland = false;
let currentPresentation: IslandPresentation = "hidden";

function requireElement<ElementType extends HTMLElement>(elementId: string): ElementType {
  const element = document.getElementById(elementId);
  if (!element) {
    throw new Error(`Missing required island element #${elementId}`);
  }
  return element as ElementType;
}

const element = {
  body: document.body,
  notchLabel: requireElement<HTMLElement>("notch-label"),
  notchTrack: requireElement<HTMLElement>("notch-track"),
  notchBadge: requireElement<HTMLElement>("notch-badge"),
  closeButton: requireElement<HTMLButtonElement>("close-button"),
  headerStatus: requireElement<HTMLElement>("header-status"),
  confirmationStack: requireElement<HTMLElement>("confirmation-stack"),
  musicCard: requireElement<HTMLElement>("music-card"),
  musicTitle: requireElement<HTMLElement>("music-title"),
  musicArtist: requireElement<HTMLElement>("music-artist"),
  activityList: requireElement<HTMLElement>("activity-list"),
  shortcutList: requireElement<HTMLElement>("shortcut-list"),
  wakeIndicator: requireElement<HTMLElement>("wake-indicator"),
  timerCard: requireElement<HTMLElement>("timer-card"),
  timerSummary: requireElement<HTMLElement>("timer-summary"),
  timerList: requireElement<HTMLElement>("timer-list"),
  snippetList: requireElement<HTMLElement>("snippet-list"),
  todoCount: requireElement<HTMLElement>("todo-count"),
  todoList: requireElement<HTMLElement>("todo-list"),
  scheduleList: requireElement<HTMLElement>("schedule-list"),
  presenceNote: requireElement<HTMLElement>("presence-note"),
  memoryList: requireElement<HTMLElement>("memory-list"),
  clipList: requireElement<HTMLElement>("clip-list"),
  appGrid: requireElement<HTMLElement>("app-grid"),
  wallpaperGrid: requireElement<HTMLElement>("wallpaper-grid"),
  speechSummary: requireElement<HTMLElement>("speech-summary"),
  toggleList: requireElement<HTMLElement>("toggle-list"),
  brainSummary: requireElement<HTMLElement>("brain-summary"),
};

/* -------------------------------------------------------------------------- */
/* Collapsed notch                                                            */
/* -------------------------------------------------------------------------- */

function renderNotch(islandState: IslandState): void {
  const statusSummary = islandState.status;
  element.body.dataset.voiceState = statusSummary.voiceState;

  const collapsedLabels: Record<IslandState["status"]["voiceState"], string> = {
    idle: islandState.pendingConfirmations.length
      ? "waiting for your yes"
      : statusSummary.detail || "ustaad",
    listening: statusSummary.interactionKind === "dictation" ? "listening for dictation" : "listening…",
    processing: statusSummary.dictationStage === "cleaning"
      ? "cleaning up your words"
      : statusSummary.interactionKind === "circle"
        ? "looking at your circle"
        : "thinking…",
    responding: statusSummary.label || "ustaad",
  };
  element.notchLabel.textContent = collapsedLabels[statusSummary.voiceState];
  element.notchTrack.textContent = islandState.nowPlaying?.isPlaying
    ? `${islandState.nowPlaying.title} — ${islandState.nowPlaying.artist}`.replace(/ — $/u, "")
    : "";

  const pendingConfirmationCount = islandState.pendingConfirmations.length;
  const openTodoCount = islandState.todos.filter((todoItem) => !todoItem.isDone).length;
  const badgeText = pendingConfirmationCount
    ? `${pendingConfirmationCount} to confirm`
    : openTodoCount
      ? `${openTodoCount} open`
      : "";
  element.notchBadge.hidden = !badgeText;
  element.notchBadge.textContent = badgeText;
  element.notchBadge.classList.toggle("alert", pendingConfirmationCount > 0);

  element.headerStatus.textContent = islandState.status.label || "ready";
  element.brainSummary.textContent = `thinking with ${islandState.brainLabel}. these settings live in the ustaad panel.`;
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                   */
/* -------------------------------------------------------------------------- */

function createListRow(): { row: HTMLDivElement; copy: HTMLDivElement } {
  const row = document.createElement("div");
  row.className = "island-list-row island-row";
  const copy = document.createElement("div");
  copy.className = "island-row-main";
  row.append(copy);
  return { row, copy };
}

function createTitle(text: string): HTMLDivElement {
  const title = document.createElement("div");
  title.className = "island-row-title";
  title.textContent = text;
  return title;
}

function createMeta(text: string): HTMLDivElement {
  const meta = document.createElement("div");
  meta.className = "island-row-meta";
  meta.textContent = text;
  return meta;
}

function createEmptyRow(message: string): HTMLDivElement {
  const emptyRow = document.createElement("div");
  emptyRow.className = "island-empty";
  emptyRow.textContent = message;
  return emptyRow;
}

function renderConfirmations(islandState: IslandState): void {
  element.confirmationStack.replaceChildren(...islandState.pendingConfirmations.map((pendingConfirmation) => {
    const card = document.createElement("div");
    card.className = "confirmation-card";

    const title = document.createElement("p");
    title.className = "confirmation-title";
    title.textContent = "your call";

    const reason = document.createElement("p");
    reason.className = "confirmation-reason";
    reason.textContent = pendingConfirmation.reason;

    const buttonRow = document.createElement("div");
    buttonRow.className = "confirmation-buttons";

    const approveButton = document.createElement("button");
    approveButton.type = "button";
    approveButton.className = "confirmation-button approve";
    approveButton.textContent = "yes, do it";
    approveButton.addEventListener("click", () => {
      void window.ustaad.resolveConfirmation(pendingConfirmation.id, "approve");
    });

    const rejectButton = document.createElement("button");
    rejectButton.type = "button";
    rejectButton.className = "confirmation-button";
    rejectButton.textContent = "no";
    rejectButton.addEventListener("click", () => {
      void window.ustaad.resolveConfirmation(pendingConfirmation.id, "reject");
    });

    buttonRow.append(approveButton, rejectButton);
    card.append(title, reason, buttonRow);
    return card;
  }));
}

/** The "save that as a skill?" offer, which only ever appears after a task has
    worked a few times and only ever saves when the user presses the button. */
function renderSkillSuggestion(islandState: IslandState): void {
  const suggestion = islandState.skillSuggestion;
  if (!suggestion) {
    return;
  }

  const card = document.createElement("div");
  card.className = "confirmation-card skill-suggestion-card";

  const title = document.createElement("p");
  title.className = "confirmation-title";
  title.textContent = `that worked ${suggestion.successCount} times`;

  const reason = document.createElement("p");
  reason.className = "confirmation-reason";
  reason.textContent = `save it as "${suggestion.proposedName}"? then you can just ask for it by name.`;

  const buttonRow = document.createElement("div");
  buttonRow.className = "confirmation-buttons";

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "confirmation-button approve";
  saveButton.textContent = "save it";
  saveButton.addEventListener("click", () => {
    void window.ustaad.saveSkillSuggestion();
  });

  const dismissButton = document.createElement("button");
  dismissButton.type = "button";
  dismissButton.className = "confirmation-button";
  dismissButton.textContent = "no thanks";
  dismissButton.addEventListener("click", () => {
    void window.ustaad.dismissSkillSuggestion();
  });

  buttonRow.append(saveButton, dismissButton);
  card.append(title, reason, buttonRow);
  element.confirmationStack.append(card);
}

function renderActivityFeed(activityEntries: ActivityFeedEntry[]): void {
  if (!activityEntries.length) {
    element.activityList.replaceChildren(createEmptyRow("nothing yet. hold ctrl + alt and just talk."));
    return;
  }

  element.activityList.replaceChildren(...activityEntries.map((activityEntry) => {
    const { row, copy } = createListRow();
    copy.append(createTitle(activityEntry.message));
    const detailText = [activityEntry.detail, activityEntry.isUndone ? "undo applied" : ""]
      .filter(Boolean)
      .join(" · ");
    if (detailText) {
      copy.append(createMeta(detailText));
    }

    if (activityEntry.isUndoable) {
      const undoButton = document.createElement("button");
      undoButton.type = "button";
      undoButton.className = "undo-chip with-icon";
      undoButton.append(
        createUstaadIcon(activityEntry.isUndone ? "check" : "undo", 12),
        document.createTextNode(activityEntry.isUndone ? "undone" : "undo"),
      );
      undoButton.disabled = activityEntry.isUndone;
      undoButton.addEventListener("click", () => {
        undoButton.disabled = true;
        void window.ustaad.undoActivity(activityEntry.id);
      });
      row.append(undoButton);
    }

    return row;
  }));
}

function renderShortcutList(islandState: IslandState): void {
  element.shortcutList.replaceChildren(...islandState.shortcuts.map((shortcut) => {
    const { row, copy } = createListRow();
    copy.append(createTitle(shortcut.label), createMeta(shortcut.description));
    const hint = document.createElement("span");
    hint.className = "island-row-meta";
    hint.textContent = shortcut.hint;
    row.append(hint);
    return row;
  }));
}

function renderMusic(nowPlaying: NowPlayingInfo | null, showNowPlaying: boolean): void {
  element.musicCard.hidden = !showNowPlaying || !nowPlaying?.isSupported;
  if (!nowPlaying) {
    return;
  }

  element.musicTitle.textContent = nowPlaying.title || "nothing playing";
  element.musicArtist.textContent = [nowPlaying.artist, nowPlaying.appName].filter(Boolean).join(" · ");
  element.body.dataset.mediaPlaying = String(nowPlaying.isPlaying);

  const playPauseButton = element.musicCard.querySelector<HTMLButtonElement>('[data-media="play_pause"]');
  if (playPauseButton) {
    updateIconButton(
      playPauseButton,
      nowPlaying.isPlaying ? "pause" : "play",
      nowPlaying.isPlaying ? "Pause" : "Play",
      15,
    );
  }
}

/** Turns 754 seconds into "12:34", and anything past an hour into "1:02:03". */
function formatTimerRemaining(remainingSeconds: number): string {
  const hours = Math.floor(remainingSeconds / 3_600);
  const minutes = Math.floor((remainingSeconds % 3_600) / 60);
  const seconds = remainingSeconds % 60;
  const paddedSeconds = String(seconds).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
  }
  return `${minutes}:${paddedSeconds}`;
}

/**
 * The microphone light. It only appears when Ustaad is actually listening for
 * its name, and it is muted-coloured when the tray switch has silenced it, so
 * the answer to "is it listening to me?" is never a guess.
 */
function renderWakeIndicator(islandState: IslandState): void {
  const isOn = islandState.wakeWordState !== "off"
    || islandState.wakeWordMuted;
  element.wakeIndicator.hidden = !isOn;
  if (!isOn) {
    return;
  }

  const stateLabels: Record<IslandState["wakeWordState"], string> = {
    off: "wake word off",
    starting: "wake word starting",
    listening: "listening for ustaad",
    unavailable: "wake word unavailable",
    error: "wake word stopped",
  };
  const stateLabel = islandState.wakeWordMuted
    ? "microphone muted"
    : stateLabels[islandState.wakeWordState];

  element.wakeIndicator.dataset.wakeState = islandState.wakeWordMuted
    ? "muted"
    : islandState.wakeWordState;
  element.wakeIndicator.title = islandState.wakeWordMessage
    ? `${stateLabel} - ${islandState.wakeWordMessage}`
    : stateLabel;
  element.wakeIndicator.setAttribute("aria-label", stateLabel);
}

function renderTimers(islandState: IslandState): void {
  const runningTimers = islandState.activeTimers;
  element.timerCard.hidden = !runningTimers.length;
  element.timerSummary.textContent = runningTimers.length
    ? `${runningTimers.length} running`
    : "";

  element.timerList.replaceChildren(...runningTimers.map((activeTimer) => {
    const { row, copy } = createListRow();
    copy.append(
      createTitle(`${activeTimer.label} · ${formatTimerRemaining(activeTimer.remainingSeconds)}`),
      createMeta(`ends at ${activeTimer.endsAtIso.slice(11, 16)}`),
    );
    return row;
  }));
}

function renderSnippets(islandState: IslandState): void {
  element.snippetList.replaceChildren(...(islandState.snippets.length
    ? islandState.snippets.map((snippet) => {
      const { row, copy } = createListRow();
      copy.append(
        createTitle(snippet.name),
        createMeta(snippet.text.replace(/\s+/gu, " ").slice(0, 90)),
      );
      return row;
    })
    : [createEmptyRow("say \"save this as my address\" and it lands here.")]));
}

function renderPlans(islandState: IslandState): void {
  element.todoCount.textContent = `${islandState.todos.filter((todoItem) => !todoItem.isDone).length} open`;
  element.todoList.replaceChildren(...(islandState.todos.length
    ? islandState.todos.map(buildTodoRow)
    : [createEmptyRow("say \"add call mom to my list\" and it lands here.")]));

  element.scheduleList.replaceChildren(...(islandState.scheduledTasks.length
    ? islandState.scheduledTasks.map(buildScheduledTaskRow)
    : [createEmptyRow("say \"every morning at nine open spotify\" to make a routine.")]));

  element.memoryList.replaceChildren(...(islandState.memoryFacts.length
    ? islandState.memoryFacts.map(buildMemoryRow)
    : [createEmptyRow("say \"remember my wifi password is …\" and ustaad keeps it.")]));

  // The whole point of presence is that it is visible before it happens: the
  // chip says when Ustaad will speak up next without the user asking.
  element.presenceNote.textContent = islandState.presence.nextCheckInLabel ?? "";
  element.presenceNote.hidden = !islandState.presence.nextCheckInLabel;
}

function buildTodoRow(todoItem: TodoItem): HTMLElement {
  const { row, copy } = createListRow();
  row.classList.toggle("done", todoItem.isDone);

  const checkButton = document.createElement("button");
  checkButton.type = "button";
  checkButton.className = "check-button";
  checkButton.classList.toggle("checked", todoItem.isDone);
  checkButton.title = todoItem.isDone ? "mark as not done" : "mark as done";
  checkButton.addEventListener("click", () => {
    window.ustaad.toggleTodo(todoItem.id, !todoItem.isDone);
  });

  copy.append(createTitle(todoItem.text));
  if (todoItem.dueAt) {
    copy.append(createMeta(`due ${todoItem.dueAt.replace("T", " at ")}`));
  }

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "row-icon-button";
  setIconButton(removeButton, "close", "Remove this to-do", 12);
  removeButton.addEventListener("click", () => window.ustaad.removeTodo(todoItem.id));

  row.prepend(checkButton);
  row.append(removeButton);
  return row;
}

function buildScheduledTaskRow(scheduledTask: ScheduledTask): HTMLElement {
  const { row, copy } = createListRow();
  row.classList.toggle("done", !scheduledTask.isEnabled);

  const kindLabel = scheduledTask.kind === "routine" ? "routine" : "once";
  const nextRunText = scheduledTask.nextRunAtIso
    ? `next ${scheduledTask.nextRunAtIso.replace("T", " at ")}`
    : "finished";
  copy.append(
    createTitle(scheduledTask.name),
    createMeta(`${kindLabel} · ${scheduledTask.repeat} · ${nextRunText}${scheduledTask.isEnabled ? "" : " · paused"}`),
  );

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "undo-chip";
  toggleButton.textContent = scheduledTask.isEnabled ? "pause" : "resume";
  toggleButton.addEventListener("click", () => {
    window.ustaad.toggleSchedule(scheduledTask.id, !scheduledTask.isEnabled);
  });

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "row-icon-button";
  setIconButton(removeButton, "close", "Remove this reminder", 12);
  removeButton.addEventListener("click", () => window.ustaad.removeSchedule(scheduledTask.id));

  row.append(toggleButton, removeButton);
  return row;
}

function buildMemoryRow(memoryFact: MemoryFact): HTMLElement {
  const { row, copy } = createListRow();
  copy.append(createTitle(memoryFact.text));

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "row-icon-button";
  setIconButton(removeButton, "close", "Forget this", 12);
  removeButton.addEventListener("click", () => window.ustaad.removeMemory(memoryFact.id));

  row.append(removeButton);
  return row;
}

function renderClips(clipboardClips: ClipboardClip[]): void {
  element.clipList.replaceChildren(...(clipboardClips.length
    ? clipboardClips.map((clipboardClip) => {
      const { row, copy } = createListRow();
      copy.append(createTitle(clipboardClip.text.replace(/\s+/gu, " ").slice(0, 160)));

      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "undo-chip with-icon";
      copyButton.append(createUstaadIcon("copy", 12), document.createTextNode("copy"));
      copyButton.addEventListener("click", () => {
        copyButton.replaceChildren(
          createUstaadIcon("check", 12),
          document.createTextNode("copied"),
        );
        void window.ustaad.copyClip(clipboardClip.id).then((didCopy) => {
          window.setTimeout(() => {
            copyButton.replaceChildren(
              createUstaadIcon("copy", 12),
              document.createTextNode(didCopy ? "copy" : "gone"),
            );
          }, 1_200);
        });
      });

      row.append(copyButton);
      return row;
    })
    : [createEmptyRow("copy something anywhere and it shows up here.")]));
}

function renderApps(quickLaunchApps: LaunchableAppView[]): void {
  element.appGrid.replaceChildren(...(quickLaunchApps.length
    ? quickLaunchApps.map((launchableApp) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "app-tile";
      tile.textContent = launchableApp.name;
      tile.title = `open ${launchableApp.name}`;
      tile.addEventListener("click", () => {
        tile.textContent = "opening…";
        void window.ustaad.launchApp(launchableApp.name).finally(() => {
          window.setTimeout(() => {
            tile.textContent = launchableApp.name;
          }, 1_200);
        });
      });
      return tile;
    })
    : [createEmptyRow("ask ustaad to scan your start menu in the panel's setup tab.")]));
}

function renderWallpaperSwatches(): void {
  if (element.wallpaperGrid.childElementCount) {
    return;
  }

  element.wallpaperGrid.replaceChildren(...wallpaperSwatchColors.map((wallpaperColor) => {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "wallpaper-swatch";
    swatch.style.background = wallpaperColor;
    swatch.title = `set a ${wallpaperColor} wallpaper`;
    swatch.addEventListener("click", () => window.ustaad.setWallpaperSolidColor(wallpaperColor));
    return swatch;
  }));
}

function renderSpeechSummary(islandState: IslandState): void {
  const speechRows = [
    { label: "brain", value: islandState.brainLabel },
    { label: "shortcuts", value: islandState.shortcuts.map((shortcut) => shortcut.label).join("  ") },
  ];

  element.speechSummary.replaceChildren(...speechRows.map((speechRow) => {
    const { row, copy } = createListRow();
    copy.append(createTitle(speechRow.label), createMeta(speechRow.value));
    return row;
  }));
}

function renderControlToggles(islandState: IslandState): void {
  const toggleDefinitions: Array<{
    key: IslandToggleKey;
    label: string;
    detail: string;
    isOn: boolean;
  }> = [
    {
      key: "cursor",
      label: "cursor buddy",
      detail: "the blue cursor follows your pointer",
      isOn: islandState.cursorEnabled,
    },
    {
      key: "island",
      label: "island",
      detail: "this notch, always on top",
      isOn: islandState.isEnabled,
    },
    {
      key: "clipboard",
      label: "clipboard history",
      detail: "keeps recent copies on this pc",
      isOn: islandState.showClipboard,
    },
    {
      key: "paused",
      label: "pause actions",
      detail: "ustaad only describes what it would do",
      isOn: islandState.automationPaused,
    },
  ];

  element.toggleList.replaceChildren(...toggleDefinitions.map((toggleDefinition) => {
    const row = document.createElement("div");
    row.className = "switch-row";

    const copy = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = toggleDefinition.label;
    const detail = document.createElement("span");
    detail.textContent = toggleDefinition.detail;
    copy.append(label, detail);

    const control = document.createElement("label");
    control.className = "switch-control";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = toggleDefinition.isOn;
    input.dataset.islandToggle = toggleDefinition.key;
    input.addEventListener("change", () => {
      window.ustaad.setIslandToggle(toggleDefinition.key, input.checked);
    });
    const track = document.createElement("i");
    control.append(input, track);

    row.append(copy, control);
    return row;
  }));
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/**
 * The repair card for a saved skill that keeps failing. It has three faces:
 * the offer, the wait while the model thinks, and the proposed new way. Only
 * "save the fix" changes the skill, and even then every run is confirmed.
 */
function renderSkillRepair(islandState: IslandState): void {
  const repair = islandState.skillRepair;
  if (!repair) {
    return;
  }

  const card = document.createElement("div");
  card.className = "confirmation-card skill-repair-card";

  const title = document.createElement("p");
  title.className = "confirmation-title";
  const reason = document.createElement("p");
  reason.className = "confirmation-reason";
  const buttonRow = document.createElement("div");
  buttonRow.className = "confirmation-buttons";

  if (repair.stage === "offered") {
    title.textContent = `the "${repair.skillName}" skill is not working`;
    reason.textContent = `it has not worked ${repair.failureStreak} times in a row`
      + (repair.lastOutcomeNote ? ` — ${repair.lastOutcomeNote}` : "")
      + ". want me to work out a different way?";
    card.append(title, reason, buttonRow);

    const fixButton = document.createElement("button");
    fixButton.type = "button";
    fixButton.className = "confirmation-button approve";
    fixButton.textContent = "work out a fix";
    const keepButton = document.createElement("button");
    keepButton.type = "button";
    keepButton.className = "confirmation-button";
    keepButton.textContent = "not now";

    fixButton.addEventListener("click", () => {
      fixButton.disabled = true;
      keepButton.disabled = true;
      reason.textContent = "working out a different way…";
      void window.ustaad.workOutSkillRepair().then((message) => {
        reason.textContent = message;
      });
    });
    keepButton.addEventListener("click", () => {
      void window.ustaad.dismissSkillRepair();
    });

    buttonRow.append(fixButton, keepButton);
    element.confirmationStack.append(card);
    return;
  }

  if (repair.stage === "working") {
    title.textContent = `working out a new way to do "${repair.skillName}"`;
    reason.textContent = "one moment — this is only thinking, nothing on this pc is being changed.";
    card.append(title, reason);
    element.confirmationStack.append(card);
    return;
  }

  title.textContent = `a different way to do "${repair.skillName}"`;
  const stepSummary = repair.proposedActions.length
    ? `it starts with ${repair.proposedActions.length} step${repair.proposedActions.length === 1 ? "" : "s"}.`
    : "no starting steps — I will look at the screen instead.";
  reason.textContent = `new aim: ${repair.proposedGoal ?? repair.skillName}.`
    + (repair.explanation ? ` ${repair.explanation}` : "")
    + ` ${stepSummary}`;
  card.append(title, reason, buttonRow);

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "confirmation-button approve";
  saveButton.textContent = "save the fix";
  const oldButton = document.createElement("button");
  oldButton.type = "button";
  oldButton.className = "confirmation-button";
  oldButton.textContent = "keep the old one";

  saveButton.addEventListener("click", () => {
    saveButton.disabled = true;
    oldButton.disabled = true;
    reason.textContent = "saving…";
    void window.ustaad.saveSkillRepair().then((message) => {
      reason.textContent = message;
    });
  });
  oldButton.addEventListener("click", () => {
    void window.ustaad.dismissSkillRepair();
  });

  buttonRow.append(saveButton, oldButton);
  element.confirmationStack.append(card);
}

/* -------------------------------------------------------------------------- */

function renderIsland(islandState: IslandState): void {
  latestIslandState = islandState;
  currentPresentation = islandState.presentation;
  element.body.dataset.presentation = islandState.presentation;
  element.body.dataset.expanded = String(islandState.isExpanded);
  renderNotch(islandState);
  renderWakeIndicator(islandState);
  renderConfirmations(islandState);
  renderSkillSuggestion(islandState);
  renderSkillRepair(islandState);
  renderTimers(islandState);
  renderSnippets(islandState);
  renderActivityFeed(islandState.activityFeed);
  renderShortcutList(islandState);
  renderMusic(islandState.nowPlaying, islandState.showNowPlaying);
  renderPlans(islandState);
  renderClips(islandState.clipboardClips);
  renderApps(islandState.quickLaunchApps);
  renderWallpaperSwatches();
  renderSpeechSummary(islandState);
  renderControlToggles(islandState);
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

element.body.addEventListener("click", (mouseEvent) => {
  const clickedNotchRow = (mouseEvent.target as HTMLElement).closest(".notch-row");
  if (!clickedNotchRow) {
    return;
  }
  if (currentPresentation === "open") {
    window.ustaad.setIslandExpanded(false);
    return;
  }
  window.ustaad.setIslandExpanded(true);
});

element.closeButton.addEventListener("click", () => window.ustaad.closeIsland());

document.addEventListener("keydown", (keyboardEvent) => {
  if (keyboardEvent.key === "Escape") {
    window.ustaad.closeIsland();
  }
});

for (const sectionButton of document.querySelectorAll<HTMLButtonElement>(".section-tab")) {
  sectionButton.addEventListener("click", () => {
    activeSection = sectionButton.dataset.section ?? "now";
    for (const candidateButton of document.querySelectorAll<HTMLButtonElement>(".section-tab")) {
      candidateButton.classList.toggle("active", candidateButton.dataset.section === activeSection);
    }
    for (const section of document.querySelectorAll<HTMLElement>(".island-section")) {
      section.classList.toggle("active", section.dataset.section === activeSection);
    }
  });
}

for (const mediaButton of document.querySelectorAll<HTMLButtonElement>("[data-media]")) {
  mediaButton.addEventListener("click", () => {
    const mediaOperation = mediaButton.dataset.media;
    if (mediaOperation === "play_pause" || mediaOperation === "next" || mediaOperation === "previous") {
      void window.ustaad.mediaControl(mediaOperation);
    }
  });
}

requireElement<HTMLButtonElement>("open-panel-button").addEventListener("click", () => window.ustaad.openPanel("home"));
requireElement<HTMLButtonElement>("open-soul-button").addEventListener("click", () => window.ustaad.openPanel("soul"));
requireElement<HTMLButtonElement>("open-setup-button").addEventListener("click", () => window.ustaad.openPanel("setup"));
requireElement<HTMLButtonElement>("clear-clips-button").addEventListener("click", () => window.ustaad.clearClips());

/**
 * The island is click-through until the pointer is actually over it, so the
 * main process needs to know when to start and stop forwarding mouse events.
 */
document.addEventListener("mouseenter", () => {
  isPointerOverIsland = true;
  window.ustaad.setIslandPointerOver(true);
});
document.addEventListener("mouseleave", () => {
  isPointerOverIsland = false;
  window.ustaad.setIslandPointerOver(false);
});
document.addEventListener("mousemove", () => {
  if (!isPointerOverIsland) {
    isPointerOverIsland = true;
    window.ustaad.setIslandPointerOver(true);
  }
});
document.addEventListener("mouseout", (mouseEvent) => {
  if (!mouseEvent.relatedTarget && isPointerOverIsland) {
    isPointerOverIsland = false;
    window.ustaad.setIslandPointerOver(false);
  }
});
document.addEventListener("contextmenu", (contextMenuEvent) => contextMenuEvent.preventDefault());
document.addEventListener("wheel", (wheelEvent) => {
  // Scrolling over the island means the user wants it open.
  if (!latestIslandState?.isExpanded && wheelEvent.deltaY !== 0) {
    wheelEvent.preventDefault();
    window.ustaad.setIslandExpanded(true);
  }
}, { passive: false });

setIconButton(element.closeButton, "close", "Close Ustaad", 13);

window.ustaad.onIslandPresentation(({ presentation }) => {
  currentPresentation = presentation;
  element.body.dataset.presentation = presentation;
  if (latestIslandState) {
    latestIslandState.presentation = presentation;
    latestIslandState.isExpanded = presentation === "open";
  }
});

window.ustaad.onIslandState(renderIsland);
window.ustaad.onIslandExpanded(({ isExpanded }) => {
  element.body.dataset.expanded = String(isExpanded);
  if (latestIslandState) {
    latestIslandState.isExpanded = isExpanded;
  }
});

void window.ustaad.getIslandState().then(renderIsland);
