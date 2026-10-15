import type { SidebarIcon, SidebarRowProps } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useRef } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { SidebarSeparator as AppSidebarSeparator } from "@/components/sidebar/sidebar-separator";
import { resolvePluginIcon } from "../icons";
import { useSidebarItemFrame } from "./frame";

function resolveIcon(icon: SidebarIcon) {
  return typeof icon === "string" ? resolvePluginIcon(icon) : icon;
}

/**
 * An item may render several rows. Any press inside a row, on the row or on its trailing content,
 * makes that row the popover anchor: the capture-phase responder check runs before the pressed
 * child claims the touch (native and web), and returns false so the child still handles it.
 */
export function SidebarRow({ id, icon, label, onPress, active, trailing }: SidebarRowProps) {
  const frame = useSidebarItemFrame("SidebarRow");
  const { anchorTo, offerAnchor, releaseAnchor } = frame;
  const rowRef = useRef<View | null>(null);
  useEffect(() => {
    const node = rowRef.current;
    offerAnchor(node);
    return () => releaseAnchor(node);
  }, [offerAnchor, releaseAnchor]);
  const anchorHere = useCallback(() => {
    anchorTo(rowRef.current);
    return false;
  }, [anchorTo]);
  // Keyboard activation skips the responder system, so the row's own press anchors as well.
  const handlePress = useCallback(() => {
    anchorTo(rowRef.current);
    onPress();
  }, [anchorTo, onPress]);
  return (
    <View ref={rowRef} collapsable={false} onStartShouldSetResponderCapture={anchorHere}>
      <SidebarHeaderRow
        icon={icon ? resolveIcon(icon) : null}
        label={label ?? frame.title}
        onPress={handlePress}
        isActive={active}
        trailing={trailing}
        testID={id ? `${frame.testID}-${id}` : frame.testID}
        variant={frame.section === "footer" ? "inline" : "compact"}
      />
    </View>
  );
}

/** The sidebar's separator line, run edge to edge across the section like the app's own. */
export function SidebarSeparator() {
  const frame = useSidebarItemFrame("SidebarSeparator");
  return (
    <View style={frame.section === "footer" ? styles.footer : styles.header}>
      <AppSidebarSeparator />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Header rows fill the sidebar width; the gap between them is 2px.
  header: {
    marginVertical: theme.spacing[1],
  },
  // The footer pads its rows by `spacing[2]` and spaces them `spacing[1]` apart.
  footer: {
    marginHorizontal: -theme.spacing[2],
    marginVertical: theme.spacing[0.5],
  },
}));
