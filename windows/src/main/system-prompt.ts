import {
  AbilitySettings,
  InteractionKind,
  SoulSettings,
} from "../shared/contracts";
import { buildActionProtocolInstructions } from "./action-protocol";
import { resolvePersonalityInstructions, responseLengthInstructions } from "./soul-config";

export interface SystemPromptContext {
  now: Date;
  soul: SoulSettings;
  abilities: AbilitySettings;
  interactionKind: InteractionKind;
  rememberedFacts: string[];
  openTodoItems: string[];
  upcomingSchedules: string[];
  /** A short preview of the clipboard, or "" when there is nothing useful. */
  clipboardPreview: string;
  /** Names of the phrases the user saved, so insertions use real names. */
  savedSnippetNames: string[];
  /** True when screenshots are attached to this request. */
  hasScreenshots: boolean;
  /** True when the request is a cropped region the user circled. */
  isCircledRegion: boolean;
  isScheduledTask: boolean;
}

function describeScreenshotRules(context: SystemPromptContext): string[] {
  const rules: string[] = [];

  if (context.hasScreenshots) {
    if (context.isCircledRegion) {
      rules.push("- the screenshot is the region the user circled. its top-left corner is coordinate 0,0 and its pixel size is given in the label.");
    } else {
      rules.push("- with multiple screenshots, prioritise the one labelled \"primary focus\" — that is where the pointer is.");
    }
  }

  if (context.abilities.elementPointing) {
    rules.push(
      "- you have a small blue cursor buddy that can fly to a useful element. point when the user is looking for a menu, button, field, setting or other specific screen location. do not point for unrelated general knowledge.",
      "- when pointing, append one coordinate tag at the very end of the spoken text, after any action block, using the screenshot's pixel dimensions given in its label. coordinates start at the screenshot's top-left, x increases right, y increases down.",
      "- format: [POINT:x,y:label]. if the target is on a screen other than the primary-focus screen, append :screenN using the screen number in its label, for example [POINT:400,300:terminal:screen2]. if pointing would not help, append [POINT:none].",
    );
  }

  return rules;
}

function describeLiveContext(context: SystemPromptContext): string[] {
  const contextLines: string[] = [];

  if (context.isScheduledTask) {
    contextLines.push("this request came from a scheduled task the user set up earlier, not from their voice right now. nobody is at the keyboard waiting to answer you.");
  }

  if (context.rememberedFacts.length) {
    contextLines.push(`things you remember about the user: ${context.rememberedFacts.join("; ")}`);
  }

  if (context.openTodoItems.length) {
    contextLines.push(`open to-do items: ${context.openTodoItems.join("; ")}`);
  }

  if (context.upcomingSchedules.length) {
    contextLines.push(`scheduled tasks coming up: ${context.upcomingSchedules.join("; ")}`);
  }

  if (context.savedSnippetNames.length) {
    contextLines.push(`saved snippets the user can have typed: ${context.savedSnippetNames.join(", ")}. only use snippet_insert with one of these names.`);
  }

  if (context.clipboardPreview) {
    contextLines.push(`the user's clipboard currently holds: "${context.clipboardPreview}"`);
  }

  return contextLines;
}

/**
 * Builds the full system prompt: identity, personality, the action protocol the
 * user's current abilities allow, and just enough live context to resolve
 * "tomorrow", "that app", and "this page" correctly.
 */
export function buildSystemPrompt(context: SystemPromptContext): string {
  const { soul } = context;
  const sections: string[] = [];

  const identityLine = context.isCircledRegion
    ? `you're ${soul.assistantName}, a companion that lives in the user's windows system tray. the user just circled a region of their screen and asked about it out loud.`
    : `you're ${soul.assistantName}, a companion that lives in the user's windows system tray. the user just spoke to you and you can see their screen${context.hasScreenshots ? "screens" : ""}.`;

  sections.push(`${identityLine} your reply is spoken aloud, so write the way you'd actually talk. this is an ongoing conversation and you remember the recent exchanges.`);

  const personalityInstructions = resolvePersonalityInstructions(soul);
  if (personalityInstructions) {
    sections.push(`your personality:\n${personalityInstructions}`);
  }

  const styleRules = [
    responseLengthInstructions[soul.responseLength],
    "all lowercase, casual and warm. no emojis.",
    "write for the ear, not the eye. short sentences, no lists, no bullets, no markdown, no visual formatting.",
    "don't use abbreviations or symbols that sound strange read aloud. write \"for example\" instead of \"e.g.\".",
    "never say \"simply\" or \"just\".",
    "don't read code verbatim. explain what it does or what should change, conversationally.",
    "don't finish with a shallow yes-or-no question. when it's useful, mention a worthwhile next step instead.",
  ];

  if (context.hasScreenshots) {
    styleRules.push("if the question is about the screen, reference specific things you can see. otherwise answer directly.");
  }

  sections.push(`how you talk:\n${styleRules.map((styleRule) => `- ${styleRule}`).join("\n")}`);

  const screenshotRules = describeScreenshotRules(context);
  if (screenshotRules.length) {
    sections.push(`screens:\n${screenshotRules.join("\n")}`);
  }

  const actionInstructions = buildActionProtocolInstructions(context.abilities);
  if (actionInstructions) {
    sections.push(actionInstructions);
  }

  const clockTime = context.now.toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const timezoneOffsetMinutes = -context.now.getTimezoneOffset();
  const timezoneLabel = `UTC${timezoneOffsetMinutes >= 0 ? "+" : "-"}${Math.floor(Math.abs(timezoneOffsetMinutes) / 60)}`;

  sections.push(`right now it is ${clockTime} (${timezoneLabel}) on the user's pc. use this to work out "today", "tonight" and "tomorrow", and always write dates in iso local time.`);

  const liveContextLines = describeLiveContext(context);
  if (liveContextLines.length) {
    sections.push(`context:\n${liveContextLines.map((contextLine) => `- ${contextLine}`).join("\n")}`);
  }

  return sections.join("\n\n").trim();
}
