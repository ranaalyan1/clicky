export interface ModifierKeyCodes {
  leftControl: number;
  rightControl: number;
  leftAlt: number;
  rightAlt: number;
}

/**
 * Tracks the physical modifier keys instead of trusting event flags. Requiring
 * left Alt prevents Windows AltGr (synthetic left Ctrl + right Alt) from
 * accidentally opening the microphone while someone types international text.
 */
export class ModifierPushToTalkStateMachine {
  private readonly pressedKeyCodes = new Set<number>();
  private shortcutIsPressed = false;

  constructor(private readonly modifierKeyCodes: ModifierKeyCodes) {}

  handleKeyDown(keyCode: number): "pressed" | null {
    this.pressedKeyCodes.add(keyCode);

    const controlIsPressed = this.pressedKeyCodes.has(this.modifierKeyCodes.leftControl)
      || this.pressedKeyCodes.has(this.modifierKeyCodes.rightControl);
    const leftAltIsPressed = this.pressedKeyCodes.has(this.modifierKeyCodes.leftAlt);

    if (controlIsPressed && leftAltIsPressed && !this.shortcutIsPressed) {
      this.shortcutIsPressed = true;
      return "pressed";
    }

    return null;
  }

  handleKeyUp(keyCode: number): "released" | null {
    this.pressedKeyCodes.delete(keyCode);

    const controlIsPressed = this.pressedKeyCodes.has(this.modifierKeyCodes.leftControl)
      || this.pressedKeyCodes.has(this.modifierKeyCodes.rightControl);
    const leftAltIsPressed = this.pressedKeyCodes.has(this.modifierKeyCodes.leftAlt);

    if (this.shortcutIsPressed && (!controlIsPressed || !leftAltIsPressed)) {
      this.shortcutIsPressed = false;
      return "released";
    }

    return null;
  }

  reset(): "released" | null {
    this.pressedKeyCodes.clear();
    if (!this.shortcutIsPressed) {
      return null;
    }

    this.shortcutIsPressed = false;
    return "released";
  }
}
