import { forwardRef } from "react";
import { Pressable, type View } from "react-native";
import { usePressFill } from "./press-highlight.fill";
import type { PressHighlightProps } from "./press-highlight.types";

// iOS. Android resolves `press-highlight.android.tsx`.

// Feedback waits this long so a scroll that claims the touch first cancels it.
const PRESS_DELAY_MS = 130;

export const PressHighlight = forwardRef<View, PressHighlightProps>(function PressHighlight(
  {
    highlightStyle,
    onHighlightChange,
    style,
    onPressIn,
    onPressOut,
    unstable_pressDelay = PRESS_DELAY_MS,
    ...props
  },
  ref,
) {
  const fill = usePressFill({ style, highlightStyle, onPressIn, onPressOut, onHighlightChange });
  return <Pressable {...props} {...fill} ref={ref} unstable_pressDelay={unstable_pressDelay} />;
});
