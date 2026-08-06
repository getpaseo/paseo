import type { HardwareKeyboardSubmitEvent } from "@/native/hardware-keyboard-submit.types";

export interface HardwareKeyboardSubmitListenerPort {
  addListener(handler: (event: HardwareKeyboardSubmitEvent) => void): { remove: () => void };
  setEnabled(enabled: boolean): void;
}

export interface HardwareKeyboardSubmitController {
  setOnSubmit(handler: (event: HardwareKeyboardSubmitEvent) => void): void;
  enable(): void;
  disable(): void;
}

const DEFAULT_EVENT: HardwareKeyboardSubmitEvent = { alternate: false };

export function createHardwareKeyboardSubmitController(
  port: HardwareKeyboardSubmitListenerPort,
): HardwareKeyboardSubmitController {
  let subscription: { remove: () => void } | null = null;
  let onSubmit: (event: HardwareKeyboardSubmitEvent) => void = () => {};

  return {
    setOnSubmit(handler) {
      onSubmit = handler;
    },
    enable() {
      if (subscription) return;
      subscription = port.addListener((event) => onSubmit(event ?? DEFAULT_EVENT));
      port.setEnabled(true);
    },
    disable() {
      if (!subscription) return;
      port.setEnabled(false);
      subscription.remove();
      subscription = null;
    },
  };
}
