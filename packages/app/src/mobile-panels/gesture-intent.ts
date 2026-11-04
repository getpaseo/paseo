export type MobilePanelGestureDirection = -1 | 1;
export type MobilePanelGestureIntent = "activate" | "fail" | "wait";

export interface MobilePanelGestureExclusion {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MOBILE_PANEL_EDGE_SWIPE_WIDTH = 32;

interface MobilePanelOpenGestureStart {
  x: number;
  y: number;
  direction: MobilePanelGestureDirection;
  windowWidth: number;
  exclusions: MobilePanelGestureExclusion[];
}

export function canStartMobilePanelOpenGesture(input: MobilePanelOpenGestureStart): boolean {
  "worklet";
  const startsAtEdge =
    input.direction === 1
      ? input.x <= MOBILE_PANEL_EDGE_SWIPE_WIDTH
      : input.x >= input.windowWidth - MOBILE_PANEL_EDGE_SWIPE_WIDTH;
  if (!startsAtEdge) return false;
  return !input.exclusions.some(
    (area) =>
      input.x >= area.x &&
      input.x <= area.x + area.width &&
      input.y >= area.y &&
      input.y < area.y + area.height,
  );
}

export function resolveMobilePanelGestureIntent(input: {
  deltaX: number;
  deltaY: number;
  direction: MobilePanelGestureDirection;
  openGesturesBlocked: boolean;
}): MobilePanelGestureIntent {
  "worklet";
  if (input.openGesturesBlocked) {
    return "fail";
  }
  const directedDelta = input.deltaX * input.direction;
  const absDeltaX = Math.abs(input.deltaX);
  const absDeltaY = Math.abs(input.deltaY);
  if (directedDelta <= -10 || (absDeltaY > 10 && absDeltaY > absDeltaX)) {
    return "fail";
  }
  if (directedDelta >= 15 && absDeltaX > absDeltaY) {
    return "activate";
  }
  return "wait";
}
