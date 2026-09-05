import { requireNativeModule, type EventSubscription } from "expo-modules-core";
import type { KeyboardShortcutInput } from "@/keyboard/keyboard-shortcuts";

interface HardwareKeyboardModule {
  setHardwareKeyboardShortcuts(commands: KeyboardShortcutInput[]): void;
  addListener(
    event: "onHardwareKeyboardShortcut",
    listener: (event: KeyboardShortcutInput) => void,
  ): EventSubscription;
}

const keyboard = requireNativeModule<HardwareKeyboardModule>("PaseoHardwareKeyboard");
let historyCommands: KeyboardShortcutInput[] = [];
let captureCommands: KeyboardShortcutInput[] | null = null;

export const nativeHistoryShortcutsAvailable = true;

export function setNativeHistoryCommands(commands: KeyboardShortcutInput[]) {
  historyCommands = commands;
  keyboard.setHardwareKeyboardShortcuts(captureCommands ?? historyCommands);
}

export function setNativeShortcutCaptureCommands(commands: KeyboardShortcutInput[] | null) {
  captureCommands = commands;
  keyboard.setHardwareKeyboardShortcuts(captureCommands ?? historyCommands);
}

export function addNativeHistoryShortcutListener(listener: (event: KeyboardShortcutInput) => void) {
  return keyboard.addListener("onHardwareKeyboardShortcut", listener);
}
