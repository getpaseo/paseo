export interface ComposerHeightBounds {
  minHeight: number;
  maxHeight: number;
}

export type NativeComposerHeightEvent =
  | { type: "content-measured"; height: number }
  | { type: "text-changed"; previousText: string; nextText: string }
  | { type: "remeasure" }
  | { type: "reset" };

export function clampComposerHeight(height: number, bounds: ComposerHeightBounds): number {
  return Math.max(bounds.minHeight, Math.min(bounds.maxHeight, height));
}

export function reduceNativeComposerHeight(
  currentHeight: number,
  bounds: ComposerHeightBounds,
  event: NativeComposerHeightEvent,
): number {
  if (event.type === "reset") return bounds.minHeight;

  if (event.type === "content-measured") {
    if (!Number.isFinite(event.height) || event.height <= 0) return currentHeight;
    return clampComposerHeight(event.height, bounds);
  }

  if (event.type === "remeasure") {
    const direction = currentHeight <= bounds.minHeight ? 1 : -1;
    return clampComposerHeight(currentHeight + direction, bounds);
  }

  if (event.nextText.length >= event.previousText.length || currentHeight <= bounds.minHeight) {
    return currentHeight;
  }

  // Fabric can retain the old UITextView content size after deletion while the text still fits
  // inside its frame. Changing that frame invalidates layout; the following content-size event
  // supplies the real smaller height.
  return reduceNativeComposerHeight(currentHeight, bounds, { type: "remeasure" });
}
