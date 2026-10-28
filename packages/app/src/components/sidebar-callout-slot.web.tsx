import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SidebarCalloutViewport } from "@/contexts/sidebar-callout-context";

export function SidebarCalloutSlot() {
  return (
    <View style={styles.slot} collapsable={false}>
      <SidebarCalloutViewport />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  slot: {
    width: "100%",
  },
}));
