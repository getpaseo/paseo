export interface HardwareKeyboardEvents {
  addListener(name: string, handler: () => void): { remove(): void };
}

export function createHardwareKeyboardSubmitBridge(events: HardwareKeyboardEvents) {
  let enabled = false;
  return {
    setHardwareKeyboardSubmitEnabled(nextEnabled: boolean) {
      enabled = nextEnabled;
    },
    addHardwareKeyboardSubmitListener(handler: () => void) {
      return events.addListener("paseoHardwareKeyboardSubmit", () => {
        if (enabled) handler();
      });
    },
  };
}
