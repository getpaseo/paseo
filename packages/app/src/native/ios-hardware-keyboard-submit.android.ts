import { requireNativeModule, type EventSubscription } from "expo-modules-core";
import type { HardwareKeyboardSubmitHandler } from "@/hooks/hardware-keyboard-submit-controller";

interface HardwareKeyboardSubmitEvent {
  targetNativeId: string;
  ctrlKey: boolean;
  metaKey: boolean;
}

interface PaseoHardwareKeyboardModule {
  setHardwareKeyboardSubmitEnabled(enabled: boolean, targetNativeId: string | null): void;
  addListener(
    eventName: "onHardwareKeyboardSubmit",
    handler: (event: HardwareKeyboardSubmitEvent) => void,
  ): EventSubscription;
}

const module = requireNativeModule<PaseoHardwareKeyboardModule>("PaseoHardwareKeyboard");

// Android intercepts hardware Enter in the activity, before any view sees it, so it
// only submits when the focused view carries the registered composer's nativeID.
export const hardwareKeyboardSubmitTargetsNativeId = true;
// Shift+Enter never reaches JS: native passes it to the text input as a newline.
export const hardwareKeyboardEnterRules: "send-button" | "desktop" = "desktop";

export function setHardwareKeyboardSubmitEnabled(enabled: boolean, targetNativeId: string | null) {
  module.setHardwareKeyboardSubmitEnabled(enabled, targetNativeId);
}

// Every composer's controller subscribes to the same module event. Filtering on the view that
// native matched keeps a composer whose disable has not run yet from submitting too.
export function addHardwareKeyboardSubmitListener(
  handler: HardwareKeyboardSubmitHandler,
  targetNativeId: string | null,
) {
  return module.addListener("onHardwareKeyboardSubmit", (event) => {
    if (event.targetNativeId !== targetNativeId) return;
    handler({ shiftKey: false, ctrlKey: event.ctrlKey, metaKey: event.metaKey });
  });
}
