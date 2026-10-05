export interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface HoverSafeZoneTrackerInput {
  getTriggerRect: () => RectLike | null;
  getContentRect: () => RectLike | null;
  onEnterSafeZone: () => void;
  onLeaveSafeZone: () => void;
}

export interface HoverSafeZoneTracker {
  pointerMoved(x: number, y: number): void;
  pointerLeftWindow(): void;
  windowBlurred(): void;
}

// Tracks the pointer's position relative to a hover card's "safe zone": the
// trigger, the content, and the rectangular bridge between them. The bridge
// lets the pointer cross the visual gap without dropping the hover. Fires
// `onEnterSafeZone` on every move that lands inside (so consumers can refresh
// timers) and `onLeaveSafeZone` once per inside→outside transition.
export function createHoverSafeZoneTracker(input: HoverSafeZoneTrackerInput): HoverSafeZoneTracker {
  const { getTriggerRect, getContentRect, onEnterSafeZone, onLeaveSafeZone } = input;
  // The pointer opened the card, so we start inside.
  let wasInside = true;

  function leave(): void {
    if (!wasInside) return;
    wasInside = false;
    onLeaveSafeZone();
  }

  return {
    pointerMoved(x, y) {
      if (isInsideSafeZone(getTriggerRect(), getContentRect(), x, y)) {
        wasInside = true;
        onEnterSafeZone();
        return;
      }
      leave();
    },
    pointerLeftWindow: leave,
    windowBlurred: leave,
  };
}

function isInsideRect(rect: RectLike | null, x: number, y: number): boolean {
  if (!rect) return false;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function isInsideSafeZone(
  trigger: RectLike | null,
  content: RectLike | null,
  x: number,
  y: number,
): boolean {
  if (isInsideRect(trigger, x, y)) return true;
  if (isInsideRect(content, x, y)) return true;
  if (!trigger || !content) return false;
  return (
    isInsideHorizontalBridge(trigger, content, x, y) ||
    isInsideVerticalBridge(trigger, content, x, y)
  );
}

// A card beside its trigger: the strip between them, stretched vertically to
// span both. If they overlap horizontally there's no horizontal bridge.
function isInsideHorizontalBridge(
  trigger: RectLike,
  content: RectLike,
  x: number,
  y: number,
): boolean {
  const bridgeLeft = Math.min(trigger.right, content.right);
  const bridgeRight = Math.max(trigger.left, content.left);
  if (bridgeLeft >= bridgeRight) return false;
  const bridgeTop = Math.min(trigger.top, content.top);
  const bridgeBottom = Math.max(trigger.bottom, content.bottom);
  return x >= bridgeLeft && x <= bridgeRight && y >= bridgeTop && y <= bridgeBottom;
}

// A card above or below its trigger: the strip between them, stretched
// horizontally to span both. If they overlap vertically there's no vertical bridge.
function isInsideVerticalBridge(
  trigger: RectLike,
  content: RectLike,
  x: number,
  y: number,
): boolean {
  const bridgeTop = Math.min(trigger.bottom, content.bottom);
  const bridgeBottom = Math.max(trigger.top, content.top);
  if (bridgeTop >= bridgeBottom) return false;
  const bridgeLeft = Math.min(trigger.left, content.left);
  const bridgeRight = Math.max(trigger.right, content.right);
  return x >= bridgeLeft && x <= bridgeRight && y >= bridgeTop && y <= bridgeBottom;
}
