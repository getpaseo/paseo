import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SidebarCalloutViewport } from "@/contexts/sidebar-callout-context";

// Only callouts marked `native` show here: the rest are about the desktop app.
export function SidebarCalloutSlot() {
  return (
    <View style={styles.slot} collapsable={false}>
      <SidebarCalloutViewport nativeOnly />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  slot: {
    width: "100%",
  },
}));
