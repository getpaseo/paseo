import { useEffect, useId, useRef } from "react";
import {
  addHardwareKeyboardSubmitListener,
  hardwareKeyboardSubmitTargetsNativeId,
  setHardwareKeyboardSubmitEnabled,
} from "@/native/ios-hardware-keyboard-submit";
import {
  createHardwareKeyboardSubmitController,
  type HardwareKeyboardSubmitController,
  type HardwareKeyboardSubmitHandler,
} from "./hardware-keyboard-submit-controller";

interface UseIosHardwareKeyboardSubmitInput {
  isEnabled: boolean;
  onSubmit: HardwareKeyboardSubmitHandler;
}

interface UseIosHardwareKeyboardSubmitResult {
  /** Pass to the composer's text input so native submission matches that exact view. */
  nativeID: string | undefined;
}

export function useIosHardwareKeyboardSubmit(
  input: UseIosHardwareKeyboardSubmitInput,
): UseIosHardwareKeyboardSubmitResult {
  const reactId = useId();
  const targetNativeId = hardwareKeyboardSubmitTargetsNativeId
    ? `paseo-hardware-keyboard-submit-${reactId}`
    : null;
  const controllerRef = useRef<HardwareKeyboardSubmitController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createHardwareKeyboardSubmitController({
      addListener: (handler) => addHardwareKeyboardSubmitListener(handler, targetNativeId),
      setEnabled: (enabled) => setHardwareKeyboardSubmitEnabled(enabled, targetNativeId),
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

  return { nativeID: targetNativeId ?? undefined };
}
