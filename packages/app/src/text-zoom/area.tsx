import { useMemo, useRef, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { pinchTextZoom, type TextZoomSurface } from "./model";
import { TextZoomPreviewBadge } from "./preview-badge";
import { TextZoomScope } from "./scope";
import { getTextZoom, setTextZoom, setTextZoomPreview, usePinchTextZoomEnabled } from "./store";

interface TextZoomAreaProps {
  surface: TextZoomSurface;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

/**
 * A surface whose text size a two-finger pinch changes, once a plugin enables it. The pinch only
 * previews the size; it applies when the fingers lift, so a long transcript lays out once and a
 * terminal resizes its PTY once.
 *
 * The pinch needs two pointers, so one-finger scrolling, long-press selection and taps still
 * reach the content. When it activates, gesture-handler cancels the content's JS touch
 * responder, which ends a terminal selection gesture that had started.
 */
export function TextZoomArea({ surface, style, children }: TextZoomAreaProps) {
  const enabled = usePinchTextZoomEnabled(surface);
  const startZoomRef = useRef(1);
  const pendingZoomRef = useRef<number | null>(null);

  const gesture = useMemo(
    () =>
      Gesture.Pinch()
        .enabled(enabled)
        .runOnJS(true)
        .onStart(() => {
          startZoomRef.current = getTextZoom(surface);
          pendingZoomRef.current = null;
        })
        .onUpdate((event) => {
          // Android sends one more update after a finger lifts, scaled from the remaining one.
          if (event.numberOfPointers < 2) return;
          const zoom = pinchTextZoom(startZoomRef.current, event.scale);
          pendingZoomRef.current = zoom;
          setTextZoomPreview({ surface, zoom });
        })
        .onEnd((_event, success) => {
          const zoom = pendingZoomRef.current;
          if (success && zoom !== null) setTextZoom(surface, zoom);
        })
        .onFinalize(() => {
          pendingZoomRef.current = null;
          setTextZoomPreview(null);
        }),
    [enabled, surface],
  );

  return (
    <TextZoomScope surface={surface}>
      <GestureDetector gesture={gesture}>
        <View collapsable={false} style={style}>
          {children}
          <TextZoomPreviewBadge surface={surface} />
        </View>
      </GestureDetector>
    </TextZoomScope>
  );
}
