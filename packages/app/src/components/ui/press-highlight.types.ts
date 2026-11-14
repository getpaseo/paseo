import type { PressableProps, StyleProp, ViewStyle } from "react-native";

export interface PressHighlightProps extends PressableProps {
  /**
   * The pressed fill. iOS and web paint it while the pressable is pressed; Android draws the
   * platform ripple over the content instead. Callers do not paint their own pressed fill.
   */
  highlightStyle?: StyleProp<ViewStyle>;
  /**
   * Reports when `highlightStyle` starts and stops painting, so content that knocks out of the
   * surface (a badge ring, a text scrim) can match it. The Android ripple tints over the content,
   * so it never reports a highlight.
   */
  onHighlightChange?: (highlighted: boolean) => void;
}
