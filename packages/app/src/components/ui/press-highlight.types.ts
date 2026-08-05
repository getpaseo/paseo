import type { PressableProps, StyleProp, ViewStyle } from "react-native";

export interface PressHighlightProps extends PressableProps {
  /**
   * What the native finger-down surface is painted with — a background colour, an opacity.
   * Desktop hover remains owned by the caller.
   *
   * Shape is not part of it: the highlight takes its corners from the pressable's own `style`, so
   * a rounded row gets a rounded flash without restating the radius. Set a corner here only to
   * depart from the row's shape on purpose.
   */
  highlightStyle?: StyleProp<ViewStyle>;
}
