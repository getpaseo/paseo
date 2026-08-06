import { useEffect, useRef } from "react";
import {
  addHardwareKeyboardSubmitListener,
  setHardwareKeyboardSubmitEnabled,
} from "@/native/hardware-keyboard-submit";
import {
  createHardwareKeyboardSubmitController,
  type HardwareKeyboardSubmitController,
} from "./hardware-keyboard-submit-controller";

interface UseHardwareKeyboardSubmitInput {
  isEnabled: boolean;
  onSubmit: () => void;
}

export function useHardwareKeyboardSubmit(input: UseHardwareKeyboardSubmitInput) {
  const controllerRef = useRef<HardwareKeyboardSubmitController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createHardwareKeyboardSubmitController({
      addListener: addHardwareKeyboardSubmitListener,
      setEnabled: setHardwareKeyboardSubmitEnabled,
    });
  }
  const controller = controllerRef.current;

  controller.setOnSubmit(input.onSubmit);

  useEffect(() => {
    if (!input.isEnabled) {
      return;
    }
    controller.enable();
    return () => controller.disable();
  }, [controller, input.isEnabled]);
}
