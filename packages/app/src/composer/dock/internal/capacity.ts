interface ComposerGeometry {
  height: number;
  bottomInset: number;
  keyboardShift: number;
  centered: boolean;
}

export interface ComposerCapacity {
  keyboardReserve: number;
  capacity: number;
}

export function resolveComposerCapacity(input: ComposerGeometry): number {
  "worklet";
  // A centered form only translates by the keyboard overlap, so once the keyboard
  // reaches it the form sits on the keyboard and fits above it, not twice over.
  const available = input.centered
    ? Math.min(input.height - input.bottomInset, input.height - input.keyboardShift)
    : input.height - input.bottomInset - input.keyboardShift;
  return Math.max(0, available - 5);
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
