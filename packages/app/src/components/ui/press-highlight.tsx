import { forwardRef } from "react";
import { Pressable } from "react-native";
import type { View } from "react-native";
import { usePressFill } from "./press-highlight.fill";
import type { PressHighlightProps } from "./press-highlight.types";

export const PressHighlight = forwardRef<View, PressHighlightProps>(function PressHighlight(
  { highlightStyle, onHighlightChange, style, onPressIn, onPressOut, ...props },
  ref,
) {
  const fill = usePressFill({ style, highlightStyle, onPressIn, onPressOut, onHighlightChange });
  return <Pressable ref={ref} {...props} {...fill} />;
});
