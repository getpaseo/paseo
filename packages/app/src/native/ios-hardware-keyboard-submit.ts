import type { EventSubscription } from "expo-modules-core";

type HardwareKeyboardSubmitHandler = () => void;

export function setHardwareKeyboardSubmitEnabled(_enabled: boolean) {}

export function addHardwareKeyboardSubmitListener(
  _handler: HardwareKeyboardSubmitHandler,
): EventSubscription {
  return {
    remove: () => {},
  };
}
