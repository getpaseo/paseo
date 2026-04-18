import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/**
 * Edge-to-edge separator line for sidebars. Must render outside any horizontally
 * padded container so the line runs the full sidebar width — matching the
 * separator beneath the workspace sidebar's "New agent" header.
 */
export function SidebarSeparator() {
  return <View style={styles.line} />;
}

const styles = StyleSheet.create((theme) => ({
  line: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
}));
