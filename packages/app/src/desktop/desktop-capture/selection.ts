interface Point {
  x: number;
  y: number;
}
interface Size {
  width: number;
  height: number;
}
export function captureSelection(start: Point, end: Point, size: Size) {
  const x = Math.max(0, Math.min(size.width, Math.min(start.x, end.x)));
  const y = Math.max(0, Math.min(size.height, Math.min(start.y, end.y)));
  const right = Math.max(x, Math.min(size.width, Math.max(start.x, end.x)));
  const bottom = Math.max(y, Math.min(size.height, Math.max(start.y, end.y)));
  if (right - x < 2 || bottom - y < 2) return null;
  return {
    x: Math.floor(x),
    y: Math.floor(y),
    width: Math.ceil(right - x),
    height: Math.ceil(bottom - y),
  };
}
