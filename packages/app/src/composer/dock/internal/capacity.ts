interface ComposerGeometry {
  height: number;
  bottomInset: number;
  keyboardShift: number;
  centered: boolean;
  compact: boolean;
}

export interface ComposerCapacity {
  keyboardReserve: number;
  capacity: number;
}

/** 10 content lines plus compact padding, gap, and toolbar. */
const CHAT_COMPOSER_MAX_HEIGHT = 268;

export function resolveComposerCapacity(input: ComposerGeometry): number {
  "worklet";
  // A centered form grows upward by half its height. Reserve both halves so
  // translating it still leaves five layout points below the header.
  const clearance = input.keyboardShift + 5;
  const reservedSpace = input.centered ? clearance * 2 : clearance;
  const available = Math.max(0, input.height - input.bottomInset - reservedSpace);
  if (input.centered || !input.compact) return available;
  return Math.min(available, CHAT_COMPOSER_MAX_HEIGHT);
}

export function updateComposerCapacity(
  previous: ComposerCapacity | undefined,
  input: ComposerGeometry,
): ComposerCapacity {
  "worklet";
  if (input.height <= 0 && previous) return previous;
  // Closing the keyboard moves the composer; it does not enlarge its editing
  // capacity. A subsequent keyboard opening supplies the next reservation.
  const keyboardReserve =
    input.keyboardShift > 0 ? input.keyboardShift : (previous?.keyboardReserve ?? 0);
  return {
    keyboardReserve,
    capacity: resolveComposerCapacity({ ...input, keyboardShift: keyboardReserve }),
  };
}
