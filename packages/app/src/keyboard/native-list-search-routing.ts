import type { KeyboardShortcutInput } from "@/keyboard/keyboard-shortcuts";
import type { HardwareKeyDownEvent } from "@/native/hardware-keyboard-events.types";
import { shortcutKeyFromCode } from "@/keyboard/shortcut-string";

export function toNativeKeyboardShortcutInput(event: HardwareKeyDownEvent): KeyboardShortcutInput {
  return {
    key: shortcutKeyFromCode(event.code, event.shiftKey) ?? event.code,
    code: event.code,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    repeat: event.repeat ?? false,
  };
}

export function routeNativeListSearchBeforeShortcut(input: {
  event: HardwareKeyDownEvent;
  dispatchList(event: KeyboardShortcutInput): boolean;
  dispatchShortcut(event: KeyboardShortcutInput): void;
}): boolean {
  const event = toNativeKeyboardShortcutInput(input.event);
  if (input.dispatchList(event)) return true;
  input.dispatchShortcut(event);
  return false;
}
