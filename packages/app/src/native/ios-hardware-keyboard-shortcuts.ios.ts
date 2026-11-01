import { requireNativeModule, type EventSubscription } from "expo-modules-core";
import type { NativeKeyCommand } from "@/keyboard/native-shortcuts";

interface HardwareKeyboardShortcutEvent {
  combo: string;
}

type HardwareKeyboardShortcutHandler = (event: HardwareKeyboardShortcutEvent) => void;

interface PaseoHardwareKeyboardModule {
  setKeyCommands(commands: NativeKeyCommand[]): void;
  addListener(
    eventName: "onHardwareKeyboardShortcut",
    handler: HardwareKeyboardShortcutHandler,
  ): EventSubscription;
}

const module = requireNativeModule<PaseoHardwareKeyboardModule>("PaseoHardwareKeyboard");

export function setHardwareKeyboardShortcuts(commands: NativeKeyCommand[]) {
  module.setKeyCommands(commands);
}

export function addHardwareKeyboardShortcutListener(handler: HardwareKeyboardShortcutHandler) {
  return module.addListener("onHardwareKeyboardShortcut", handler);
}
