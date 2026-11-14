import { useCallback } from "react";
import type { GestureResponderEvent, PressableStateCallbackType } from "react-native";
import type { PressHighlightProps } from "./press-highlight.types";

type PressFillProps = Pick<
  PressHighlightProps,
  "style" | "highlightStyle" | "onPressIn" | "onPressOut" | "onHighlightChange"
>;

/** Paints `highlightStyle` while pressed and reports it, for the platforms that show a fill. */
export function usePressFill({
  style,
  highlightStyle,
  onPressIn,
  onPressOut,
  onHighlightChange,
}: PressFillProps) {
  const hasFill = highlightStyle != null;
  const fillStyle = useCallback(
    (state: PressableStateCallbackType) => [
      typeof style === "function" ? style(state) : style,
      state.pressed && highlightStyle,
    ],
    [style, highlightStyle],
  );
  const handlePressIn = useCallback(
    (event: GestureResponderEvent) => {
      if (hasFill) onHighlightChange?.(true);
      onPressIn?.(event);
    },
    [hasFill, onHighlightChange, onPressIn],
  );
  const handlePressOut = useCallback(
    (event: GestureResponderEvent) => {
      if (hasFill) onHighlightChange?.(false);
      onPressOut?.(event);
    },
    [hasFill, onHighlightChange, onPressOut],
  );
  return { style: fillStyle, onPressIn: handlePressIn, onPressOut: handlePressOut };
}
