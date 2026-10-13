import {
  ActionRisk,
  AbilityId,
  AbilitySettings,
  ClipboardTransformOperation,
  ClickaaAction,
  ClickaaActionType,
  ConfirmationMode,
  SearchTarget,
  searchTargets,
} from "../shared/contracts";

/* The action list itself lives in the shared contracts file so the panel, the
   island and the main process can never disagree about what exists. */

/**
 * Clickaa's action protocol.
 *
 * The model finishes its spoken answer with a single machine-readable block:
 *
 *   <actions>[{"type":"open_app","name":"Spotify"}]</actions>
 *
 * A text protocol keeps every provider (Claude through the Worker and Gemini
 * with a local key) on exactly the same code path, and keeps the whole thing
 * unit-testable without touching a network. Every action is validated and
 * normalized here before anything is allowed to touch the user's PC.
 */

export const clipboardTransformOperations: readonly ClipboardTransformOperation[] = [
  "summarize",
  "fix_grammar",
  "shorten",
  "translate",
];

export const actionBlockOpeningTag = "<actions>";
export const actionBlockClosingTag = "</actions>";

export interface ParsedModelResponse {
  spokenText: string;
  actions: ClickaaAction[];
  problems: string[];
}

interface ActionDefinition {
  type: ClickaaActionType;
  risk: ActionRisk;
  /** The ability that must be enabled before this action may run at all. */
  requiredAbility: AbilityId;
  /** How the confirmation card describes the action to the user. */
  describe: (action: ClickaaAction) => string;
  /** Turns untrusted model output into a validated action, or explains why not. */
  normalize: (rawAction: Record<string, unknown>) => { action: ClickaaAction | null; problem: string | null };
}

function readRequiredText(rawAction: Record<string, unknown>, key: string): string | null {
  const rawValue = rawAction[key];
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return null;
  }
  return rawValue.trim();
}

/** Optional text: missing or blank reads as "the model did not say". */
function readOptionalText(rawAction: Record<string, unknown>, key: string): string | null {
  const rawValue = rawAction[key];
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return null;
  }
  return rawValue.trim().slice(0, 200);
}

function normalizeSearchTarget(rawTarget: unknown): SearchTarget {
  return typeof rawTarget === "string" && (searchTargets as readonly string[]).includes(rawTarget)
    ? rawTarget as SearchTarget
    : "default";
}

function clampNumber(rawValue: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsedValue = typeof rawValue === "number" ? rawValue : Number.parseFloat(String(rawValue ?? ""));
  if (!Number.isFinite(parsedValue)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, Math.round(parsedValue)));
}

export function isAllowedAutomationUrl(rawUrl: string): boolean {
  try {
    const parsedUrl = new URL(rawUrl);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

const actionDefinitions: Record<ClickaaActionType, ActionDefinition> = {
  open_app: {
    type: "open_app",
    risk: "confirm",
    requiredAbility: "automation",
    describe: (action) => `open ${(action as { name: string }).name}`,
    normalize: (rawAction) => {
      const name = readRequiredText(rawAction, "name");
      return name
        ? { action: { type: "open_app", name }, problem: null }
        : { action: null, problem: "open_app needs a name" };
    },
  },
  open_url: {
    type: "open_url",
    risk: "safe",
    requiredAbility: "automation",
    describe: (action) => `open ${(action as { url: string }).url}`,
    normalize: (rawAction) => {
      const url = readRequiredText(rawAction, "url");
      if (!url) {
        return { action: null, problem: "open_url needs a url" };
      }
      if (!isAllowedAutomationUrl(url)) {
        return { action: null, problem: `open_url only accepts http and https links, got ${url.slice(0, 60)}` };
      }
      return { action: { type: "open_url", url }, problem: null };
    },
  },
  search_web: {
    type: "search_web",
    risk: "safe",
    requiredAbility: "webSearch",
    describe: (action) => {
      const searchAction = action as { query: string; target: SearchTarget };
      return searchAction.target === "default"
        ? `search the web for ${searchAction.query}`
        : `search ${searchAction.target} for ${searchAction.query}`;
    },
    normalize: (rawAction) => {
      const query = readRequiredText(rawAction, "query");
      if (!query) {
        return { action: null, problem: "search_web needs a query" };
      }
      return {
        action: { type: "search_web", query, target: normalizeSearchTarget(rawAction.target) },
        problem: null,
      };
    },
  },
  type_text: {
    type: "type_text",
    risk: "confirm",
    requiredAbility: "automation",
    describe: (action) => `type "${(action as { text: string }).text}"`,
    normalize: (rawAction) => {
      const text = readRequiredText(rawAction, "text");
      if (!text) {
        return { action: null, problem: "type_text needs text" };
      }
      return { action: { type: "type_text", text: text.slice(0, 4_000) }, problem: null };
    },
  },
  press_keys: {
    type: "press_keys",
    risk: "confirm",
    requiredAbility: "automation",
    describe: (action) => `press ${(action as { keys: string }).keys}`,
    normalize: (rawAction) => {
      const keys = readRequiredText(rawAction, "keys");
      if (!keys || !/^[a-z0-9+\- ]+$/iu.test(keys)) {
        return { action: null, problem: "press_keys needs a combination like ctrl+s" };
      }
      return { action: { type: "press_keys", keys: keys.toLowerCase() }, problem: null };
    },
  },
  clipboard_write: {
    type: "clipboard_write",
    risk: "confirm",
    requiredAbility: "automation",
    describe: (action) => `copy "${(action as { text: string }).text}" to the clipboard`,
    normalize: (rawAction) => {
      const text = readRequiredText(rawAction, "text");
      return text
        ? { action: { type: "clipboard_write", text: text.slice(0, 4_000) }, problem: null }
        : { action: null, problem: "clipboard_write needs text" };
    },
  },
  volume: {
    type: "volume",
    risk: "confirm",
    requiredAbility: "systemControl",
    describe: (action) => {
      const volumeAction = action as { operation: string; level: number | null };
      return volumeAction.operation === "set"
        ? `set the volume to ${volumeAction.level}%`
        : `turn the volume ${volumeAction.operation}`;
    },
    normalize: (rawAction) => {
      const validOperations = ["up", "down", "mute", "unmute", "set"] as const;
      const operation = typeof rawAction.operation === "string"
        && (validOperations as readonly string[]).includes(rawAction.operation)
        ? rawAction.operation as (typeof validOperations)[number]
        : null;
      if (!operation) {
        return { action: null, problem: "volume needs up, down, mute, unmute, or set" };
      }
      const level = operation === "set" ? clampNumber(rawAction.level, 0, 100, 50) : null;
      return { action: { type: "volume", operation, level }, problem: null };
    },
  },
  media: {
    type: "media",
    risk: "safe",
    requiredAbility: "systemControl",
    describe: (action) => `press ${(action as { operation: string }).operation.replace("_", " ")}`,
    normalize: (rawAction) => {
      const validOperations = ["play_pause", "next", "previous", "stop"] as const;
      const operation = typeof rawAction.operation === "string"
        && (validOperations as readonly string[]).includes(rawAction.operation)
        ? rawAction.operation as (typeof validOperations)[number]
        : null;
      return operation
        ? { action: { type: "media", operation }, problem: null }
        : { action: null, problem: "media needs play_pause, next, previous, or stop" };
    },
  },
  window: {
    type: "window",
    risk: "confirm",
    requiredAbility: "systemControl",
    describe: (action) => {
      const windowAction = action as { operation: string; app: string };
      return `${windowAction.operation} the ${windowAction.app} window`;
    },
    normalize: (rawAction) => {
      const validOperations = ["minimize", "maximize", "restore", "close", "focus"] as const;
      const operation = typeof rawAction.operation === "string"
        && (validOperations as readonly string[]).includes(rawAction.operation)
        ? rawAction.operation as (typeof validOperations)[number]
        : null;
      const app = readRequiredText(rawAction, "app") ?? "active";
      return operation
        ? { action: { type: "window", operation, app }, problem: null }
        : { action: null, problem: "window needs minimize, maximize, restore, close, or focus" };
    },
  },
  notify: {
    type: "notify",
    risk: "safe",
    requiredAbility: "automation",
    describe: (action) => `show a notification: ${(action as { title: string }).title}`,
    normalize: (rawAction) => {
      const title = readRequiredText(rawAction, "title");
      if (!title) {
        return { action: null, problem: "notify needs a title" };
      }
      const body = readRequiredText(rawAction, "body") ?? "";
      return { action: { type: "notify", title: title.slice(0, 120), body: body.slice(0, 400) }, problem: null };
    },
  },
  scroll: {
    type: "scroll",
    risk: "safe",
    requiredAbility: "automation",
    describe: (action) => `scroll ${(action as { direction: string }).direction}`,
    normalize: (rawAction) => {
      const direction = rawAction.direction === "up" ? "up" : "down";
      return {
        action: { type: "scroll", direction, amount: clampNumber(rawAction.amount, 1, 20, 3) },
        problem: null,
      };
    },
  },
  todo_add: {
    type: "todo_add",
    risk: "safe",
    requiredAbility: "toDoList",
    describe: (action) => `add "${(action as { text: string }).text}" to your list`,
    normalize: (rawAction) => {
      const text = readRequiredText(rawAction, "text");
      if (!text) {
        return { action: null, problem: "todo_add needs text" };
      }
      const dueAt = typeof rawAction.dueAt === "string" && rawAction.dueAt.trim() ? rawAction.dueAt.trim() : null;
      return { action: { type: "todo_add", text: text.slice(0, 200), dueAt }, problem: null };
    },
  },
  todo_complete: {
    type: "todo_complete",
    risk: "safe",
    requiredAbility: "toDoList",
    describe: (action) => `tick off "${(action as { text: string }).text}"`,
    normalize: (rawAction) => {
      const text = readRequiredText(rawAction, "text");
      return text
        ? { action: { type: "todo_complete", text }, problem: null }
        : { action: null, problem: "todo_complete needs text" };
    },
  },
  todo_remove: {
    type: "todo_remove",
    risk: "safe",
    requiredAbility: "toDoList",
    describe: (action) => `remove "${(action as { text: string }).text}" from your list`,
    normalize: (rawAction) => {
      const text = readRequiredText(rawAction, "text");
      return text
        ? { action: { type: "todo_remove", text }, problem: null }
        : { action: null, problem: "todo_remove needs text" };
    },
  },
  schedule_add: {
    type: "schedule_add",
    risk: "safe",
    requiredAbility: "scheduling",
    describe: (action) => {
      const scheduleAction = action as { name: string; startAt: string };
      return `schedule "${scheduleAction.name}" for ${scheduleAction.startAt}`;
    },
    normalize: (rawAction) => {
      const name = readRequiredText(rawAction, "name");
      const startAt = readRequiredText(rawAction, "startAt");
      if (!name || !startAt) {
        return { action: null, problem: "schedule_add needs a name and a startAt local time" };
      }
      const prompt = readRequiredText(rawAction, "prompt") ?? name;
      const repeat = rawAction.repeat === "daily" || rawAction.repeat === "weekdays" || rawAction.repeat === "weekends"
        ? rawAction.repeat
        : "none";
      return { action: { type: "schedule_add", name: name.slice(0, 120), prompt: prompt.slice(0, 500), startAt, repeat }, problem: null };
    },
  },
  routine_add: {
    type: "routine_add",
    risk: "safe",
    requiredAbility: "scheduling",
    describe: (action) => {
      const routineAction = action as { name: string; timeOfDay: string };
      return `create the routine "${routineAction.name}" at ${routineAction.timeOfDay}`;
    },
    normalize: (rawAction) => {
      const name = readRequiredText(rawAction, "name");
      const timeOfDay = readRequiredText(rawAction, "timeOfDay");
      if (!name || !timeOfDay || !/^\d{1,2}:\d{2}$/u.test(timeOfDay)) {
        return { action: null, problem: "routine_add needs a name and a timeOfDay like 09:00" };
      }
      const innerActions = parseClickaaActions(rawAction.actions).actions;
      if (!innerActions.length) {
        return { action: null, problem: "routine_add needs the steps to run" };
      }
      const repeat = rawAction.repeat === "weekdays" || rawAction.repeat === "weekends"
        ? rawAction.repeat
        : "daily";
      return {
        action: { type: "routine_add", name: name.slice(0, 120), timeOfDay, repeat, actions: innerActions },
        problem: null,
      };
    },
  },
  remember: {
    type: "remember",
    risk: "safe",
    requiredAbility: "memory",
    describe: (action) => `remember: ${(action as { fact: string }).fact}`,
    normalize: (rawAction) => {
      const fact = readRequiredText(rawAction, "fact");
      return fact
        ? { action: { type: "remember", fact: fact.slice(0, 500) }, problem: null }
        : { action: null, problem: "remember needs a fact" };
    },
  },
  forget: {
    type: "forget",
    risk: "safe",
    requiredAbility: "memory",
    describe: (action) => `forget ${(action as { query: string }).query}`,
    normalize: (rawAction) => {
      const query = readRequiredText(rawAction, "query");
      return query
        ? { action: { type: "forget", query }, problem: null }
        : { action: null, problem: "forget needs a query" };
    },
  },
  wallpaper: {
    type: "wallpaper",
    risk: "confirm",
    requiredAbility: "systemControl",
    describe: (action) => `change the wallpaper (${(action as { operation: string }).operation})`,
    normalize: (rawAction) => {
      const validOperations = ["set", "solid", "refresh"] as const;
      const operation = typeof rawAction.operation === "string"
        && (validOperations as readonly string[]).includes(rawAction.operation)
        ? rawAction.operation as (typeof validOperations)[number]
        : "solid";
      const path = typeof rawAction.path === "string" && rawAction.path.trim() ? rawAction.path.trim() : null;
      const rawColor = typeof rawAction.color === "string" ? rawAction.color.trim() : "";
      const color = /^#[0-9a-f]{6}$/iu.test(rawColor) ? rawColor : null;
      if (operation === "set" && !path) {
        return { action: null, problem: "wallpaper set needs a file path" };
      }
      if (operation === "solid" && !color) {
        return { action: null, problem: "wallpaper solid needs a color like #101820" };
      }
      return { action: { type: "wallpaper", operation, path, color }, problem: null };
    },
  },
  timer_start: {
    type: "timer_start",
    risk: "safe",
    requiredAbility: "scheduling",
    describe: (action) => {
      const timerAction = action as { durationMinutes: number; label: string };
      return `start a ${timerAction.durationMinutes} minute ${timerAction.label} timer`;
    },
    normalize: (rawAction) => {
      const rawDuration = rawAction.durationMinutes;
      const durationMinutes = typeof rawDuration === "number" && Number.isFinite(rawDuration)
        ? Math.round(rawDuration)
        : Number.parseInt(String(rawDuration ?? ""), 10);
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
        return { action: null, problem: "timer_start needs a positive durationMinutes" };
      }

      const label = readOptionalText(rawAction, "label") ?? "timer";
      return {
        action: {
          type: "timer_start",
          durationMinutes: Math.min(durationMinutes, 24 * 60),
          label,
        },
        problem: null,
      };
    },
  },
  timer_cancel: {
    type: "timer_cancel",
    risk: "safe",
    requiredAbility: "scheduling",
    describe: () => "stop the running timer",
    normalize: (rawAction) => ({
      action: { type: "timer_cancel", query: readOptionalText(rawAction, "query") },
      problem: null,
    }),
  },
  snippet_save: {
    type: "snippet_save",
    risk: "safe",
    requiredAbility: "automation",
    describe: (action) => `save the ${(action as { name: string }).name} snippet`,
    normalize: (rawAction) => {
      const name = readRequiredText(rawAction, "name");
      const text = readRequiredText(rawAction, "text");
      if (!name || !text) {
        return { action: null, problem: "snippet_save needs a name and the text to save" };
      }
      return { action: { type: "snippet_save", name, text }, problem: null };
    },
  },
  snippet_insert: {
    type: "snippet_insert",
    risk: "confirm",
    requiredAbility: "automation",
    describe: (action) => `type the ${(action as { name: string }).name} snippet`,
    normalize: (rawAction) => {
      const name = readRequiredText(rawAction, "name");
      return name
        ? { action: { type: "snippet_insert", name }, problem: null }
        : { action: null, problem: "snippet_insert needs a name" };
    },
  },
  clipboard_transform: {
    type: "clipboard_transform",
    risk: "confirm",
    requiredAbility: "clipboardHistory",
    describe: (action) => {
      const transformAction = action as { operation: string; targetLanguage: string | null };
      return transformAction.operation === "translate"
        ? `translate what is on the clipboard into ${transformAction.targetLanguage ?? "english"}`
        : `${transformAction.operation.replace(/_/gu, " ")} what is on the clipboard`;
    },
    normalize: (rawAction) => {
      const rawOperation = readRequiredText(rawAction, "operation") ?? "";
      const operation = clipboardTransformOperations.find(
        (candidateOperation) => candidateOperation === rawOperation,
      );
      if (!operation) {
        return {
          action: null,
          problem: `clipboard_transform supports ${clipboardTransformOperations.join(", ")}`,
        };
      }
      return {
        action: {
          type: "clipboard_transform",
          operation,
          targetLanguage: readOptionalText(rawAction, "targetLanguage")
            ?? readOptionalText(rawAction, "language"),
        },
        problem: null,
      };
    },
  },
  open_panel: {
    type: "open_panel",
    risk: "safe",
    requiredAbility: "automation",
    describe: (action) => `open the Clickaa panel (${(action as { page: string }).page})`,
    normalize: (rawAction) => {
      const allowedPages = ["home", "soul", "plans", "memory", "setup"];
      const page = typeof rawAction.page === "string" && allowedPages.includes(rawAction.page)
        ? rawAction.page
        : "home";
      return { action: { type: "open_panel", page }, problem: null };
    },
  },
};

/** Action types that change something on the user's PC need a confirmation. */
export function getActionRisk(actionType: ClickaaActionType): ActionRisk {
  return actionDefinitions[actionType].risk;
}export function getActionRequiredAbility(actionType: ClickaaActionType): AbilityId {
  return actionDefinitions[actionType].requiredAbility;
}

/** Human phrasing for the confirmation card and the activity feed. */
export function describeAction(action: ClickaaAction): string {
  return actionDefinitions[action.type].describe(action);
}

export function describeActions(actions: ClickaaAction[]): string {
  return actions.map(describeAction).join(", then ");
}

/** Fixes the small JSON mistakes models still make despite the instructions. */
export function repairSerializedActions(serializedActions: string): string {
  return serializedActions
    .replace(/```(?:json)?/giu, "")
    .replace(/^\s*<actions>/iu, "")
    .replace(/<\/actions>\s*$/iu, "")
    .replace(/,\s*([\]}])/gu, "$1")
    .trim();
}

/** Finds the trailing action block without trusting where the model put it. */
export function splitSpokenTextFromActionBlock(modelResponseText: string): {
  spokenText: string;
  serializedActions: string | null;
} {
  const openingTagIndex = modelResponseText.toLowerCase().lastIndexOf(actionBlockOpeningTag);
  const closingTagIndex = modelResponseText.toLowerCase().lastIndexOf(actionBlockClosingTag);

  if (openingTagIndex === -1 || closingTagIndex === -1 || closingTagIndex < openingTagIndex) {
    return { spokenText: modelResponseText.trim(), serializedActions: null };
  }

  return {
    spokenText: modelResponseText.slice(0, openingTagIndex).trim(),
    serializedActions: modelResponseText
      .slice(openingTagIndex + actionBlockOpeningTag.length, closingTagIndex)
      .trim(),
  };
}

/** Parses an `<actions>` payload (or a raw array) into validated actions. */
export function parseClickaaActions(rawPayload: unknown): { actions: ClickaaAction[]; problems: string[] } {
  const actions: ClickaaAction[] = [];
  const problems: string[] = [];

  if (rawPayload === null || rawPayload === undefined) {
    return { actions, problems };
  }

  let parsedPayload: unknown;
  if (typeof rawPayload === "string") {
    const trimmedPayload = repairSerializedActions(rawPayload);
    if (!trimmedPayload) {
      return { actions, problems };
    }
    try {
      parsedPayload = JSON.parse(trimmedPayload) as unknown;
    } catch {
      return { actions, problems: ["the action block was not valid JSON"] };
    }
  } else {
    parsedPayload = rawPayload;
  }

  // A single action object is a common model shortcut; treat it as a one-item list.
  const rawActions = Array.isArray(parsedPayload) ? parsedPayload : [parsedPayload];
  for (const rawAction of rawActions) {
    if (!rawAction || typeof rawAction !== "object") {
      problems.push("an action was not an object");
      continue;
    }

    const actionRecord = rawAction as Record<string, unknown>;
    const actionType = typeof actionRecord.type === "string" ? actionRecord.type : "";
    const actionDefinition = actionDefinitions[actionType as ClickaaActionType];
    if (!actionDefinition) {
      problems.push(`unknown action type "${actionType.slice(0, 40)}"`);
      continue;
    }

    const normalizedResult = actionDefinition.normalize(actionRecord);
    if (!normalizedResult.action) {
      problems.push(normalizedResult.problem ?? `${actionType} was invalid`);
      continue;
    }

    actions.push(normalizedResult.action);
  }

  return { actions, problems };
}

export function parseModelResponse(modelResponseText: string): ParsedModelResponse {
  const { spokenText, serializedActions } = splitSpokenTextFromActionBlock(modelResponseText);
  if (serializedActions === null) {
    return { spokenText, actions: [], problems: [] };
  }

  const { actions, problems } = parseClickaaActions(serializedActions);
  return { spokenText, actions, problems };
}

/**
 * True when the action needs a click before it may run.
 *
 * Reminders, to-dos, memory and other bookkeeping never interrupt. Anything
 * that touches the desktop asks once, unless the user turned confirmations off
 * for that action type or for everything.
 */
export function actionNeedsConfirmation(
  action: ClickaaAction,
  confirmationMode: ConfirmationMode,
  autoApprovedActionTypes: ClickaaActionType[],
): boolean {
  if (confirmationMode === "never") {
    return false;
  }
  if (confirmationMode === "all") {
    return true;
  }
  if (autoApprovedActionTypes.includes(action.type)) {
    return false;
  }
  return getActionRisk(action.type) === "confirm";
}

/** Drops actions whose ability the user switched off, explaining each one. */
export function filterActionsByAbilities(
  actions: ClickaaAction[],
  abilities: AbilitySettings,
): { allowedActions: ClickaaAction[]; blockedActions: Array<{ action: ClickaaAction; ability: AbilityId }> } {
  const allowedActions: ClickaaAction[] = [];
  const blockedActions: Array<{ action: ClickaaAction; ability: AbilityId }> = [];

  for (const action of actions) {
    const requiredAbility = getActionRequiredAbility(action.type);
    if (abilities[requiredAbility]) {
      allowedActions.push(action);
    } else {
      blockedActions.push({ action, ability: requiredAbility });
    }
  }

  return { allowedActions, blockedActions };
}

/**
 * The part of the system prompt that teaches the model the action protocol.
 * Only enabled abilities are described, so the model never promises something
 * the user switched off.
 */
export function buildActionProtocolInstructions(abilities: AbilitySettings): string {
  const sections: string[] = [];

  if (abilities.automation) {
    sections.push(`- open_app: {"type":"open_app","name":"Spotify"} — launch an installed app by name.
- open_url: {"type":"open_url","url":"https://example.com"} — open a web page.
- type_text: {"type":"type_text","text":"hello"} — type into whatever window has focus.
- press_keys: {"type":"press_keys","keys":"ctrl+s"} — press a keyboard shortcut.
- clipboard_write: {"type":"clipboard_write","text":"..."} — put text on the clipboard.
- notify: {"type":"notify","title":"...","body":"..."} — show a Windows notification.
- scroll: {"type":"scroll","direction":"down","amount":3} — scroll the focused window.
- snippet_save: {"type":"snippet_save","name":"my address","text":"..."} — save a phrase the user will reuse. use it whenever someone says "save this as ..." or "remember this text as ...".
- snippet_insert: {"type":"snippet_insert","name":"my address"} — type a saved phrase into the focused window.
- open_panel: {"type":"open_panel","page":"plans"} — open this app's own panel (pages: home, soul, plans, memory, setup).`);
  }

  if (abilities.webSearch) {
    sections.push(`- search_web: {"type":"search_web","query":"gift wraps","target":"amazon"} — search the web. targets: default, google, youtube, amazon, bing, wikipedia. use this instead of open_url whenever the user says "search".`);
  }

  if (abilities.systemControl) {
    sections.push(`- volume: {"type":"volume","operation":"set","level":30} — operations: up, down, mute, unmute, set.
- media: {"type":"media","operation":"play_pause"} — operations: play_pause, next, previous, stop.
- window: {"type":"window","operation":"minimize","app":"chrome"} — operations: minimize, maximize, restore, close, focus.
- wallpaper: {"type":"wallpaper","operation":"solid","color":"#101820"} — operations: set (with a file path), solid (with a color), refresh.`);
  }

  if (abilities.toDoList) {
    sections.push(`- todo_add: {"type":"todo_add","text":"Call Mom","dueAt":"2026-10-13T18:00:00"} — add a to-do. dueAt is optional and uses local time.
- todo_complete: {"type":"todo_complete","text":"Call Mom"} — tick an item off.
- todo_remove: {"type":"todo_remove","text":"Call Mom"} — delete an item.`);
  }

  if (abilities.scheduling) {
    sections.push(`- schedule_add: {"type":"schedule_add","name":"Gift wraps","prompt":"search amazon for gift wraps","startAt":"2026-11-10T11:00:00","repeat":"none"} — run a spoken task later on its own. repeat: none, daily, weekdays, weekends.
- routine_add: {"type":"routine_add","name":"Morning","timeOfDay":"09:00","repeat":"daily","actions":[{"type":"open_app","name":"Unity"}]} — a repeating list of steps.
- timer_start: {"type":"timer_start","durationMinutes":12,"label":"pasta"} — a countdown the island shows and that ends with a notification. use for "set a timer".
- timer_cancel: {"type":"timer_cancel","query":"pasta"} — stop a running timer; query null stops every one.`);
  }

  if (abilities.clipboardHistory) {
    sections.push(`- clipboard_transform: {"type":"clipboard_transform","operation":"summarize","targetLanguage":null} — rewrite what is on the clipboard using the user's brain. operations: summarize, fix_grammar, shorten, translate. for translate, set targetLanguage. use it for "fix what i copied", "summarize this", "translate my clipboard".`);
  }

  if (abilities.memory) {
    sections.push(`- remember: {"type":"remember","fact":"my brother's birthday is 4 March"} — keep a fact for later.
- forget: {"type":"forget","query":"birthday"} — drop matching facts.`);
  }

  if (!sections.length) {
    return "";
  }

  return `actions:
you can act on the user's pc, not just talk. when (and only when) the user asks you to do something, finish your answer with exactly one <actions> block containing a json array. put nothing after it. never explain the block, never use it for small talk, and never put an action you do not need.

${sections.join("\n")}

rules for actions:
- one block per reply, spoken text first, then the block.
- use local wall-clock time in iso form for every date you write, for example ${new Date().getFullYear()}-03-04T09:00:00.
- if the user tells you to do something you have no action for, say so in one sentence and stop.
- never invent file paths, urls the user did not give you, or app names you are not confident about.`;
}
