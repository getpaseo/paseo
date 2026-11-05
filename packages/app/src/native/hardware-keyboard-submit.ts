import type { EventSubscription } from "expo-modules-core";
import type {
  HardwareKeyboardSendShortcut,
  HardwareKeyboardSubmitEvent,
} from "./hardware-keyboard-submit.types";

type HardwareKeyboardSubmitHandler = (event: HardwareKeyboardSubmitEvent) => void;

export function setHardwareKeyboardSubmitEnabled(
  _enabled: boolean,
  _sendShortcut: HardwareKeyboardSendShortcut,
) {}

export function addHardwareKeyboardSubmitListener(
  _handler: HardwareKeyboardSubmitHandler,
): EventSubscription {
  return {
    remove: () => {},
  };
}
