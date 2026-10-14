import { UstaadAction, NowPlayingInfo } from "../shared/contracts";
import { parseUstaadActions } from "./action-protocol";

/**
 * How long one task may run before Ustaad stops and reports where it got to.
 * Every number here exists to make "Ustaad went off and did something for two
 * minutes" impossible: the loop is bounded in steps, in re-plans and in time.
 */
export interface AgentLoopBudget {
  maximumSteps: number;
  maximumReplansPerStep: number;
  maximumMilliseconds: number;
  millisecondsBetweenSteps: number;
}

export const defaultAgentLoopBudget: AgentLoopBudget = {
  maximumSteps: 8,
  maximumReplansPerStep: 2,
  maximumMilliseconds: 75_000,
  millisecondsBetweenSteps: 900,
};

/** What the model decided when it looked at the screen again. */
export type AgentLoopLookResult =
  | { kind: "done"; note: string }
  | { kind: "continue"; actions: UstaadAction[]; note: string }
  | { kind: "give_up"; note: string }
  | { kind: "unavailable"; note: string };

export interface AgentLoopProgressEvent {
  kind: "step_started" | "step_finished" | "looking" | "done" | "gave_up" | "stopped";
  stepNumber: number;
  note: string;
  actionSummary: string;
}

export interface AgentLoopDependencies {
  /** Runs one step's actions and answers with a summary for the activity feed. */
  runActions: (actions: UstaadAction[]) => Promise<string>;
  /** Takes a fresh look at the screen and asks the model whether the goal is met. */
  look: (request: {
    goal: string;
    stepNumber: number;
    previousSummary: string;
    previousActions: UstaadAction[];
  }) => Promise<AgentLoopLookResult>;
  /** The now-playing track, used to settle playback goals without a model call. */
  readNowPlaying: () => Promise<NowPlayingInfo | null>;
  /**
   * True once the user has cancelled (Escape, a new request, quitting). Checked
   * between steps so nothing keeps clicking after the user says stop.
   */
  shouldStop: () => boolean;
  wait: (milliseconds: number) => Promise<void>;
  onProgress: (progressEvent: AgentLoopProgressEvent) => void;
}

export interface AgentLoopResult {
  outcome: "completed" | "gave_up" | "ran_out_of_steps" | "ran_out_of_time" | "stopped";
  note: string;
  stepsTaken: number;
}

/**
 * The instruction the model gets when Ustaad looks at the screen mid-task. It
 * is deliberately small: the model already has the goal, the screenshots and
 * its own last step, and it only has to answer one of three things.
 */
export function buildAgentLookPrompt(request: {
  goal: string;
  stepNumber: number;
  previousSummary: string;
  hasScreenshots: boolean;
}): string {
  const lines = [
    `you are partway through a task on the user's pc.`,
    `the goal is: ${request.goal}`,
    `step ${request.stepNumber} did this: ${request.previousSummary}`,
  ];

  if (request.hasScreenshots) {
    lines.push("the screenshots of every display are attached, with the pointer's display first.");
  } else {
    lines.push("you cannot see the screen right now, so do not guess about what it shows.");
  }

  lines.push(
    "",
    "answer with exactly one of these three, and nothing else:",
    "DONE: <one short line saying what you can see that proves the goal is met>",
    "NEXT: <one <actions> block holding just the next step, for example a click_at on the right spot>",
    "GIVE_UP: <one short line saying what stopped you, in plain language the user can act on>",
    "",
    "rules:",
    "- only say DONE when the screen (or the now-playing state) actually shows the goal is met",
    "- when you are not sure, use NEXT to look closer or click the thing that needs clicking",
    "- never repeat a step that clearly did nothing, and never guess a click position",
    "- screenshots are of the user's real machine and may contain private content: only describe what is needed for the goal",
  );

  return lines.join("\n");
}

/**
 * Reads the model's answer to a look. Anything that is not one of the three
 * verdicts is treated as "no idea", which ends the task rather than letting a
 * confused model keep clicking on the user's screen.
 */
export function parseAgentLookResponse(modelResponseText: string): AgentLoopLookResult {
  const trimmedResponse = modelResponseText.trim();
  if (!trimmedResponse) {
    return { kind: "give_up", note: "I did not get an answer about the screen" };
  }

  const doneMatch = /^DONE\s*:?\s*([\s\S]*)$/iu.exec(trimmedResponse);
  if (doneMatch) {
    return {
      kind: "done",
      note: (doneMatch[1] ?? "").replace(/\s+/gu, " ").trim().slice(0, 200) || "done",
    };
  }

  const giveUpMatch = /^GIVE_UP\s*:?\s*([\s\S]*)$/iu.exec(trimmedResponse);
  if (giveUpMatch) {
    return {
      kind: "give_up",
      note: (giveUpMatch[1] ?? "").replace(/\s+/gu, " ").trim().slice(0, 200) || "I could not get that working",
    };
  }

  const nextMatch = /^NEXT\s*:?\s*([\s\S]*)$/iu.exec(trimmedResponse);
  if (nextMatch) {
    const { actions, problems } = parseUstaadActions(nextMatch[1] ?? "");
    if (actions.length) {
      return { kind: "continue", actions, note: "carrying on" };
    }
    return {
      kind: "give_up",
      note: problems[0] ?? "I did not get a usable next step",
    };
  }

  return {
    kind: "give_up",
    note: "I was not sure what to do next, so I stopped rather than guess",
  };
}

/**
 * True when the user's goal is about something playing. Those goals can be
 * settled by asking Windows what is playing, which is cheaper and far more
 * trustworthy than asking a model to squint at a screenshot.
 */
export function isPlaybackGoal(goal: string): boolean {
  return /\b(play|playing|plays|pause|paused|music|song|song|video|movie|track|spotify|youtube)\b/iu.test(goal);
}

/**
 * True when the action list changes what is on screen, and therefore deserves a
 * fresh look before Ustaad decides whether it is finished.
 */
export function actionChangesScreen(action: UstaadAction): boolean {
  switch (action.type) {
    case "open_app":
    case "open_url":
    case "search_web":
    case "press_keys":
    case "click_at":
    case "scroll":
    case "window":
    case "type_text":
    case "screenshot_region":
    case "clipboard_transform":
      return true;
    default:
      return false;
  }
}

/**
 * Runs a task the way a careful person would: do a step, look at what happened,
 * and either stop because it worked or do the next thing because it did not.
 *
 * The loop owns no Electron, no network and no clock of its own, which is what
 * makes every branch of it testable. The controller supplies the screen, the
 * brain and the actions.
 */
export class UstaadAgentLoop {
  constructor(
    private readonly dependencies: AgentLoopDependencies,
    private readonly budget: AgentLoopBudget = defaultAgentLoopBudget,
  ) {}

  async run(goal: string, initialActions: UstaadAction[]): Promise<AgentLoopResult> {
    const startedAtMilliseconds = Date.now();
    let actions = initialActions;
    let stepsTaken = 0;
    // A fresh task starts with a fresh stuck-detector; otherwise the second
    // task on the same loop would inherit the first one's strikes.
    this.replansForCurrentStep = 0;

    while (stepsTaken < this.budget.maximumSteps) {
      if (this.dependencies.shouldStop()) {
        return this.finish("stopped", stepsTaken, "I stopped because you asked me to");
      }
      if (Date.now() - startedAtMilliseconds > this.budget.maximumMilliseconds) {
        return this.finish("ran_out_of_time", stepsTaken, goal);
      }

      stepsTaken += 1;
      this.dependencies.onProgress({
        kind: "step_started",
        stepNumber: stepsTaken,
        note: `working on it, step ${stepsTaken}`,
        actionSummary: "",
      });

      let stepSummary: string;
      try {
        stepSummary = await this.dependencies.runActions(actions);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return this.finish("gave_up", stepsTaken, `that step did not work: ${errorMessage}`);
      }
      this.dependencies.onProgress({
        kind: "step_finished",
        stepNumber: stepsTaken,
        note: stepSummary,
        actionSummary: stepSummary,
      });

      // Playback goals can be settled by Windows itself, before spending a look.
      if (isPlaybackGoal(goal)) {
        const nowPlaying = await this.dependencies.readNowPlaying().catch(() => null);
        if (nowPlaying?.isPlaying) {
          const playingNote = nowPlaying.title
            ? `${nowPlaying.title}${nowPlaying.artist ? ` by ${nowPlaying.artist}` : ""} is playing`
            : "something is playing";
          return this.finish("completed", stepsTaken, playingNote);
        }
      }

      if (!actions.some(actionChangesScreen)) {
        // Nothing in that step could have changed the screen, so looking would
        // only cost a model call to learn nothing.
        return this.finish("completed", stepsTaken, stepSummary || "done");
      }

      await this.dependencies.wait(this.budget.millisecondsBetweenSteps);
      if (this.dependencies.shouldStop()) {
        return this.finish("stopped", stepsTaken, "I stopped because you asked me to");
      }
      this.dependencies.onProgress({
        kind: "looking",
        stepNumber: stepsTaken,
        note: "checking what happened",
        actionSummary: "",
      });

      let lookResult: AgentLoopLookResult;
      try {
        lookResult = await this.dependencies.look({
          goal,
          stepNumber: stepsTaken,
          previousSummary: stepSummary,
          previousActions: actions,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return this.finish("gave_up", stepsTaken, `I could not check the screen: ${errorMessage}`);
      }

      switch (lookResult.kind) {
        case "done":
          return this.finish("completed", stepsTaken, lookResult.note || "done");
        case "give_up":
          return this.finish("gave_up", stepsTaken, lookResult.note || "I could not get that working");
        case "unavailable":
          // Ustaad cannot see the screen, so it must not keep clicking blind.
          return this.finish(
            "gave_up",
            stepsTaken,
            lookResult.note || "I cannot see the screen to check that, so I stopped",
          );
        case "continue": {
          if (!lookResult.actions.length) {
            return this.finish("gave_up", stepsTaken, lookResult.note || "I did not know what to try next");
          }

          // A model that asks for the exact same step twice is stuck; hand the
          // decision back to the user rather than looping on it.
          const repeatsPreviousStep = this.isSameStep(actions, lookResult.actions);
          if (repeatsPreviousStep) {
            this.replansForCurrentStep += 1;
            if (this.replansForCurrentStep > this.budget.maximumReplansPerStep) {
              return this.finish(
                "gave_up",
                stepsTaken,
                lookResult.note || "I kept trying the same thing, so I stopped",
              );
            }
          } else {
            this.replansForCurrentStep = 0;
          }

          actions = lookResult.actions;
          break;
        }
        default:
          return this.finish("gave_up", stepsTaken, "I lost track of that one");
      }
    }

    return this.finish("ran_out_of_steps", stepsTaken, "I reached the end of my step budget");
  }

  private replansForCurrentStep = 0;

  private isSameStep(previousActions: UstaadAction[], nextActions: UstaadAction[]): boolean {
    if (previousActions.length !== nextActions.length) {
      return false;
    }
    return previousActions.every(
      (previousAction, actionIndex) => (
        JSON.stringify(previousAction) === JSON.stringify(nextActions[actionIndex])
      ),
    );
  }

  private finish(
    outcome: AgentLoopResult["outcome"],
    stepsTaken: number,
    note: string,
  ): AgentLoopResult {
    this.dependencies.onProgress({
      kind: outcome === "completed" ? "done" : "gave_up",
      stepNumber: stepsTaken,
      note,
      actionSummary: "",
    });
    return { outcome, note, stepsTaken };
  }
}
