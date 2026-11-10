import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/**
 * Align the rail with the expanded caret's left edge. Keep the content offset fixed so
 * expanded tool cards stay in place, with a gap between their border and the rail.
 */
const RAIL_LEFT = 1;
const RAIL_WIDTH = 1;
export const INDENT_RAIL_CONTENT_OFFSET = 21;

/** Indents opened chat rows under the summary that collapsed them, behind a vertical line. */
export function IndentRail({
  children,
  style,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.rail, style]}>{children}</View>;
}

const styles = StyleSheet.create((theme) => ({
  rail: {
    marginLeft: RAIL_LEFT,
    paddingLeft: INDENT_RAIL_CONTENT_OFFSET - RAIL_LEFT - RAIL_WIDTH,
    borderLeftWidth: RAIL_WIDTH,
    borderLeftColor: theme.colors.border,
  },
}));
