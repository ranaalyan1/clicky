import { DictationShortcutId } from "../shared/contracts";
import {
  buildShortcutDefinitions,
  ModifierKeyCodes,
  ModifierShortcutStateMachine,
  ShortcutId,
  ShortcutTransition,
} from "./shortcut-registry";

/**
 * The native hook is optional at runtime. A broken or missing native binary must
 * not take the whole desktop companion down: the panel's text box and local
 * features are still useful without global shortcuts.
 *
 * Keep this module free of a top-level `uiohook-napi` import. Electron loads the
 * main process before it can show a useful error, and a native-module load error
 * at module evaluation time used to make the app simply disappear.
 */
interface UiohookKeyboardEvent {
  keycode: number;
}

interface UiohookRuntime {
  on(event: "keydown" | "keyup", listener: (event: UiohookKeyboardEvent) => void): UiohookRuntime;
  off(event: "keydown" | "keyup", listener: (event: UiohookKeyboardEvent) => void): UiohookRuntime;
  start(): void;
  stop(): void;
}

interface UiohookModule {
  uIOhook: UiohookRuntime;
}

/** A held circle asks a question; the text box remains available without it. */
export class GlobalShortcutMonitor {
  private isStarted = false;
  private shortcutStateMachine: ModifierShortcutStateMachine;
  private hook: UiohookRuntime | null = null;

  constructor(
    dictationShortcut: DictationShortcutId,
    private readonly onTransition: (transition: ShortcutTransition) => void,
    /** Esc cancels a circling session, exactly like it closes a dialog. */
    private readonly onEscapeKeyPressed: () => void = () => undefined,
  ) {
    this.shortcutStateMachine = this.createStateMachine(dictationShortcut);
  }

  setDictationShortcut(dictationShortcut: DictationShortcutId): void {
    const releasedTransitions = this.shortcutStateMachine.reset();
    this.shortcutStateMachine = this.createStateMachine(dictationShortcut);
    for (const releasedTransition of releasedTransitions) {
      this.onTransition(releasedTransition);
    }
  }

  start(): boolean {
    if (this.isStarted) {
      return true;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const uiohookModule = require("uiohook-napi") as UiohookModule;
      const { uIOhook } = uiohookModule;
      this.hook = uIOhook;
      uIOhook.on("keydown", this.handleKeyDown);
      uIOhook.on("keyup", this.handleKeyUp);
      uIOhook.start();
      this.isStarted = true;
      return true;
    } catch (error) {
      // Undo listener registration if start() failed after on(). This makes a
      // second attempt safe after the user repairs/reinstalls the native hook.
      this.hook?.off("keydown", this.handleKeyDown);
      this.hook?.off("keyup", this.handleKeyUp);
      this.hook = null;
      console.warn(
        "The global shortcut hook is unavailable; use the panel text box or hold-to-talk button instead.",
        error,
      );
      return false;
    }
  }

  stop(): void {
    if (!this.isStarted && !this.hook) {
      return;
    }

    const hook = this.hook;
    this.hook = null;
    this.isStarted = false;
    hook?.off("keydown", this.handleKeyDown);
    hook?.off("keyup", this.handleKeyUp);
    try {
      hook?.stop();
    } catch (error) {
      console.warn("The global shortcut hook did not stop cleanly:", error);
    }

    for (const releasedTransition of this.shortcutStateMachine.reset()) {
      this.onTransition(releasedTransition);
    }
  }

  private readonly keyCodes = {
    escape: 1,
  };

  private createStateMachine(dictationShortcut: DictationShortcutId): ModifierShortcutStateMachine {
    // These codes are supplied by uiohook-napi, but are deliberately kept in
    // shortcut-registry.ts so the state machine remains unit-testable without a
    // native module. The runtime module is only needed for the event stream.
    return new ModifierShortcutStateMachine(
      buildShortcutDefinitions(dictationShortcut),
      {
        leftControl: 29,
        rightControl: 3613,
        leftAlt: 56,
        rightAlt: 3640,
        leftWindows: 3675,
        rightWindows: 3676,
        leftShift: 42,
        rightShift: 54,
      } satisfies ModifierKeyCodes,
    );
  }

  private readonly handleKeyDown = (keyboardEvent: UiohookKeyboardEvent): void => {
    if (keyboardEvent.keycode === this.keyCodes.escape) {
      this.onEscapeKeyPressed();
    }

    for (const transition of this.shortcutStateMachine.handleKeyDown(keyboardEvent.keycode)) {
      this.onTransition(transition);
    }
  };

  private readonly handleKeyUp = (keyboardEvent: UiohookKeyboardEvent): void => {
    for (const transition of this.shortcutStateMachine.handleKeyUp(keyboardEvent.keycode)) {
      this.onTransition(transition);
    }
  };
}

export type { ShortcutId, ShortcutTransition };
