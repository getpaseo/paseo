export interface HardwareKeyboardSubmitListenerPort {
  addListener(handler: () => void): { remove: () => void };
  setEnabled(enabled: boolean): void;
}

export interface HardwareKeyboardSubmitController {
  setOnSubmit(handler: () => void): void;
  enable(): void;
  disable(): void;
}

export function createHardwareKeyboardSubmitController(
  port: HardwareKeyboardSubmitListenerPort,
): HardwareKeyboardSubmitController {
  let subscription: { remove: () => void } | null = null;
  let onSubmit: () => void = () => {};

  return {
    setOnSubmit(handler) {
      onSubmit = handler;
    },
    enable() {
      if (subscription) return;
      subscription = port.addListener(() => onSubmit());
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
