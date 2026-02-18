const DEFAULT_MIN_HANDLE_SIZE = 36;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type VerticalScrollbarGeometryInput = {
  viewportSize: number;
  contentSize: number;
  offset: number;
  minHandleSize?: number;
};

export type VerticalScrollbarGeometry = {
  isVisible: boolean;
  maxScrollOffset: number;
  handleSize: number;
  handleOffset: number;
  maxHandleOffset: number;
};

export function computeVerticalScrollbarGeometry(
  input: VerticalScrollbarGeometryInput
): VerticalScrollbarGeometry {
  const viewportSize = Number.isFinite(input.viewportSize)
    ? Math.max(0, input.viewportSize)
    : 0;
  const contentSize = Number.isFinite(input.contentSize)
    ? Math.max(0, input.contentSize)
    : 0;
  const minHandleSize = Number.isFinite(input.minHandleSize)
    ? Math.max(0, input.minHandleSize ?? DEFAULT_MIN_HANDLE_SIZE)
    : DEFAULT_MIN_HANDLE_SIZE;

  const maxScrollOffset = Math.max(0, contentSize - viewportSize);
  if (maxScrollOffset <= 0 || viewportSize <= 0 || contentSize <= 0) {
    return {
      isVisible: false,
      maxScrollOffset: 0,
      handleSize: 0,
      handleOffset: 0,
      maxHandleOffset: 0,
    };
  }

  const rawHandleSize = (viewportSize * viewportSize) / contentSize;
  const handleSize = clamp(rawHandleSize, minHandleSize, viewportSize);
  const maxHandleOffset = Math.max(0, viewportSize - handleSize);
  const clampedOffset = clamp(input.offset, 0, maxScrollOffset);
  const handleOffset =
    maxScrollOffset > 0
      ? (clampedOffset / maxScrollOffset) * maxHandleOffset
      : 0;

  return {
    isVisible: true,
    maxScrollOffset,
    handleSize,
    handleOffset,
    maxHandleOffset,
  };
}

export type ScrollOffsetFromDragDeltaInput = {
  startOffset: number;
  dragDelta: number;
  maxScrollOffset: number;
  maxHandleOffset: number;
};

export function computeScrollOffsetFromDragDelta(
  input: ScrollOffsetFromDragDeltaInput
): number {
  if (input.maxScrollOffset <= 0 || input.maxHandleOffset <= 0) {
    return clamp(input.startOffset, 0, Math.max(0, input.maxScrollOffset));
  }

  const scrollPerPixel = input.maxScrollOffset / input.maxHandleOffset;
  const nextOffset = input.startOffset + input.dragDelta * scrollPerPixel;
  return clamp(nextOffset, 0, input.maxScrollOffset);
}
