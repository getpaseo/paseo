import { createContext, useContext } from "react";
import type { View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { measureInWindow } from "./measure";

export interface KeyboardShiftContextValue {
  shift: SharedValue<number>;
  /** Space reserved at keyboard boundaries, never updated by animation frames. */
  layoutShift: SharedValue<number>;
  isMoving: SharedValue<boolean>;
  bottomInset: SharedValue<number>;
}

export const KeyboardShiftContext = createContext<KeyboardShiftContextValue | null>(null);

/** How the nearest KeyboardTranslateView moves its descendants with the keyboard. */
export interface KeyboardTranslation {
  enabled: boolean;
  bottomClearance: number;
}

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the nearest KeyboardTranslateView tells the content it moves. */
export interface KeyboardTranslationScope {
  translation: KeyboardTranslation;
  /**
   * The element's window rect with the keyboard closed, whatever the keyboard is doing
   * now; null once the element or the translate view has unmounted.
   */
  measureAtRest: (element: View) => Promise<WindowRect | null>;
}

/** Views outside a KeyboardTranslateView stay put. */
export const KeyboardTranslationContext = createContext<KeyboardTranslationScope>({
  translation: { enabled: false, bottomClearance: 0 },
  measureAtRest: measureInWindow,
});
export const SettledKeyboardShiftContext = createContext<number | null>(null);

/** Read the app-wide keyboard inset without loading its native provider implementation. */
export function useKeyboardShift(): KeyboardShiftContextValue {
  const context = useContext(KeyboardShiftContext);
  if (!context) {
    throw new Error("useKeyboardShift must be used inside KeyboardShiftProvider");
  }
  return context;
}

/** Read the keyboard inset published after native keyboard motion has settled. */
export function useSettledKeyboardShift(): number {
  const context = useContext(SettledKeyboardShiftContext);
  if (context === null) {
    throw new Error("useSettledKeyboardShift must be used inside KeyboardShiftProvider");
  }
  return context;
}
