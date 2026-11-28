import { forwardRef } from "react";
import { Pressable, type View } from "react-native";
import { usePressFill } from "./press-highlight.fill";
import type { PressHighlightProps } from "./press-highlight.types";

/** Immediate press highlight without mobile touch-scroll hold delay. */
export const PressHighlight = forwardRef<View, PressHighlightProps>(function PressHighlight(
  { highlightStyle, onHighlightChange, style, onPressIn, onPressOut, ...props },
  ref,
) {
  const fill = usePressFill({ style, highlightStyle, onPressIn, onPressOut, onHighlightChange });
  return <Pressable ref={ref} {...props} {...fill} />;
});
