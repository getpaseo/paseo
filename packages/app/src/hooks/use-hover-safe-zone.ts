import { useEffect, type RefObject } from "react";
import type { View } from "react-native";
import { isWeb } from "@/constants/platform";
import { createHoverSafeZoneTracker, type RectLike } from "@/hooks/hover-safe-zone-tracker";

interface UseHoverSafeZoneParams {
  enabled: boolean;
  triggerRef: RefObject<View | null>;
  contentRef: RefObject<View | null>;
  onEnterSafeZone: () => void;
  onLeaveSafeZone: () => void;
}

function readRect(ref: RefObject<View | null>): RectLike | null {
  const node = ref.current as unknown as Element | null;
  return node ? node.getBoundingClientRect() : null;
}

export function useHoverSafeZone({
  enabled,
  triggerRef,
  contentRef,
  onEnterSafeZone,
  onLeaveSafeZone,
}: UseHoverSafeZoneParams): void {
  useEffect(() => {
    if (!isWeb || !enabled) return;

    const tracker = createHoverSafeZoneTracker({
      getTriggerRect: () => readRect(triggerRef),
      getContentRect: () => readRect(contentRef),
      onEnterSafeZone,
      onLeaveSafeZone,
    });

    function handlePointerMove(event: PointerEvent) {
      tracker.pointerMoved(event.clientX, event.clientY);
    }

    function handlePointerOut(event: PointerEvent) {
      if (event.relatedTarget === null) {
        tracker.pointerLeftWindow();
      }
    }

    function handleBlur() {
      tracker.windowBlurred();
    }

    document.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerout", handlePointerOut);
    window.addEventListener("blur", handleBlur);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerout", handlePointerOut);
      window.removeEventListener("blur", handleBlur);
    };
  }, [enabled, triggerRef, contentRef, onEnterSafeZone, onLeaveSafeZone]);
}
