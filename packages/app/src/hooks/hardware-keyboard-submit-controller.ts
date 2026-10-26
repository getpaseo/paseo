/** Modifier state of the Enter press that native hardware-keyboard handling consumed. */
export interface HardwareKeyboardEnterKeys {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export type HardwareKeyboardSubmitHandler = (keys: HardwareKeyboardEnterKeys) => void;

export interface HardwareKeyboardSubmitListenerPort {
  addListener(handler: HardwareKeyboardSubmitHandler): { remove: () => void };
  setEnabled(enabled: boolean): void;
}

export interface HardwareKeyboardSubmitController {
  setOnSubmit(handler: HardwareKeyboardSubmitHandler): void;
  enable(): void;
  disable(): void;
}

export function createHardwareKeyboardSubmitController(
  port: HardwareKeyboardSubmitListenerPort,
): HardwareKeyboardSubmitController {
  let subscription: { remove: () => void } | null = null;
  // Native events are delivered asynchronously, so one can arrive after disable.
  // Each enable owns a fresh token and only the current token may submit.
  let activeToken: object | null = null;
  let onSubmit: HardwareKeyboardSubmitHandler = () => {};

  return {
    setOnSubmit(handler) {
      onSubmit = handler;
    },
    enable() {
      if (subscription) return;
      const token = {};
      activeToken = token;
      subscription = port.addListener((keys) => {
        if (activeToken === token) onSubmit(keys);
      });
      port.setEnabled(true);
    },
    disable() {
      if (!subscription) return;
      activeToken = null;
      port.setEnabled(false);
      subscription.remove();
      subscription = null;
    },
  };
}
