import { getShortcutOs } from "@/utils/shortcut-platform";

export type HeldModifierKey = "Shift" | "Meta" | "Control";

export interface HeldModifierKeyEvent {
  key: string;
  code?: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export interface HeldModifierTracker {
  isDown(key: HeldModifierKey): boolean;
  handleKeyDown(event: HeldModifierKeyEvent): void;
  handleKeyUp(event: HeldModifierKeyEvent): void;
  reset(): void;
}

const MODIFIER_FLAGS = {
  Shift: "shiftKey",
  Meta: "metaKey",
  Control: "ctrlKey",
} as const satisfies Record<HeldModifierKey, keyof HeldModifierKeyEvent>;

const MODIFIER_KEYS = Object.keys(MODIFIER_FLAGS) as HeldModifierKey[];

/**
 * Tracks which physical modifier keys are held across DOM and native hardware keyboard streams so
 * press handlers that omit modifier flags (native GestureResponderEvent, touch-synthesized clicks)
 * can still observe Shift+tap or Cmd+tap from a hardware keyboard.
 */
export function createHeldModifierTracker(): HeldModifierTracker {
  const pressedCodes: Record<HeldModifierKey, Set<string>> = {
    Shift: new Set(),
    Meta: new Set(),
    Control: new Set(),
  };
  // A key reported without a modifier's flag means that modifier's key-up was swallowed.
  const clearReleased = (event: HeldModifierKeyEvent) => {
    for (const modifier of MODIFIER_KEYS) {
      if (event.key !== modifier && !event[MODIFIER_FLAGS[modifier]]) {
        pressedCodes[modifier].clear();
      }
    }
  };
  return {
    isDown: (key) => pressedCodes[key].size > 0,
    handleKeyDown(event) {
      const modifier = MODIFIER_KEYS.find((key) => key === event.key);
      if (modifier) {
        pressedCodes[modifier].add(event.code || modifier);
      }
      clearReleased(event);
    },
    handleKeyUp(event) {
      const modifier = MODIFIER_KEYS.find((key) => key === event.key);
      if (modifier) {
        pressedCodes[modifier].delete(event.code || modifier);
        if (!event[MODIFIER_FLAGS[modifier]]) {
          pressedCodes[modifier].clear();
        }
      }
      clearReleased(event);
    },
    reset() {
      for (const modifier of MODIFIER_KEYS) {
        pressedCodes[modifier].clear();
      }
    },
  };
}

export const heldModifiers = createHeldModifierTracker();

/**
 * Modifiers that accompanied a pointer press. `mod` is the platform primary modifier the shortcut
 * layer binds as `mod`: Cmd on macOS/iOS/iPadOS, Ctrl on Windows, Linux and Android. Ctrl on macOS
 * is the secondary click, so it never counts as `mod` there.
 */
export interface PressModifiers {
  shift: boolean;
  mod: boolean;
}

interface PressModifierContext {
  isMac: boolean;
  held: Pick<HeldModifierTracker, "isDown">;
}

export function readPressModifiers(
  event: unknown,
  context: PressModifierContext = { isMac: getShortcutOs() === "mac", held: heldModifiers },
): PressModifiers {
  const modKey: HeldModifierKey = context.isMac ? "Meta" : "Control";
  return {
    shift: hasPressFlag(event, "shiftKey") || context.held.isDown("Shift"),
    mod: hasPressFlag(event, MODIFIER_FLAGS[modKey]) || context.held.isDown(modKey),
  };
}

function hasPressFlag(event: unknown, flag: "shiftKey" | "metaKey" | "ctrlKey"): boolean {
  if (typeof event !== "object" || event === null) return false;
  if (Reflect.get(event, flag) === true) return true;
  const nativeEvent = Reflect.get(event, "nativeEvent");
  return (
    typeof nativeEvent === "object" &&
    nativeEvent !== null &&
    Reflect.get(nativeEvent, flag) === true
  );
}
