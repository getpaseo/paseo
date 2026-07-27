import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export interface BiAxisCodeScrollProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * One overflow:auto viewport so the horizontal scrollbar stays pinned to the
 * bottom of the card (and the vertical bar to the right edge), instead of
 * trailing the tall nested content.
 */
export function BiAxisCodeScroll({
  children,
  style,
  contentContainerStyle,
  testID,
}: BiAxisCodeScrollProps) {
  return (
    <View style={[styles.viewport, style]} testID={testID}>
      <View style={[styles.content, contentContainerStyle]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  viewport: {
    overflowX: "auto",
    overflowY: "auto",
    minHeight: 0,
  },
  content: {
    alignSelf: "flex-start",
    minWidth: "100%",
  },
});
