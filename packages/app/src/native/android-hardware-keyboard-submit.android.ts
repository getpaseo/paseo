import { requireNativeModule, type EventSubscription } from "expo-modules-core";
import type {
  HardwareKeyboardSubmitChord,
  HardwareKeyboardSubmitKeys,
} from "./android-hardware-keyboard-submit.types";

type HardwareKeyboardSubmitHandler = (keys: HardwareKeyboardSubmitKeys) => void;

interface PaseoHardwareKeyboardModule {
  setHardwareKeyboardSubmitChords(chords: readonly HardwareKeyboardSubmitChord[]): void;
  addListener(
    eventName: "onHardwareKeyboardSubmit",
    handler: HardwareKeyboardSubmitHandler,
  ): EventSubscription;
}

const module = requireNativeModule<PaseoHardwareKeyboardModule>("PaseoHardwareKeyboard");

export function setHardwareKeyboardSubmitChords(chords: readonly HardwareKeyboardSubmitChord[]) {
  module.setHardwareKeyboardSubmitChords(chords);
}

export function addHardwareKeyboardSubmitListener(handler: HardwareKeyboardSubmitHandler) {
  return module.addListener("onHardwareKeyboardSubmit", handler);
}
