interface ComposerGeometry {
  height: number;
  bottomInset: number;
  /** The keyboard also covers this space below its shift. */
  safeAreaBottom: number;
  keyboardShift: number;
  /** A docked composer rises this much beyond the keyboard shift; see the placement. */
  keyboardGap: number;
  centered: boolean;
}

export interface ComposerCapacity {
  keyboardReserve: number;
  capacity: number;
  /** The stationary viewport; a fullscreen composer fills it and lays out the keyboard itself. */
  viewportHeight: number;
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
    : input.height -
      input.bottomInset -
      input.keyboardShift -
      Math.min(input.keyboardGap, input.keyboardShift);
  return Math.max(0, available - 5);
}

export interface ComposerBottomPlacement {
  /** The composer's distance from the window bottom with the keyboard closed. */
  restingPadding: number;
  /** How much further than the keyboard's safe-area overlap the composer rises. */
  keyboardGap: number;
}

/**
 * One bottom distance for the docked composer: the safe-area bottom, never closer to
 * the edge than the content spacing. With the keyboard open it keeps the content
 * spacing above the keyboard.
 */
export function resolveComposerBottomPlacement(input: {
  safeAreaBottom: number;
  contentSpacing: number;
}): ComposerBottomPlacement {
  const restingPadding = Math.max(input.safeAreaBottom, input.contentSpacing);
  return {
    restingPadding,
    keyboardGap: input.safeAreaBottom + input.contentSpacing - restingPadding,
  };
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
    viewportHeight: input.height,
  };
}

/** Compact editing leaves conversation space above the complete composer. */
export function resolveInlineComposerCapacity(
  capacity: number | undefined,
  compact: boolean,
): number | undefined {
  "worklet";
  if (capacity === undefined) return undefined;
  return compact ? capacity * 0.6 : capacity;
}

export interface ComposerSlotLayout {
  compact: boolean;
  fullscreen: boolean;
}

/** The bound on the composer slot: inline capacity, or the whole viewport in fullscreen. */
export function resolveComposerSlotCapacity(
  sizing: ComposerCapacity | undefined,
  layout: ComposerSlotLayout,
): number | undefined {
  "worklet";
  if (sizing === undefined) return undefined;
  if (layout.fullscreen) return sizing.viewportHeight;
  return resolveInlineComposerCapacity(sizing.capacity, layout.compact);
}
