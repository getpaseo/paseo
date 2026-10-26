import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/**
 * Collapsed chat rows badge their summary with an icon whose center sits 7px into the content
 * column (`ExpandableBadge` bleeds 13px left, then 1px border, 8px padding, 22px icon). The rail
 * hangs from that center so opened rows read as children of the line that opened them.
 */
const RAIL_LEFT = 7;
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
