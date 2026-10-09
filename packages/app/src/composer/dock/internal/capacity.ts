interface ComposerGeometry {
  height: number;
  bottomInset: number;
  /** The keyboard also covers this space below its shift. */
  safeAreaBottom: number;
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
  // A bottom-anchored composer pads the safe area inside its own capacity.
  const available = input.centered
    ? Math.min(
        input.height - input.bottomInset,
        input.height - input.safeAreaBottom - input.keyboardShift,
      )
    : input.height - input.bottomInset - input.keyboardShift;
  return Math.max(0, available - 5);
}

/** Space below a centered form that the keyboard fills before the form moves. */
export function resolveCenteredClearance(input: {
  viewportHeight: number;
  safeAreaBottom: number;
  formBottom: number;
}): number {
  return Math.max(0, input.viewportHeight - input.safeAreaBottom - input.formBottom);
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
