import type {
  HardwareKeyboardSendShortcut,
  HardwareKeyboardSubmitEvent,
} from "@/native/hardware-keyboard-submit.types";

export interface HardwareKeyboardSubmitListenerPort {
  addListener(handler: (event: HardwareKeyboardSubmitEvent) => void): { remove: () => void };
  setEnabled(enabled: boolean, sendShortcut: HardwareKeyboardSendShortcut): void;
}

export interface HardwareKeyboardSubmitController {
  setOnSubmit(handler: (event: HardwareKeyboardSubmitEvent) => void): void;
  enable(sendShortcut: HardwareKeyboardSendShortcut): void;
  disable(): void;
}

export function createHardwareKeyboardSubmitController(
  port: HardwareKeyboardSubmitListenerPort,
): HardwareKeyboardSubmitController {
  let subscription: { remove: () => void } | null = null;
  let onSubmit: (event: HardwareKeyboardSubmitEvent) => void = () => {};
  let sendShortcut: HardwareKeyboardSendShortcut = "enter";

  return {
    setOnSubmit(handler) {
      onSubmit = handler;
    },
    enable(nextSendShortcut) {
      sendShortcut = nextSendShortcut;
      if (!subscription) {
        subscription = port.addListener((event) => onSubmit(event));
      }
      port.setEnabled(true, sendShortcut);
    },
    disable() {
      if (!subscription) return;
      port.setEnabled(false, sendShortcut);
      subscription.remove();
      subscription = null;
    },
  };
}
