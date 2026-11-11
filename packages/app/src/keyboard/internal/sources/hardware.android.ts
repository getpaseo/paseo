import { requireNativeModule } from "expo-modules-core";
import type { HardwareKeyboardEvent } from "./hardware";
interface HardwareKeyboardModule {
  getHardwareKeyboardPresent(): boolean;
  addListener(event: "onHardwareKeyboardPresenceChanged", handler: () => void): { remove(): void };
  setOverlayKeys(keys: readonly string[]): void;
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

export function getHardwareKeyboardPresent(): boolean {
  return module.getHardwareKeyboardPresent();
}
export function subscribeHardwareKeyboardPresence(changed: () => void): () => void {
  const subscription = module.addListener("onHardwareKeyboardPresenceChanged", changed);
  return () => subscription.remove();
}
