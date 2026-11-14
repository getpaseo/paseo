import { useCallback, useRef, useState } from "react";
import type {
  GestureResponderEvent,
  PressableStateCallbackType,
  StyleProp,
  ViewStyle,
} from "react-native";
import type { PressHighlightProps } from "./press-highlight.types";

type PressFillProps = Pick<
  PressHighlightProps,
  "style" | "highlightStyle" | "onPressIn" | "onPressOut" | "onHighlightChange"
>;

/**
 * Paints `highlightStyle` while pressed and reports it, for the platforms that show a fill. A press
 * keeps the fill it started with until it ends, so the paint and the report always agree, even when
 * the caller adds or removes `highlightStyle` mid-press.
 */
export function usePressFill({
  style,
  highlightStyle,
  onPressIn,
  onPressOut,
  onHighlightChange,
}: PressFillProps) {
  const [pressFill, setPressFill] = useState<StyleProp<ViewStyle> | null>(null);
  // Pressable can call the press-out handler from the render that started the press.
  const reportedRef = useRef(false);
  const fillStyle = useCallback(
    (state: PressableStateCallbackType) => [
      typeof style === "function" ? style(state) : style,
      pressFill,
    ],
    [style, pressFill],
  );
  const handlePressIn = useCallback(
    (event: GestureResponderEvent) => {
      if (highlightStyle != null) {
        setPressFill(highlightStyle);
        reportedRef.current = true;
        onHighlightChange?.(true);
      }
      onPressIn?.(event);
    },
    [highlightStyle, onHighlightChange, onPressIn],
  );
  const handlePressOut = useCallback(
    (event: GestureResponderEvent) => {
      setPressFill(null);
      if (reportedRef.current) {
        reportedRef.current = false;
        onHighlightChange?.(false);
      }
      onPressOut?.(event);
    },
    [onHighlightChange, onPressOut],
  );
  return { style: fillStyle, onPressIn: handlePressIn, onPressOut: handlePressOut };
}
