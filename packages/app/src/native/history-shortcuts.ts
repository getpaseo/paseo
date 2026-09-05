import type { KeyboardShortcutInput } from "@/keyboard/keyboard-shortcuts";

export const nativeHistoryShortcutsAvailable = false;
export function setNativeHistoryCommands(_commands: KeyboardShortcutInput[]) {}
export function setNativeShortcutCaptureCommands(_commands: KeyboardShortcutInput[] | null) {}
export function addNativeHistoryShortcutListener(
  _listener: (event: KeyboardShortcutInput) => void,
) {
  return { remove() {} };
}
