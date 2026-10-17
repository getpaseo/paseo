import { requireNativeModule, type EventSubscription } from "expo-modules-core";
import type {
  HardwareKeyboardEnterKeys,
  HardwareKeyboardSubmitHandler,
} from "@/hooks/hardware-keyboard-submit-controller";

interface PaseoHardwareKeyboardModule {
  setHardwareKeyboardSubmitEnabled(enabled: boolean): void;
  addListener(eventName: "onHardwareKeyboardSubmit", handler: () => void): EventSubscription;
}

const module = requireNativeModule<PaseoHardwareKeyboardModule>("PaseoHardwareKeyboard");

// iOS registers only an unmodified Enter key command.
const ENTER_KEYS: HardwareKeyboardEnterKeys = { shiftKey: false, ctrlKey: false, metaKey: false };

// iOS resolves the first responder natively, so the composer needs no native ID.
export const hardwareKeyboardSubmitTargetsNativeId = false;
export const hardwareKeyboardEnterRules: "send-button" | "desktop" = "send-button";

export function setHardwareKeyboardSubmitEnabled(enabled: boolean, _targetNativeId: string | null) {
  module.setHardwareKeyboardSubmitEnabled(enabled);
}

export function addHardwareKeyboardSubmitListener(
  handler: HardwareKeyboardSubmitHandler,
  _targetNativeId: string | null,
) {
  return module.addListener("onHardwareKeyboardSubmit", () => handler(ENTER_KEYS));
}
