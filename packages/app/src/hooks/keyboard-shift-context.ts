import { createContext, useContext } from "react";
import type { SharedValue } from "react-native-reanimated";

export interface KeyboardShiftContextValue {
  shift: SharedValue<number>;
  bottomInset: SharedValue<number>;
}

export const KeyboardShiftContext = createContext<KeyboardShiftContextValue | null>(null);

/** Read the app-wide keyboard inset without loading its native provider implementation. */
export function useKeyboardShift(): KeyboardShiftContextValue {
  const context = useContext(KeyboardShiftContext);
  if (!context) {
    throw new Error("useKeyboardShift must be used inside KeyboardShiftProvider");
  }
  return context;
}
