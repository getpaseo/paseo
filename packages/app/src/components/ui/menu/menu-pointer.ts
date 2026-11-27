import type { PointerEvent } from "react-native";

/**
 * Whether a pointer event came from something that can rest on a row without pressing it.
 *
 * A finger cannot, but the browser still reports one entering a row as the tap lands and leaving
 * as it lifts. Read as hover, that leave queues a close just as the tap's own press opens the
 * submenu, and the flyout vanishes a moment after it appears. A touch screen can have a mouse
 * attached too, so this has to be asked of each event, not of the device.
 */
export function isHoverPointer(event: PointerEvent): boolean {
  return event.nativeEvent.pointerType !== "touch";
}
