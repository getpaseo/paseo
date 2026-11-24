import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/**
 * The action at a heading's end. It adds no height, so a heading with a button is as tall as one
 * without and both sit the same distance from their cards. The button stays centered on the title
 * and its hit area grows past the heading.
 */
export function HeadingTrailing({ children }: { children: ReactNode }) {
  if (children === null || children === undefined || children === false) return null;
  return <View style={styles.trailing}>{children}</View>;
}

const styles = StyleSheet.create({
  trailing: {
    height: 0,
    justifyContent: "center",
    // A long trailing gives way to the title.
    flexShrink: 1,
  },
});
