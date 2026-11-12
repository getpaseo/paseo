import { useEffect, useRef, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { pinchTextZoom, wheelTextZoom, type TextZoomSurface } from "./model";
import { TextZoomPreviewBadge } from "./preview-badge";
import { TextZoomScope } from "./scope";
import { getTextZoom, setTextZoom, setTextZoomPreview, usePinchTextZoomEnabled } from "./store";

interface TextZoomAreaProps {
  surface: TextZoomSurface;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

// A wheel pinch has no end event. It counts as over once the wheel has been quiet this long.
const WHEEL_SETTLE_MS = 250;

// Safari's trackpad pinch. Not in the DOM typings.
interface SafariGestureEvent extends UIEvent {
  readonly scale: number;
}

/**
 * Browsers deliver a trackpad pinch as a wheel event with `ctrlKey` set, and Safari as
 * `gesturestart`/`gesturechange`/`gestureend`. Both are taken in the capture phase, before
 * xterm or the list scroll them, and default-prevented so the page does not zoom. The size
 * previews during the pinch and applies when it settles.
 */
export function TextZoomArea({ surface, style, children }: TextZoomAreaProps) {
  const enabled = usePinchTextZoomEnabled(surface);
  const ref = useRef<View>(null);

  useEffect(() => {
    const element = ref.current as unknown as HTMLElement | null;
    if (!enabled || !element) return;
    let pendingZoom: number | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let gestureStartZoom = 1;

    const preview = (zoom: number) => {
      pendingZoom = zoom;
      setTextZoomPreview({ surface, zoom });
    };
    const commit = () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = null;
      if (pendingZoom !== null) setTextZoom(surface, pendingZoom);
      pendingZoom = null;
      setTextZoomPreview(null);
    };

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      preview(wheelTextZoom(pendingZoom ?? getTextZoom(surface), event.deltaY));
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(commit, WHEEL_SETTLE_MS);
    };
    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStartZoom = getTextZoom(surface);
    };
    const handleGestureChange = (event: Event) => {
      event.preventDefault();
      preview(pinchTextZoom(gestureStartZoom, (event as SafariGestureEvent).scale));
    };
    const handleGestureEnd = (event: Event) => {
      event.preventDefault();
      commit();
    };

    const capture = { capture: true, passive: false } as const;
    element.addEventListener("wheel", handleWheel, capture);
    element.addEventListener("gesturestart", handleGestureStart, capture);
    element.addEventListener("gesturechange", handleGestureChange, capture);
    element.addEventListener("gestureend", handleGestureEnd, capture);
    return () => {
      element.removeEventListener("wheel", handleWheel, capture);
      element.removeEventListener("gesturestart", handleGestureStart, capture);
      element.removeEventListener("gesturechange", handleGestureChange, capture);
      element.removeEventListener("gestureend", handleGestureEnd, capture);
      if (settleTimer !== null) clearTimeout(settleTimer);
      if (pendingZoom !== null) setTextZoomPreview(null);
    };
  }, [enabled, surface]);

  return (
    <TextZoomScope surface={surface}>
      <View ref={ref} style={style}>
        {children}
        <TextZoomPreviewBadge surface={surface} />
      </View>
    </TextZoomScope>
  );
}
