import { useMemo, useRef, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { TextZoomSurface } from "./model";
import { startTextZoomPinch, type TextZoomPinchSession } from "./pinch-session";
import { TextZoomPreviewBadge } from "./preview-badge";
import { TextZoomScope } from "./scope";
import { setTextZoomPinchFocal, usePinchTextZoomEnabled } from "./store";

interface TextZoomAreaProps {
  surface: TextZoomSurface;
  style?: StyleProp<ViewStyle>;
  /**
   * "content" when the content recognizes its own pinch, as the native terminal does from the
   * touches its responder already owns. The area then only scopes the zoom and shows the badge.
   */
  pinch?: "area" | "content";
  children: ReactNode;
}

/**
 * A surface whose text size a two-finger pinch changes, once a plugin enables it. The size changes
 * live in 5% steps and is saved when the fingers lift.
 *
 * The pinch needs two pointers, so one-finger scrolling, long-press selection and taps still
 * reach the content. When it activates, gesture-handler cancels the content's JS touch responder.
 */
export function TextZoomArea({ surface, style, pinch = "area", children }: TextZoomAreaProps) {
  const enabled = usePinchTextZoomEnabled(surface) && pinch === "area";
  const viewRef = useRef<View>(null);
  const sessionRef = useRef<TextZoomPinchSession | null>(null);

  const gesture = useMemo(
    () =>
      Gesture.Pinch()
        .enabled(enabled)
        .runOnJS(true)
        .onStart((event) => {
          sessionRef.current?.end();
          sessionRef.current = startTextZoomPinch(surface, null);
          const { focalX, focalY } = event;
          viewRef.current?.measureInWindow((x, y) => {
            setTextZoomPinchFocal({ x: x + focalX, y: y + focalY });
          });
        })
        .onUpdate((event) => {
          // Android sends one more update after a finger lifts, scaled from the remaining one.
          if (event.numberOfPointers < 2) return;
          sessionRef.current?.scale(event.scale);
        })
        .onFinalize(() => {
          sessionRef.current?.end();
          sessionRef.current = null;
        }),
    [enabled, surface],
  );

  const content = (
    <View ref={viewRef} collapsable={false} style={style}>
      {children}
      <TextZoomPreviewBadge surface={surface} />
    </View>
  );
  return (
    <TextZoomScope surface={surface}>
      {pinch === "area" ? <GestureDetector gesture={gesture}>{content}</GestureDetector> : content}
    </TextZoomScope>
  );
}
