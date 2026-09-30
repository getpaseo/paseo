import type { EventSubscription } from "expo-modules-core";
import type { NativeKeyCommand } from "@/keyboard/native-shortcuts";

interface HardwareKeyboardShortcutEvent {
  combo: string;
}

type HardwareKeyboardShortcutHandler = (event: HardwareKeyboardShortcutEvent) => void;

export function setHardwareKeyboardShortcuts(_commands: NativeKeyCommand[]) {}

export function addHardwareKeyboardShortcutListener(
  _handler: HardwareKeyboardShortcutHandler,
): EventSubscription {
  return {
    remove: () => {},
  };
}
