import { useEffect, type RefObject } from "react";
import type { View } from "react-native";
import { isWeb } from "@/constants/platform";

interface UseHoverSafeZoneParams {
  enabled: boolean;
  triggerRef: RefObject<View | null>;
  contentRef: RefObject<View | null>;
  onEnterSafeZone: () => void;
  onLeaveSafeZone: () => void;
}

interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

// Tracks the pointer's position relative to a hover card's "safe zone": the
// trigger, the content, and the rectangular bridge between them. The bridge
// lets the pointer cross the visual gap without dropping the hover. Fires
// `onEnterSafeZone` / `onLeaveSafeZone` on transitions only. Web-only; no-op
// on native.
export function useHoverSafeZone({
  enabled,
  triggerRef,
  contentRef,
  onEnterSafeZone,
  onLeaveSafeZone,
}: UseHoverSafeZoneParams): void {
  useEffect(() => {
    if (!isWeb || !enabled) return;

    // The pointer opened the card, so we start inside.
    let wasInside = true;

    function handlePointerMove(event: PointerEvent) {
      const triggerNode = triggerRef.current as unknown as Element | null;
      const contentNode = contentRef.current as unknown as Element | null;
      const triggerRect = triggerNode ? triggerNode.getBoundingClientRect() : null;
      const contentRect = contentNode ? contentNode.getBoundingClientRect() : null;

      const inside = isInsideSafeZone(triggerRect, contentRect, event.clientX, event.clientY);
      if (inside === wasInside) return;
      wasInside = inside;
      if (inside) onEnterSafeZone();
      else onLeaveSafeZone();
    }

    document.addEventListener("pointermove", handlePointerMove);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
    };
  }, [enabled, triggerRef, contentRef, onEnterSafeZone, onLeaveSafeZone]);
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

  // Bridge: the horizontal strip connecting trigger and content, stretched
  // vertically to span both. If they overlap horizontally there's no bridge.
  const bridgeLeft = Math.min(trigger.right, content.right);
  const bridgeRight = Math.max(trigger.left, content.left);
  if (bridgeLeft >= bridgeRight) return false;
  const bridgeTop = Math.min(trigger.top, content.top);
  const bridgeBottom = Math.max(trigger.bottom, content.bottom);
  return x >= bridgeLeft && x <= bridgeRight && y >= bridgeTop && y <= bridgeBottom;
}
