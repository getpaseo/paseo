import { useEffect, useRef } from "react";
import {
  addHardwareKeyboardSubmitListener,
  setHardwareKeyboardSubmitEnabled,
} from "@/native/ios-hardware-keyboard-submit";
import type { HardwareKeyboardSubmitEvent } from "@/native/hardware-keyboard-submit.types";
import {
  createHardwareKeyboardSubmitController,
  type HardwareKeyboardSubmitController,
} from "./hardware-keyboard-submit-controller";

// The iOS source predates the modifier payload. Give the shared controller a
// plain Return so iPad keeps its existing submit path.
const NO_MODIFIERS: HardwareKeyboardSubmitEvent = {
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
};

interface UseIosHardwareKeyboardSubmitInput {
  isEnabled: boolean;
  onSubmit: () => void;
}

export function useIosHardwareKeyboardSubmit(input: UseIosHardwareKeyboardSubmitInput) {
  const controllerRef = useRef<HardwareKeyboardSubmitController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createHardwareKeyboardSubmitController({
      addListener: (handler) => addHardwareKeyboardSubmitListener(() => handler(NO_MODIFIERS)),
      setEnabled: (enabled) => setHardwareKeyboardSubmitEnabled(enabled),
    });
  }
  const controller = controllerRef.current;

  controller.setOnSubmit(input.onSubmit);

  useEffect(() => {
    if (!input.isEnabled) {
      return;
    }
    controller.enable("enter");
    return () => controller.disable();
  }, [controller, input.isEnabled]);
}
