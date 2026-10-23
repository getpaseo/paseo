import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SidebarCalloutViewport } from "@/contexts/sidebar-callout-context";

/**
 * `nativeOnly` limits the slot to callouts marked `native`. Native apps and every compact
 * sidebar pass it: the other callouts are about the desktop app.
 */
export function SidebarCalloutSlot({ nativeOnly }: { nativeOnly: boolean }) {
  return (
    <View style={styles.slot} collapsable={false}>
      <SidebarCalloutViewport nativeOnly={nativeOnly} />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  slot: {
    width: "100%",
  },
}));
