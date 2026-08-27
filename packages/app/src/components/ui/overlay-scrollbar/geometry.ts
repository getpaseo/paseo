const DEFAULT_MIN_THUMB_SIZE = 36;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface OverlayScrollbarGeometryInput {
  viewportSize: number;
  contentSize: number;
  offset: number;
  minThumbSize?: number;
}

export interface OverlayScrollbarGeometry {
  isVisible: boolean;
  maxScrollOffset: number;
  thumbSize: number;
  thumbOffset: number;
  maxThumbOffset: number;
}

export function computeOverlayScrollbarGeometry(
  input: OverlayScrollbarGeometryInput,
): OverlayScrollbarGeometry {
  const viewportSize = Number.isFinite(input.viewportSize) ? Math.max(0, input.viewportSize) : 0;
  const contentSize = Number.isFinite(input.contentSize) ? Math.max(0, input.contentSize) : 0;
  const minThumbSize = Number.isFinite(input.minThumbSize)
    ? Math.max(0, input.minThumbSize ?? DEFAULT_MIN_THUMB_SIZE)
    : DEFAULT_MIN_THUMB_SIZE;
  const maxScrollOffset = Math.max(0, contentSize - viewportSize);

  if (maxScrollOffset <= 0 || viewportSize <= 0 || contentSize <= 0) {
    return {
      isVisible: false,
      maxScrollOffset: 0,
      thumbSize: 0,
      thumbOffset: 0,
      maxThumbOffset: 0,
    };
  }

  const thumbSize = clamp((viewportSize * viewportSize) / contentSize, minThumbSize, viewportSize);
  const maxThumbOffset = Math.max(0, viewportSize - thumbSize);
  const thumbOffset = (clamp(input.offset, 0, maxScrollOffset) / maxScrollOffset) * maxThumbOffset;

  return { isVisible: true, maxScrollOffset, thumbSize, thumbOffset, maxThumbOffset };
}

export function scrollOffsetFromThumbDrag(input: {
  startOffset: number;
  dragDelta: number;
  maxScrollOffset: number;
  maxThumbOffset: number;
}): number {
  if (input.maxScrollOffset <= 0 || input.maxThumbOffset <= 0) {
    return clamp(input.startOffset, 0, Math.max(0, input.maxScrollOffset));
  }
  return clamp(
    input.startOffset + input.dragDelta * (input.maxScrollOffset / input.maxThumbOffset),
    0,
    input.maxScrollOffset,
  );
}
