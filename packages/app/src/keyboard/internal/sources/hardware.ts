import type { KeyboardShortcutInput } from "../../keyboard-shortcuts";
export interface HardwareKeyboardEvent extends KeyboardShortcutInput {
  isComposing: boolean;
  phase: "down" | "up";
}
export function subscribeHardwareKeyboard(
  _handler: (event: HardwareKeyboardEvent) => void,
): () => void {
  return () => {};
}
export function setHardwareKeyboardOverlayKeys(_keys: readonly string[]): void {}

export function getHardwareKeyboardPresent(): boolean {
  return false;
}
export function subscribeHardwareKeyboardPresence(_changed: () => void): () => void {
  return () => {};
}
