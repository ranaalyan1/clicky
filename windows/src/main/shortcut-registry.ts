import { DictationShortcutId } from "../shared/contracts";

export const uiohookSpaceKeyCode = 57;
export const uiohookCapsLockKeyCode = 58;

export interface ModifierKeyCodes {
  leftControl: number;
  rightControl: number;
  leftAlt: number;
  rightAlt: number;
  leftWindows: number;
  rightWindows: number;
  leftShift: number;
  rightShift: number;
}

export type ShortcutId = "talk" | "dictation" | "circle";

export interface ShortcutDefinition {
  id: ShortcutId;
  requiresControl: boolean;
  /** Left Alt only, so Windows AltGr (left Ctrl + right Alt) never triggers it. */
  requiresLeftAlt: boolean;
  requiresWindows: boolean;
  requiresShift: boolean;
  /** A non-modifier key the user must hold, or null for modifier-only shortcuts. */
  requiredKeyCode: number | null;
}

export interface ShortcutTransition {
  shortcutId: ShortcutId;
  phase: "pressed" | "released";
}

export const dictationShortcutLabels: Record<DictationShortcutId, string> = {
  "ctrl+windows": "Ctrl + Windows",
  "ctrl+shift+space": "Ctrl + Shift + Space",
  "capslock": "Caps Lock",
};

/** Builds the three hold-to-act shortcuts Clickaa listens for. */
export function buildShortcutDefinitions(dictationShortcut: DictationShortcutId): ShortcutDefinition[] {
  const dictionaryDefinitions: ShortcutDefinition = dictationShortcut === "capslock"
    ? {
      id: "dictation",
      requiresControl: false,
      requiresLeftAlt: false,
      requiresWindows: false,
      requiresShift: false,
      requiredKeyCode: uiohookCapsLockKeyCode,
    }
    : dictationShortcut === "ctrl+shift+space"
      ? {
        id: "dictation",
        requiresControl: true,
        requiresLeftAlt: false,
        requiresWindows: false,
        requiresShift: true,
        requiredKeyCode: uiohookSpaceKeyCode,
      }
      : {
        id: "dictation",
        requiresControl: true,
        requiresLeftAlt: false,
        requiresWindows: true,
        requiresShift: false,
        requiredKeyCode: null,
      };

  return [
    {
      id: "talk",
      requiresControl: true,
      requiresLeftAlt: true,
      requiresWindows: false,
      requiresShift: false,
      requiredKeyCode: null,
    },
    dictionaryDefinitions,
    {
      id: "circle",
      requiresControl: true,
      requiresLeftAlt: false,
      requiresWindows: false,
      requiresShift: true,
      requiredKeyCode: null,
    },
  ];
}

/**
 * Tracks physical key state for every Clickaa shortcut at once.
 *
 * Physical key codes (rather than event flags) are required for true
 * push-to-talk, and they keep AltGr from firing the talk shortcut while someone
 * types accented characters.
 */
export class ModifierShortcutStateMachine {
  private readonly pressedKeyCodes = new Set<number>();
  private readonly activeShortcutIds = new Set<ShortcutId>();

  constructor(
    private readonly shortcutDefinitions: ShortcutDefinition[],
    private readonly modifierKeyCodes: ModifierKeyCodes,
  ) {}

  handleKeyDown(keyCode: number): ShortcutTransition[] {
    this.pressedKeyCodes.add(keyCode);
    return this.collectTransitions();
  }

  handleKeyUp(keyCode: number): ShortcutTransition[] {
    this.pressedKeyCodes.delete(keyCode);
    return this.collectTransitions();
  }

  /** Releases everything, for example when the app is quitting. */
  reset(): ShortcutTransition[] {
    this.pressedKeyCodes.clear();
    return [...this.activeShortcutIds].map((shortcutId) => {
      this.activeShortcutIds.delete(shortcutId);
      return { shortcutId, phase: "released" as const };
    });
  }

  isShortcutActive(shortcutId: ShortcutId): boolean {
    return this.activeShortcutIds.has(shortcutId);
  }

  private collectTransitions(): ShortcutTransition[] {
    const transitions: ShortcutTransition[] = [];
    for (const shortcutDefinition of this.shortcutDefinitions) {
      const isSatisfied = this.isShortcutSatisfied(shortcutDefinition);
      const wasActive = this.activeShortcutIds.has(shortcutDefinition.id);

      if (isSatisfied && !wasActive) {
        this.activeShortcutIds.add(shortcutDefinition.id);
        transitions.push({ shortcutId: shortcutDefinition.id, phase: "pressed" });
      } else if (!isSatisfied && wasActive) {
        this.activeShortcutIds.delete(shortcutDefinition.id);
        transitions.push({ shortcutId: shortcutDefinition.id, phase: "released" });
      }
    }
    return transitions;
  }

  private isShortcutSatisfied(shortcutDefinition: ShortcutDefinition): boolean {
    const controlIsPressed = this.pressedKeyCodes.has(this.modifierKeyCodes.leftControl)
      || this.pressedKeyCodes.has(this.modifierKeyCodes.rightControl);
    const leftAltIsPressed = this.pressedKeyCodes.has(this.modifierKeyCodes.leftAlt);
    const windowsIsPressed = this.pressedKeyCodes.has(this.modifierKeyCodes.leftWindows)
      || this.pressedKeyCodes.has(this.modifierKeyCodes.rightWindows);
    const shiftIsPressed = this.pressedKeyCodes.has(this.modifierKeyCodes.leftShift)
      || this.pressedKeyCodes.has(this.modifierKeyCodes.rightShift);

    if (shortcutDefinition.requiresControl !== controlIsPressed) {
      return false;
    }
    if (shortcutDefinition.requiresLeftAlt !== leftAltIsPressed) {
      return false;
    }
    if (shortcutDefinition.requiresWindows !== windowsIsPressed) {
      return false;
    }
    if (shortcutDefinition.requiresShift !== shiftIsPressed) {
      return false;
    }
    if (
      shortcutDefinition.requiredKeyCode !== null
      && !this.pressedKeyCodes.has(shortcutDefinition.requiredKeyCode)
    ) {
      return false;
    }

    return true;
  }
}
