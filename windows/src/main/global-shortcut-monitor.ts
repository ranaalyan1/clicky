import { UiohookKey, uIOhook } from "uiohook-napi";
import { ModifierPushToTalkStateMachine } from "./shortcut-state";

export type PushToTalkTransition = "pressed" | "released";

export class GlobalPushToTalkMonitor {
  private isStarted = false;
  private readonly shortcutStateMachine = new ModifierPushToTalkStateMachine({
    leftControl: UiohookKey.Ctrl,
    rightControl: UiohookKey.CtrlRight,
    leftAlt: UiohookKey.Alt,
    rightAlt: UiohookKey.AltRight,
  });

  constructor(private readonly onTransition: (transition: PushToTalkTransition) => void) {}

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
      console.error("Clickaa could not start the global Ctrl + Alt monitor:", error);
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

    if (this.shortcutStateMachine.reset() === "released") {
      this.onTransition("released");
    }
  }

  private readonly handleKeyDown = (keyboardEvent: { keycode: number }): void => {
    const transition = this.shortcutStateMachine.handleKeyDown(keyboardEvent.keycode);
    if (transition) {
      this.onTransition(transition);
    }
  };

  private readonly handleKeyUp = (keyboardEvent: { keycode: number }): void => {
    const transition = this.shortcutStateMachine.handleKeyUp(keyboardEvent.keycode);
    if (transition) {
      this.onTransition(transition);
    }
  };
}
