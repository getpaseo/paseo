import type { PressableProps, StyleProp, ViewStyle } from "react-native";

export interface PressHighlightProps extends PressableProps {
  /** Native pressed style. Feedback and cancellation follow Pressable's press lifecycle. */
  highlightStyle?: StyleProp<ViewStyle>;
}
