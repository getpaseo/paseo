import type { EventSubscription } from "expo-modules-core";
import type {
  HardwareKeyboardSubmitChord,
  HardwareKeyboardSubmitKeys,
} from "./android-hardware-keyboard-submit.types";

export function setHardwareKeyboardSubmitChords(_chords: readonly HardwareKeyboardSubmitChord[]) {}

export function addHardwareKeyboardSubmitListener(
  _handler: (keys: HardwareKeyboardSubmitKeys) => void,
): EventSubscription {
  return {
    remove: () => {},
  };
}
