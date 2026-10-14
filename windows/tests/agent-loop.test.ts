import assert from "node:assert/strict";
import test from "node:test";
import { UstaadAction, NowPlayingInfo } from "../src/shared/contracts";
import {
  actionChangesScreen,
  AgentLoopBudget,
  buildAgentLookPrompt,
  AgentLoopDependencies,
  AgentLoopLookResult,
  AgentLoopProgressEvent,
  UstaadAgentLoop,
  isPlaybackGoal,
  parseAgentLookResponse,
} from "../src/main/agent-loop";

const testBudget: AgentLoopBudget = {
  maximumSteps: 4,
  maximumReplansPerStep: 1,
  maximumMilliseconds: 30_000,
  millisecondsBetweenSteps: 0,
};

interface FakeLoopHarness {
  dependencies: AgentLoopDependencies;
  /** Every action list the loop actually ran, in order. */
  executedSteps: UstaadAction[][];
  progressEvents: AgentLoopProgressEvent[];
  lookCalls: number;
}

function createFakeDependencies(options: {
  lookResults: AgentLoopLookResult[];
  nowPlaying?: NowPlayingInfo | null;
  runActionsError?: string;
  nowPlayingSequence?: Array<NowPlayingInfo | null>;
  stopAfterSteps?: number;
}): FakeLoopHarness {
  const harness: FakeLoopHarness = {
    executedSteps: [],
    progressEvents: [],
    lookCalls: 0,
    dependencies: {
      runActions: async (actions) => {
        if (options.runActionsError) {
          throw new Error(options.runActionsError);
        }
        harness.executedSteps.push(actions);
        return `ran ${actions.map((action) => action.type).join(", ")}`;
      },
      look: async () => {
        const lookResult = options.lookResults[harness.lookCalls] ?? { kind: "give_up", note: "no more looks" };
        harness.lookCalls += 1;
        return lookResult;
      },
      readNowPlaying: async () => {
        if (options.nowPlayingSequence) {
          const sequenceIndex = Math.min(harness.executedSteps.length - 1, options.nowPlayingSequence.length - 1);
          return options.nowPlayingSequence[Math.max(0, sequenceIndex)] ?? null;
        }
        return options.nowPlaying ?? null;
      },
      shouldStop: () => (
        options.stopAfterSteps !== undefined && harness.executedSteps.length >= options.stopAfterSteps
      ),
      wait: async () => undefined,
      onProgress: (progressEvent) => {
        harness.progressEvents.push(progressEvent);
      },
    },
  };
  return harness;
}

const openYouTube: UstaadAction[] = [{ type: "open_url", url: "https://youtube.com" }];
const clickFirstVideo: UstaadAction[] = [
  { type: "click_at", x: 420, y: 310, label: "the first video", screenNumber: null },
];

test("a task that works first time stops after one look", async () => {
  const harness = createFakeDependencies({
    lookResults: [{ kind: "done", note: "the video is playing" }],
  });
  const loop = new UstaadAgentLoop(harness.dependencies, testBudget);

  const result = await loop.run("go to youtube and play a video", openYouTube);

  assert.equal(result.outcome, "completed");
  assert.equal(result.note, "the video is playing");
  assert.equal(result.stepsTaken, 1);
  assert.equal(harness.executedSteps.length, 1);
  assert.equal(harness.lookCalls, 1);
});

test("a step that was not enough is corrected with the next actions", async () => {
  const harness = createFakeDependencies({
    lookResults: [
      { kind: "continue", actions: clickFirstVideo, note: "youtube is open, nothing is playing yet" },
      { kind: "done", note: "the video is playing" },
    ],
  });
  const loop = new UstaadAgentLoop(harness.dependencies, testBudget);

  const result = await loop.run("go to youtube and play anything", openYouTube);

  assert.equal(result.outcome, "completed");
  assert.equal(result.stepsTaken, 2);
  assert.deepEqual(harness.executedSteps, [openYouTube, clickFirstVideo]);
});

test("a playback goal is settled by windows itself, without spending a look", async () => {
  const harness = createFakeDependencies({
    lookResults: [{ kind: "done", note: "should never be consulted" }],
    nowPlaying: {
      isSupported: true,
      title: "Never Gonna Give You Up",
      artist: "Rick Astley",
      appName: "chrome",
      isPlaying: true,
    },
  });
  const loop = new UstaadAgentLoop(harness.dependencies, testBudget);

  const result = await loop.run("play something on youtube", openYouTube);

  assert.equal(result.outcome, "completed");
  assert.equal(result.note, "Never Gonna Give You Up by Rick Astley is playing");
  assert.equal(harness.lookCalls, 0, "a playing track must not cost a model call");
});

test("the loop keeps clicking while nothing is playing, then stops on the track", async () => {
  const silentNowPlaying: NowPlayingInfo = {
    isSupported: true,
    title: "",
    artist: "",
    appName: "chrome",
    isPlaying: false,
  };
  const harness = createFakeDependencies({
    lookResults: [
      { kind: "continue", actions: clickFirstVideo, note: "nothing is playing yet" },
      { kind: "continue", actions: clickFirstVideo, note: "still nothing" },
    ],
    nowPlayingSequence: [silentNowPlaying, silentNowPlaying, {
      isSupported: true,
      title: "A song",
      artist: "Someone",
      appName: "chrome",
      isPlaying: true,
    }],
  });
  const loop = new UstaadAgentLoop(harness.dependencies, testBudget);

  const result = await loop.run("go and play a song", openYouTube);

  assert.equal(result.outcome, "completed");
  assert.equal(result.note, "A song by Someone is playing");
  assert.equal(harness.executedSteps.length, 3);
});

test("the step budget ends the task instead of letting it run forever", async () => {
  // Each look asks for a genuinely different next step, so the stuck-detector
  // never fires and only the step budget can stop it.
  const harness = createFakeDependencies({
    lookResults: [
      { kind: "continue", actions: [{ type: "scroll", direction: "down", amount: 1 }], note: "not yet" },
      { kind: "continue", actions: [{ type: "scroll", direction: "down", amount: 2 }], note: "not yet" },
      { kind: "continue", actions: [{ type: "scroll", direction: "down", amount: 3 }], note: "not yet" },
    ],
  });
  const loop = new UstaadAgentLoop(harness.dependencies, { ...testBudget, maximumSteps: 3 });

  const result = await loop.run("find that email", openYouTube);

  assert.equal(result.outcome, "ran_out_of_steps");
  assert.equal(result.stepsTaken, 3);
  assert.equal(harness.executedSteps.length, 3);
});

test("repeating the same step is capped, then handed back to the user", async () => {
  const harness = createFakeDependencies({
    lookResults: [
      { kind: "continue", actions: clickFirstVideo, note: "click it again" },
      { kind: "continue", actions: clickFirstVideo, note: "click it again" },
      { kind: "continue", actions: clickFirstVideo, note: "click it again" },
    ],
  });
  const loop = new UstaadAgentLoop(harness.dependencies, { ...testBudget, maximumReplansPerStep: 1 });

  // The initial step is an open, the look asks for a click, and then the model
  // asks for the identical click over and over.
  const result = await loop.run("open the settings page", openYouTube);

  assert.equal(result.outcome, "gave_up");
  assert.equal(result.stepsTaken, 3);
  assert.equal(result.note, "click it again");
});

test("a give-up from the model stops the task with its explanation", async () => {
  const harness = createFakeDependencies({
    lookResults: [{ kind: "give_up", note: "that page needs a login I do not have" }],
  });
  const loop = new UstaadAgentLoop(harness.dependencies, testBudget);

  const result = await loop.run("check my orders", openYouTube);

  assert.equal(result.outcome, "gave_up");
  assert.equal(result.note, "that page needs a login I do not have");
  assert.equal(harness.executedSteps.length, 1);
});

test("blind mode refuses to keep clicking when the screen cannot be seen", async () => {
  const harness = createFakeDependencies({
    lookResults: [{ kind: "unavailable", note: "screen vision is switched off" }],
  });
  const loop = new UstaadAgentLoop(harness.dependencies, testBudget);

  const result = await loop.run("book a table", openYouTube);

  assert.equal(result.outcome, "gave_up");
  assert.equal(result.note, "screen vision is switched off");
  assert.equal(harness.executedSteps.length, 1);
});

test("a step that cannot change the screen finishes without a look", async () => {
  const harness = createFakeDependencies({
    lookResults: [{ kind: "done", note: "should never be consulted" }],
  });
  const loop = new UstaadAgentLoop(harness.dependencies, testBudget);

  const result = await loop.run(
    "set a timer for 10 minutes",
    [{ type: "timer_start", durationMinutes: 10, label: "tea" }],
  );

  assert.equal(result.outcome, "completed");
  assert.equal(result.note, "ran timer_start");
  assert.equal(harness.lookCalls, 0);
});

test("a failing step ends the task with the reason instead of retrying forever", async () => {
  const harness = createFakeDependencies({
    lookResults: [],
    runActionsError: "the Windows helper is not running",
  });
  const loop = new UstaadAgentLoop(harness.dependencies, testBudget);

  const result = await loop.run("open spotify", [{ type: "open_app", name: "Spotify" }]);

  assert.equal(result.outcome, "gave_up");
  assert.equal(result.note.includes("the Windows helper is not running"), true);
  assert.equal(harness.executedSteps.length, 0);
});

test("progress is reported for every step so the user can watch it work", async () => {
  const harness = createFakeDependencies({
    lookResults: [{ kind: "done", note: "done" }],
  });
  const loop = new UstaadAgentLoop(harness.dependencies, testBudget);

  await loop.run("go to youtube", openYouTube);

  assert.deepEqual(
    harness.progressEvents.map((progressEvent) => progressEvent.kind),
    ["step_started", "step_finished", "looking", "done"],
  );
  assert.equal(harness.progressEvents[0]?.stepNumber, 1);
});

test("playback goals and screen-changing actions are recognised conservatively", () => {
  assert.equal(isPlaybackGoal("go to youtube and play anything"), true);
  assert.equal(isPlaybackGoal("play the next song"), true);
  assert.equal(isPlaybackGoal("what is my wifi password"), false);

  assert.equal(actionChangesScreen({ type: "click_at", x: 1, y: 2, label: "x", screenNumber: null }), true);
  assert.equal(actionChangesScreen({ type: "open_url", url: "https://example.com" }), true);
  assert.equal(actionChangesScreen({ type: "timer_start", durationMinutes: 5, label: "tea" }), false);
  assert.equal(actionChangesScreen({ type: "remember", fact: "my brother's birthday is 4 march" }), false);
  assert.equal(actionChangesScreen({ type: "notify", title: "hi", body: "there" }), false);
});

test("a second task on the same loop does not inherit the first one's strikes", async () => {
  // With no re-plans allowed, run one gives up the moment the model repeats
  // itself. Run two must start clean rather than inheriting that strike.
  const harness = createFakeDependencies({
    lookResults: [
      { kind: "continue", actions: clickFirstVideo, note: "click it again" },
      { kind: "continue", actions: clickFirstVideo, note: "click it again" },
      { kind: "continue", actions: clickFirstVideo, note: "click it again" },
      { kind: "done", note: "got it" },
    ],
  });
  const loop = new UstaadAgentLoop(harness.dependencies, { ...testBudget, maximumReplansPerStep: 0 });

  const firstResult = await loop.run("find that video", openYouTube);
  assert.equal(firstResult.outcome, "gave_up");
  assert.equal(firstResult.stepsTaken, 2);

  const secondResult = await loop.run("find that video", openYouTube);
  assert.equal(secondResult.outcome, "completed");
  assert.equal(secondResult.stepsTaken, 2);
});

test("cancelling stops the task before the next step starts", async () => {
  const harness = createFakeDependencies({
    lookResults: [
      { kind: "continue", actions: clickFirstVideo, note: "keep going" },
      { kind: "continue", actions: clickFirstVideo, note: "keep going" },
    ],
    stopAfterSteps: 1,
  });
  const loop = new UstaadAgentLoop(harness.dependencies, testBudget);

  const result = await loop.run("book a table", openYouTube);

  assert.equal(result.outcome, "stopped");
  assert.equal(result.stepsTaken, 1);
  assert.equal(harness.executedSteps.length, 1);
});

test("a look reads the model's three verdicts, and refuses to guess at anything else", () => {
  assert.deepEqual(parseAgentLookResponse("DONE: the video is playing in the tab"), {
    kind: "done",
    note: "the video is playing in the tab",
  });
  assert.deepEqual(parseAgentLookResponse("done:  the tab now shows the video"), {
    kind: "done",
    note: "the tab now shows the video",
  });
  assert.deepEqual(parseAgentLookResponse("GIVE_UP: the page is asking for a password"), {
    kind: "give_up",
    note: "the page is asking for a password",
  });

  const nextResult = parseAgentLookResponse(
    'NEXT: <actions>[{"type":"click_at","x":420,"y":310,"label":"the first video"}]</actions>',
  );
  assert.equal(nextResult.kind, "continue");
  assert.deepEqual(
    nextResult.kind === "continue" ? nextResult.actions : [],
    [{ type: "click_at", x: 420, y: 310, label: "the first video", screenNumber: null }],
  );

  // A NEXT with nothing runnable in it is a give-up with the parser's reason.
  const brokenNext = parseAgentLookResponse("NEXT: <actions>[{\"type\":\"click_at\"}]</actions>");
  assert.equal(brokenNext.kind, "give_up");
  assert.equal(brokenNext.kind === "give_up" ? brokenNext.note.includes("x and y") : false, true);

  // Free-form musing must not be mistaken for a verdict.
  assert.equal(parseAgentLookResponse("I think it might have worked").kind, "give_up");
  assert.equal(parseAgentLookResponse("").kind, "give_up");
});

test("the look prompt carries the goal, the last step, and the honesty rules", () => {
  const prompt = buildAgentLookPrompt({
    goal: "play a video on youtube",
    stepNumber: 2,
    previousSummary: "clicked the first video",
    hasScreenshots: true,
  });

  assert.equal(prompt.includes("play a video on youtube"), true);
  assert.equal(prompt.includes("clicked the first video"), true);
  assert.equal(prompt.includes("step 2"), true);
  assert.equal(prompt.includes("DONE:"), true);
  assert.equal(prompt.includes("NEXT:"), true);
  assert.equal(prompt.includes("GIVE_UP:"), true);
  assert.equal(prompt.includes("screenshots of every display are attached"), true);

  // Without screenshots the model is told plainly not to guess.
  const blindPrompt = buildAgentLookPrompt({
    goal: "play a video",
    stepNumber: 1,
    previousSummary: "opened youtube",
    hasScreenshots: false,
  });
  assert.equal(blindPrompt.includes("do not guess about what it shows"), true);
});
