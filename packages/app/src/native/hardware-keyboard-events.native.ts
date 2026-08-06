import { requireNativeModule, type EventSubscription } from "expo-modules-core";

import type { HardwareKeyDownEvent } from "@/native/hardware-keyboard-events.types";

interface PaseoHardwareKeyboardModule {
  setHardwareKeyEventsEnabled(enabled: boolean): void;
  addListener(
    eventName: "onHardwareKeyDown",
    handler: (event: HardwareKeyDownEvent) => void,
  ): EventSubscription;
}

const module = requireNativeModule<PaseoHardwareKeyboardModule>("PaseoHardwareKeyboard");

export function setHardwareKeyEventsEnabled(enabled: boolean) {
  module.setHardwareKeyEventsEnabled(enabled);
}

export function addHardwareKeyDownListener(handler: (event: HardwareKeyDownEvent) => void) {
  return module.addListener("onHardwareKeyDown", handler);
}
