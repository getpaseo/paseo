/** A hardware Return chord the composer sends with, as the Android key source matches it. */
export type HardwareKeyboardSubmitChord = "Enter" | "Control+Enter" | "Meta+Enter";

/** Modifier state of a hardware Return press the Android key source took for the composer. */
export interface HardwareKeyboardSubmitKeys {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}
