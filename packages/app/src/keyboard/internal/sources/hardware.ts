import type { KeyboardShortcutInput } from "../../keyboard-shortcuts";
export interface HardwareKeyboardEvent extends KeyboardShortcutInput {
  isComposing: boolean;
  phase: "down" | "up";
}
/** A shortcut the native window takes from the focused text control, by DOM `code`. */
export interface ClaimedShortcut {
  code: string;
  shift: boolean;
  alt: boolean;
}
export function subscribeHardwareKeyboard(
  _handler: (event: HardwareKeyboardEvent) => void,
): () => void {
  return () => {};
}
export function setHardwareKeyboardOverlayKeys(_keys: readonly string[]): void {}
export function setHardwareKeyboardClaimedShortcuts(_shortcuts: readonly ClaimedShortcut[]): void {}

export function getHardwareKeyboardPresent(): boolean {
  return false;
}
export function subscribeHardwareKeyboardPresence(_changed: () => void): () => void {
  return () => {};
}
