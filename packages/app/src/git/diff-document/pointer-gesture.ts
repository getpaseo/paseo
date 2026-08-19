const DRAG_THRESHOLD = 4;

export function hasPointerDragStarted(input: {
  startX: number;
  startY: number;
  x: number;
  y: number;
  alreadyDragging: boolean;
}): boolean {
  if (input.alreadyDragging) return true;
  return Math.hypot(input.x - input.startX, input.y - input.startY) >= DRAG_THRESHOLD;
}
