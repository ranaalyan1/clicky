import { DictationShortcutId } from "../shared/contracts";

export const uiohookSpaceKeyCode = 57;
// These numbers are the library's own key codes (see UiohookKey), repeated here
// so this file stays testable without loading the native hook.
export const uiohookSKeyCode = 31;
export const uiohookQKeyCode = 16;
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

export type ShortcutId = "talk" | "dictation" | "circle" | "snip" | "panic";

export interface ShortcutDefinition {
  id: ShortcutId;
  /**
   * Shorter shortcuts this chord takes the keys from. Declared by hand rather
   * than inferred, so a chord can never quietly cancel something the user did
   * not mean to give up.
   */
  supersedes?: ShortcutId[];
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

/** Display names for the fixed shortcuts, used by the island and the panel. */
export const shortcutLabels: Record<Exclude<ShortcutId, "dictation">, string> = {
  talk: "Ctrl + Alt",
  circle: "Ctrl + Shift",
  snip: "Ctrl + Alt + S",
  panic: "Ctrl + Alt + Q",
};

export const dictationShortcutLabels: Record<DictationShortcutId, string> = {
  "ctrl+windows": "Ctrl + Windows",
  "ctrl+shift+space": "Ctrl + Shift + Space",
  "capslock": "Caps Lock",
};

/** Builds the five shortcuts Clickaa listens for. */
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
    /* Ctrl+Alt+S. Longer than the talk chord on purpose: the state machine
       hands the keys over to the snip shortcut the moment the S arrives. */
    /* Ctrl+Alt+Q. The panic chord: it stops whatever Clickaa is doing, so it
       has to win over the talk shortcut that started the same way. */
    {
      id: "panic",
      supersedes: ["talk"],
      requiresControl: true,
      requiresLeftAlt: true,
      requiresWindows: false,
      requiresShift: false,
      requiredKeyCode: uiohookQKeyCode,
    },
    {
      id: "snip",
      // Ctrl+Alt on its own is push-to-talk; the S turns it into a snip.
      supersedes: ["talk"],
      requiresControl: true,
      requiresLeftAlt: true,
      requiresWindows: false,
      requiresShift: false,
      requiredKeyCode: uiohookSKeyCode,
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
  /**
   * Shortcuts that lost their keys to a longer chord, for example talk when
   * Ctrl+Alt+S turns into a snip. They stay quiet until every key is released,
   * so letting go of the S does not restart the thing they were doing.
   */
  private readonly supersededShortcutIds = new Set<ShortcutId>();

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
    this.supersededShortcutIds.clear();
    return [...this.activeShortcutIds].map((shortcutId) => {
      this.activeShortcutIds.delete(shortcutId);
      return { shortcutId, phase: "released" as const };
    });
  }

  isShortcutActive(shortcutId: ShortcutId): boolean {
    return this.activeShortcutIds.has(shortcutId);
  }

  private collectTransitions(): ShortcutTransition[] {
    if (!this.pressedKeyCodes.size) {
      this.supersededShortcutIds.clear();
    }

    const transitions: ShortcutTransition[] = [];
    for (const shortcutDefinition of this.shortcutDefinitions) {
      const isSatisfied = this.isShortcutSatisfied(shortcutDefinition);
      const wasActive = this.activeShortcutIds.has(shortcutDefinition.id);

      if (isSatisfied && !wasActive && !this.supersededShortcutIds.has(shortcutDefinition.id)) {
        this.activeShortcutIds.add(shortcutDefinition.id);
        transitions.push({ shortcutId: shortcutDefinition.id, phase: "pressed" });
        transitions.push(...this.releaseSupersededShortcuts(shortcutDefinition));
      } else if (!isSatisfied && wasActive) {
        this.activeShortcutIds.delete(shortcutDefinition.id);
        transitions.push({ shortcutId: shortcutDefinition.id, phase: "released" });
      }
    }
    return transitions;
  }

  /**
   * A chord like Ctrl+Alt+S borrows the keys of the shorter Ctrl+Alt shortcut
   * that was already running, so that one steps aside for it.
   */
  private releaseSupersededShortcuts(shortcutDefinition: ShortcutDefinition): ShortcutTransition[] {
    const transitions: ShortcutTransition[] = [];
    for (const supersededShortcutId of shortcutDefinition.supersedes ?? []) {
      if (!this.activeShortcutIds.has(supersededShortcutId)) {
        continue;
      }

      this.activeShortcutIds.delete(supersededShortcutId);
      this.supersededShortcutIds.add(supersededShortcutId);
      transitions.push({ shortcutId: supersededShortcutId, phase: "released" });
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
