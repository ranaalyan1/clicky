import { UiohookKey, uIOhook } from "uiohook-napi";
import { DictationShortcutId } from "../shared/contracts";
import {
  buildShortcutDefinitions,
  ModifierKeyCodes,
  ModifierShortcutStateMachine,
  ShortcutId,
  ShortcutTransition,
} from "./shortcut-registry";

const physicalModifierKeyCodes: ModifierKeyCodes = {
  leftControl: UiohookKey.Ctrl,
  rightControl: UiohookKey.CtrlRight,
  leftAlt: UiohookKey.Alt,
  rightAlt: UiohookKey.AltRight,
  leftWindows: UiohookKey.Meta,
  rightWindows: UiohookKey.MetaRight,
  leftShift: UiohookKey.Shift,
  rightShift: UiohookKey.ShiftRight,
};

/**
 * System-wide hold-to-act monitor for all three Ustaad shortcuts.
 *
 * `uiohook-napi` is required rather than Electron's `globalShortcut`, because
 * push-to-talk needs real key-up events (something `globalShortcut` does not
 * report) and because the dictation shortcut must not be swallowed: the user's
 * own apps still need their keys.
 */
export class GlobalShortcutMonitor {
  private isStarted = false;
  private shortcutStateMachine: ModifierShortcutStateMachine;

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
      uIOhook.on("keydown", this.handleKeyDown);
      uIOhook.on("keyup", this.handleKeyUp);
      uIOhook.start();
      this.isStarted = true;
      return true;
    } catch (error) {
      console.error("Ustaad could not start the global shortcut monitor:", error);
      return false;
    }
  }

  stop(): void {
    if (!this.isStarted) {
      return;
    }

    uIOhook.off("keydown", this.handleKeyDown);
    uIOhook.off("keyup", this.handleKeyUp);
    uIOhook.stop();
    this.isStarted = false;

    for (const releasedTransition of this.shortcutStateMachine.reset()) {
      this.onTransition(releasedTransition);
    }
  }

  private createStateMachine(dictationShortcut: DictationShortcutId): ModifierShortcutStateMachine {
    return new ModifierShortcutStateMachine(
      buildShortcutDefinitions(dictationShortcut),
      physicalModifierKeyCodes,
    );
  }

  private readonly handleKeyDown = (keyboardEvent: { keycode: number }): void => {
    if (keyboardEvent.keycode === UiohookKey.Escape) {
      this.onEscapeKeyPressed();
    }

    for (const transition of this.shortcutStateMachine.handleKeyDown(keyboardEvent.keycode)) {
      this.onTransition(transition);
    }
  };

  private readonly handleKeyUp = (keyboardEvent: { keycode: number }): void => {
    for (const transition of this.shortcutStateMachine.handleKeyUp(keyboardEvent.keycode)) {
      this.onTransition(transition);
    }
  };
}

export type { ShortcutId, ShortcutTransition };
