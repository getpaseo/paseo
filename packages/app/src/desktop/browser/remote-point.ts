export interface RemotePoint {
  x: number;
  y: number;
}

export interface RemoteFrameRect extends RemotePoint {
  width: number;
  height: number;
}

interface PointerEventLike {
  nativeEvent: {
    locationX?: number;
    locationY?: number;
    offsetX?: number;
    offsetY?: number;
  };
}

function getPointerPosition(event: PointerEventLike): RemotePoint | null {
  const x = event.nativeEvent.locationX ?? event.nativeEvent.offsetX;
  const y = event.nativeEvent.locationY ?? event.nativeEvent.offsetY;
  return typeof x === "number" && typeof y === "number" ? { x, y } : null;
}

export function getContainedFrameRect(
  frame: { width: number; height: number } | null,
  viewportSize: { width: number; height: number },
): RemoteFrameRect | null {
  if (!frame?.width || !frame.height || !viewportSize.width || !viewportSize.height) return null;
  const scale = Math.min(viewportSize.width / frame.width, viewportSize.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  return {
    x: (viewportSize.width - width) / 2,
    y: (viewportSize.height - height) / 2,
    width,
    height,
  };
}

/** Maps a pointer in the viewport to a point in the remote page frame. */
export function getRemotePoint(
  event: PointerEventLike,
  frame: { width: number; height: number } | null,
  viewportSize: { width: number; height: number },
): RemotePoint | null {
  const position = getPointerPosition(event);
  const rect = getContainedFrameRect(frame, viewportSize);
  if (!position || !frame || !rect) return null;
  const scale = rect.width / frame.width;
  return {
    x: Math.max(0, Math.min(frame.width, (position.x - rect.x) / scale)),
    y: Math.max(0, Math.min(frame.height, (position.y - rect.y) / scale)),
  };
}
