import { requireNativeModule } from "expo-modules-core";
import type { HardwareKeyboardEvent } from "./hardware";
interface HardwareKeyboardModule {
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
