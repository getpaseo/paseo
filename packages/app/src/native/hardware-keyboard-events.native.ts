import { requireNativeModule, type EventSubscription } from "expo-modules-core";

import type {
  HardwareKeyDownEvent,
  HardwareKeyboardConnectionEvent,
  HardwareModifierEvent,
} from "@/native/hardware-keyboard-events.types";

interface PaseoHardwareKeyboardModule {
  setHardwareKeyEventsEnabled(enabled: boolean): void;
  getHardwareKeyboardConnected(): boolean;
  addListener(
    eventName: "onHardwareKeyDown",
    handler: (event: HardwareKeyDownEvent) => void,
  ): EventSubscription;
  addListener(
    eventName: "onHardwareModifier",
    handler: (event: HardwareModifierEvent) => void,
  ): EventSubscription;
  addListener(
    eventName: "onHardwareKeyboardConnectionChange",
    handler: (event: HardwareKeyboardConnectionEvent) => void,
  ): EventSubscription;
}

const module = requireNativeModule<PaseoHardwareKeyboardModule>("PaseoHardwareKeyboard");

export function setHardwareKeyEventsEnabled(enabled: boolean) {
  module.setHardwareKeyEventsEnabled(enabled);
}

export function getHardwareKeyboardConnected(): boolean {
  return module.getHardwareKeyboardConnected();
}

export function addHardwareKeyDownListener(handler: (event: HardwareKeyDownEvent) => void) {
  return module.addListener("onHardwareKeyDown", handler);
}

export function addHardwareModifierListener(handler: (event: HardwareModifierEvent) => void) {
  return module.addListener("onHardwareModifier", handler);
}

export function addHardwareKeyboardConnectionListener(
  handler: (event: HardwareKeyboardConnectionEvent) => void,
) {
  return module.addListener("onHardwareKeyboardConnectionChange", handler);
}
