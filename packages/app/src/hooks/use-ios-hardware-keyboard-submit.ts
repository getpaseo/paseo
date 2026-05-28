import { useEffect, useRef } from "react";
import {
  addHardwareKeyboardSubmitListener,
  setHardwareKeyboardSubmitEnabled,
} from "@/native/ios-hardware-keyboard-submit";
import {
  createHardwareKeyboardSubmitController,
  type HardwareKeyboardSubmitController,
} from "./hardware-keyboard-submit-controller";

interface UseIosHardwareKeyboardSubmitInput {
  isEnabled: boolean;
  onSubmit: () => void;
}

export function useIosHardwareKeyboardSubmit(input: UseIosHardwareKeyboardSubmitInput) {
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
