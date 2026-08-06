import type { EventSubscription } from "expo-modules-core";

import type { HardwareKeyDownEvent } from "@/native/hardware-keyboard-events.types";

export function setHardwareKeyEventsEnabled(_enabled: boolean) {}

export function addHardwareKeyDownListener(
  _handler: (event: HardwareKeyDownEvent) => void,
): EventSubscription {
  return {
    remove: () => {},
  };
}
