import { useEffect, useRef } from "react";
import {
  addHardwareKeyboardSubmitListener,
  setHardwareKeyboardSubmitChords,
} from "@/native/android-hardware-keyboard-submit";
import type {
  HardwareKeyboardSubmitChord,
  HardwareKeyboardSubmitKeys,
} from "@/native/android-hardware-keyboard-submit.types";
import {
  createHardwareKeyboardSubmitChordController,
  type HardwareKeyboardSubmitChordController,
} from "./hardware-keyboard-submit-controller";

interface UseAndroidHardwareKeyboardSubmitInput {
  /** The Return chords the composer sends with right now; empty while it cannot send. */
  chords: readonly HardwareKeyboardSubmitChord[];
  onSubmit: (keys: HardwareKeyboardSubmitKeys) => void;
}

export function useAndroidHardwareKeyboardSubmit(input: UseAndroidHardwareKeyboardSubmitInput) {
  const controllerRef = useRef<HardwareKeyboardSubmitChordController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createHardwareKeyboardSubmitChordController({
      addListener: addHardwareKeyboardSubmitListener,
      setChords: setHardwareKeyboardSubmitChords,
    });
  }
  const controller = controllerRef.current;

  controller.setOnSubmit(input.onSubmit);

  useEffect(() => {
    controller.setChords(input.chords);
  }, [controller, input.chords]);

  useEffect(() => () => controller.setChords([]), [controller]);
}
