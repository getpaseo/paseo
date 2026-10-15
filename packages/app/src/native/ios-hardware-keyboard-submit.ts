import type { EventSubscription } from "expo-modules-core";
import type { HardwareKeyboardSubmitHandler } from "@/hooks/hardware-keyboard-submit-controller";

// Platforms without a native hardware-keyboard submit path do not target a specific view.
export const hardwareKeyboardSubmitTargetsNativeId = false;
export const hardwareKeyboardEnterRules: "send-button" | "desktop" = "send-button";

export function setHardwareKeyboardSubmitEnabled(
  _enabled: boolean,
  _targetNativeId: string | null,
) {}

export function addHardwareKeyboardSubmitListener(
  _handler: HardwareKeyboardSubmitHandler,
  _targetNativeId: string | null,
): EventSubscription {
  return {
    remove: () => {},
  };
}
