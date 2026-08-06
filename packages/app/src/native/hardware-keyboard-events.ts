import type { EventSubscription } from "expo-modules-core";

import type {
  HardwareKeyDownEvent,
  HardwareKeyboardConnectionEvent,
  HardwareModifierEvent,
} from "@/native/hardware-keyboard-events.types";

const NOOP_SUBSCRIPTION: EventSubscription = {
  remove: () => {},
};

export function setHardwareKeyEventsEnabled(_enabled: boolean) {}

export function getHardwareKeyboardConnected(): boolean {
  return false;
}

export function addHardwareKeyDownListener(
  _handler: (event: HardwareKeyDownEvent) => void,
): EventSubscription {
  return NOOP_SUBSCRIPTION;
}

export function addHardwareModifierListener(
  _handler: (event: HardwareModifierEvent) => void,
): EventSubscription {
  return NOOP_SUBSCRIPTION;
}

export function addHardwareKeyboardConnectionListener(
  _handler: (event: HardwareKeyboardConnectionEvent) => void,
): EventSubscription {
  return NOOP_SUBSCRIPTION;
}
