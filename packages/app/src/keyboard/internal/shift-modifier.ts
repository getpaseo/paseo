export interface ShiftModifierKeyEvent {
  key: string;
  code?: string;
  shiftKey: boolean;
}

export interface ShiftModifierTracker {
  isDown(): boolean;
  handleKeyDown(event: ShiftModifierKeyEvent): void;
  handleKeyUp(event: ShiftModifierKeyEvent): void;
  reset(): void;
}

/**
 * Tracks whether a physical Shift key is currently held across DOM and native
 * hardware keyboard streams so touch/pointer press handlers that omit
 * `shiftKey` (native GestureResponderEvent, touch-synthesized clicks) can still
 * observe Shift+tap and Shift+click.
 */
export function createShiftModifierTracker(): ShiftModifierTracker {
  const pressedCodes = new Set<string>();
  return {
    isDown: () => pressedCodes.size > 0,
    handleKeyDown(event) {
      if (event.key === "Shift") {
        pressedCodes.add(event.code || "Shift");
      } else if (!event.shiftKey && pressedCodes.size > 0) {
        pressedCodes.clear();
      }
    },
    handleKeyUp(event) {
      if (event.key === "Shift") {
        pressedCodes.delete(event.code || "Shift");
        if (!event.shiftKey) {
          pressedCodes.clear();
        }
      } else if (!event.shiftKey && pressedCodes.size > 0) {
        pressedCodes.clear();
      }
    },
    reset() {
      pressedCodes.clear();
    },
  };
}

export const shiftModifier = createShiftModifierTracker();

export function isShiftKeyDown(): boolean {
  return shiftModifier.isDown();
}
