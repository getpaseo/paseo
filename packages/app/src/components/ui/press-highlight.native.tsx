import { forwardRef, useCallback } from "react";
import { Pressable, type PressableStateCallbackType, type View } from "react-native";
import type { PressHighlightProps } from "./press-highlight.types";

export const PressHighlight = forwardRef<View, PressHighlightProps>(function PressHighlight(
  { highlightStyle, style, unstable_pressDelay = 130, ...props },
  ref,
) {
  // Give the scroll view time to claim a pan before Pressable activates its feedback.
  const pressStyle = useCallback(
    (state: PressableStateCallbackType) => [
      typeof style === "function" ? style(state) : style,
      state.pressed && highlightStyle,
    ],
    [style, highlightStyle],
  );

  return (
    <Pressable {...props} ref={ref} unstable_pressDelay={unstable_pressDelay} style={pressStyle} />
  );
});
