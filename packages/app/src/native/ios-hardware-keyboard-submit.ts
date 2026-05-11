import type { EventSubscription } from "expo-modules-core";

type HardwareKeyboardSubmitHandler = () => void;

const testHandlers = new Set<HardwareKeyboardSubmitHandler>();
let isEnabledForTest = false;

export function setHardwareKeyboardSubmitEnabled(enabled: boolean) {
  isEnabledForTest = enabled;
}

export function addHardwareKeyboardSubmitListener(
  handler: HardwareKeyboardSubmitHandler,
): EventSubscription {
  testHandlers.add(handler);
  return {
    remove: () => {
      testHandlers.delete(handler);
    },
  };
}

export function emitHardwareKeyboardSubmitForTest() {
  testHandlers.forEach((handler) => handler());
}

export function resetHardwareKeyboardSubmitForTest() {
  testHandlers.clear();
  isEnabledForTest = false;
}

export function getHardwareKeyboardSubmitEnabledForTest() {
  return isEnabledForTest;
}
