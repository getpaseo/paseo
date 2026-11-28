import { requireNativeModule } from "expo-modules-core";
import type { ClaimedShortcut, HardwareKeyboardEvent } from "./hardware";
interface HardwareKeyboardModule {
  getHardwareKeyboardPresent(): boolean;
  addListener(event: "onHardwareKeyboardPresenceChanged", handler: () => void): { remove(): void };
  setOverlayKeys(keys: readonly string[]): void;
  setClaimedShortcuts(shortcuts: readonly ClaimedShortcut[]): void;
  addListener(
    event: "onHardwareKeyboardShortcut",
    handler: (event: HardwareKeyboardEvent) => void,
  ): { remove(): void };
}
const module = requireNativeModule<HardwareKeyboardModule>("PaseoHardwareKeyboard");
export function subscribeHardwareKeyboard(
  handler: (event: HardwareKeyboardEvent) => void,
): () => void {
  const subscription = module.addListener("onHardwareKeyboardShortcut", handler);
  return () => subscription.remove();
}
export function setHardwareKeyboardOverlayKeys(keys: readonly string[]): void {
  module.setOverlayKeys(keys);
}
export function setHardwareKeyboardClaimedShortcuts(shortcuts: readonly ClaimedShortcut[]): void {
  module.setClaimedShortcuts(shortcuts);
}

export function getHardwareKeyboardPresent(): boolean {
  return module.getHardwareKeyboardPresent();
}
export function subscribeHardwareKeyboardPresence(changed: () => void): () => void {
  const subscription = module.addListener("onHardwareKeyboardPresenceChanged", changed);
  return () => subscription.remove();
}
