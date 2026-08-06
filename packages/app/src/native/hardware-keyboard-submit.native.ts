import { requireNativeModule, type EventSubscription } from "expo-modules-core";

import type { HardwareKeyboardSubmitEvent } from "@/native/hardware-keyboard-submit.types";

type HardwareKeyboardSubmitHandler = (event: HardwareKeyboardSubmitEvent) => void;

interface PaseoHardwareKeyboardModule {
  setHardwareKeyboardSubmitEnabled(enabled: boolean): void;
  addListener(
    eventName: "onHardwareKeyboardSubmit",
    handler: HardwareKeyboardSubmitHandler,
  ): EventSubscription;
}

const module = requireNativeModule<PaseoHardwareKeyboardModule>("PaseoHardwareKeyboard");

export function setHardwareKeyboardSubmitEnabled(enabled: boolean) {
  module.setHardwareKeyboardSubmitEnabled(enabled);
}

export function addHardwareKeyboardSubmitListener(handler: HardwareKeyboardSubmitHandler) {
  return module.addListener("onHardwareKeyboardSubmit", handler);
}
