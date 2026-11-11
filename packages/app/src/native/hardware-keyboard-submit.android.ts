import { requireNativeModule, type EventSubscription } from "expo-modules-core";
import type {
  HardwareKeyboardSendShortcut,
  HardwareKeyboardSubmitEvent,
} from "./hardware-keyboard-submit.types";

type HardwareKeyboardSubmitHandler = (event: HardwareKeyboardSubmitEvent) => void;

interface PaseoHardwareKeyboardModule {
  setHardwareKeyboardSubmitEnabled(
    enabled: boolean,
    sendShortcut: HardwareKeyboardSendShortcut,
  ): void;
  addListener(
    eventName: "onHardwareKeyboardSubmit",
    handler: HardwareKeyboardSubmitHandler,
  ): EventSubscription;
}

const module = requireNativeModule<PaseoHardwareKeyboardModule>("PaseoHardwareKeyboard");

export function setHardwareKeyboardSubmitEnabled(
  enabled: boolean,
  sendShortcut: HardwareKeyboardSendShortcut,
) {
  module.setHardwareKeyboardSubmitEnabled(enabled, sendShortcut);
}

export function addHardwareKeyboardSubmitListener(handler: HardwareKeyboardSubmitHandler) {
  return module.addListener("onHardwareKeyboardSubmit", handler);
}
