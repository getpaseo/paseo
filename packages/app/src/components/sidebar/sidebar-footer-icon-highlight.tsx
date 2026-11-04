import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/**
 * The round highlight behind a sidebar footer icon. It is a layer inside the button rather than a
 * radius on it: web hit-testing follows `border-radius`, so a round button would stop taking taps
 * near the corners of its square finger-sized target.
 */
export function SidebarFooterIconHighlight({ visible }: { visible: boolean }) {
  return <View pointerEvents="none" style={[styles.highlight, visible && styles.visible]} />;
}

const styles = StyleSheet.create((theme) => ({
  highlight: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: theme.borderRadius.full,
  },
  visible: {
    backgroundColor: theme.colors.interactionHighlight,
  },
}));
