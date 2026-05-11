import { useEffect, useRef } from "react";
import {
  addHardwareKeyboardSubmitListener,
  setHardwareKeyboardSubmitEnabled,
} from "@/native/ios-hardware-keyboard-submit";

interface UseIosHardwareKeyboardSubmitInput {
  isEnabled: boolean;
  onSubmit: () => void;
}

export function useIosHardwareKeyboardSubmit(input: UseIosHardwareKeyboardSubmitInput) {
  const onSubmitRef = useRef(input.onSubmit);

  useEffect(() => {
    onSubmitRef.current = input.onSubmit;
  }, [input.onSubmit]);

  useEffect(() => {
    if (!input.isEnabled) {
      return;
    }

    const subscription = addHardwareKeyboardSubmitListener(() => {
      onSubmitRef.current();
    });
    setHardwareKeyboardSubmitEnabled(true);

    return () => {
      setHardwareKeyboardSubmitEnabled(false);
      subscription.remove();
    };
  }, [input.isEnabled]);
}
