import { useEffect, useRef, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { wheelTextZoom, type TextZoomSurface } from "./model";
import { startTextZoomPinch, type TextZoomPinchSession } from "./pinch-session";
import { TextZoomPreviewBadge } from "./preview-badge";
import { TextZoomScope } from "./scope";
import { usePinchTextZoomEnabled } from "./store";

interface TextZoomAreaProps {
  surface: TextZoomSurface;
  style?: StyleProp<ViewStyle>;
  /** Native only; on web every surface takes the browser's pinch here. */
  pinch?: "area" | "content";
  children: ReactNode;
}

// A wheel pinch has no end event. It counts as over once the wheel has been quiet this long.
export const WHEEL_PINCH_SETTLE_MS = 150;

// Safari's trackpad pinch. Not in the DOM typings.
interface SafariGestureEvent extends UIEvent {
  readonly scale: number;
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * Browsers deliver a trackpad pinch as a wheel event with `ctrlKey` set, and Safari as
 * `gesturestart`/`gesturechange`/`gestureend`. Both are taken in the capture phase, before
 * xterm, CodeMirror or the list scroll them, and default-prevented so the page does not zoom.
 * The size changes live in 5% steps and is saved when the pinch ends.
 */
export function TextZoomArea({ surface, style, children }: TextZoomAreaProps) {
  const enabled = usePinchTextZoomEnabled(surface);
  const ref = useRef<View>(null);

  useEffect(() => {
    const element = ref.current as unknown as HTMLElement | null;
    if (!enabled || !element) return;
    let session: TextZoomPinchSession | null = null;
    let wheelZoom = 1;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const end = () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = null;
      session?.end();
      session = null;
    };

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (!session) {
        session = startTextZoomPinch(surface, { x: event.clientX, y: event.clientY });
        wheelZoom = session.startZoom;
      }
      wheelZoom = wheelTextZoom(wheelZoom, event.deltaY);
      session.zoomTo(wheelZoom);
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(end, WHEEL_PINCH_SETTLE_MS);
    };
    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      const gesture = event as SafariGestureEvent;
      end();
      session = startTextZoomPinch(surface, { x: gesture.clientX, y: gesture.clientY });
    };
    const handleGestureChange = (event: Event) => {
      event.preventDefault();
      session?.scale((event as SafariGestureEvent).scale);
    };
    const handleGestureEnd = (event: Event) => {
      event.preventDefault();
      end();
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
      end();
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
