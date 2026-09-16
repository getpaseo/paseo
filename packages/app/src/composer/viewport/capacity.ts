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

/**
 * What the closed keyboard leaves behind. A docked chat composer retains its last
 * editing reservation so a capped draft does not expand over the stream. A form
 * that scrolls inside the constrained space releases it so the whole form is
 * visible again once the keyboard is gone.
 */
export type KeyboardReservePolicy = "retain" | "release";

export function resolveComposerCapacity(input: ComposerGeometry): number {
  "worklet";
  // A centered form grows upward by half its height. Reserve both halves so
  // translating it still leaves five layout points below the header.
  const clearance = input.keyboardShift + 5;
  const reservedSpace = input.centered ? clearance * 2 : clearance;
  return Math.max(0, input.height - input.bottomInset - reservedSpace);
}

export function updateComposerCapacity(
  previous: ComposerCapacity | undefined,
  input: ComposerGeometry,
  policy: KeyboardReservePolicy,
): ComposerCapacity {
  "worklet";
  if (input.height <= 0 && previous) return previous;
  // A subsequent keyboard opening always supplies the next reservation.
  const keyboardReserve =
    input.keyboardShift > 0 || policy === "release"
      ? input.keyboardShift
      : (previous?.keyboardReserve ?? 0);
  return {
    keyboardReserve,
    capacity: resolveComposerCapacity({ ...input, keyboardShift: keyboardReserve }),
  };
}
