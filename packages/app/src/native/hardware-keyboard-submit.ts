import type { EventSubscription } from "expo-modules-core";

import type { HardwareKeyboardSubmitEvent } from "@/native/hardware-keyboard-submit.types";

type HardwareKeyboardSubmitHandler = (event: HardwareKeyboardSubmitEvent) => void;

export function setHardwareKeyboardSubmitEnabled(_enabled: boolean) {}

export function addHardwareKeyboardSubmitListener(
  _handler: HardwareKeyboardSubmitHandler,
): EventSubscription {
  return {
    remove: () => {},
  };
}
