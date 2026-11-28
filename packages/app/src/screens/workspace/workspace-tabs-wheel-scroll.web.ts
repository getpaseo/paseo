import { useEffect, useRef, type RefObject } from "react";
import type { ScrollView } from "react-native";
import {
  resolveWorkspaceTabsScrollElement,
  resolveWorkspaceTabsWheelScroll,
} from "./workspace-tabs-wheel-scroll-core";

export * from "./workspace-tabs-wheel-scroll-core";

/** Let a plain vertical mouse wheel pan the overflowing workspace tab strip on web. */
export function useWorkspaceTabsWheelScroll(enabled: boolean): RefObject<ScrollView | null> {
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const node = resolveWorkspaceTabsScrollElement(scrollRef.current);
    if (!node) {
      return;
    }
    const handleWheel = (event: unknown) => {
      const wheelEvent = event as WheelEvent;
      const result = resolveWorkspaceTabsWheelScroll({
        scrollLeft: node.scrollLeft,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        deltaX: wheelEvent.deltaX,
        deltaY: wheelEvent.deltaY,
        deltaMode: wheelEvent.deltaMode,
        shiftKey: wheelEvent.shiftKey,
        ctrlKey: wheelEvent.ctrlKey,
      });
      if (!result.handled) {
        return;
      }
      node.scrollLeft = result.scrollLeft;
      wheelEvent.preventDefault();
    };

    node.addEventListener("wheel", handleWheel, { passive: false });
    return () => node.removeEventListener("wheel", handleWheel);
  }, [enabled]);

  return scrollRef;
}
