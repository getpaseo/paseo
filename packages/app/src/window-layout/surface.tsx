import { useMemo, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  SafeAreaView,
  SafeAreaInsetsContext,
  useSafeAreaInsets,
  type Edges,
} from "react-native-safe-area-context";
import { useWindowLayout } from "./context";
import { resolveWorkspaceActionPlacement, type DesktopDivisionLayout } from "./model";

const HORIZONTAL_EDGES: Edges = ["left", "right"];
const NO_EDGES: Edges = [];

export function WindowLayoutSurface({
  children,
  compact,
  style,
}: {
  children: ReactNode;
  compact: boolean;
  style: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  const usesVerticalBarActions =
    resolveWorkspaceActionPlacement(useWindowLayout()) === "vertical-bar";
  const consumesHorizontalInsets = !compact || usesVerticalBarActions;
  const overridesCompactInsets = compact && consumesHorizontalInsets;
  // Wide sidebar allocation still needs window-space insets. Only compact
  // descendants use this override to avoid repeating the shell's clearance.
  const contentInsets = useMemo(
    () => (overridesCompactInsets ? { ...insets, left: 0, right: 0 } : insets),
    [overridesCompactInsets, insets],
  );
  return (
    <SafeAreaView style={style} edges={consumesHorizontalInsets ? HORIZONTAL_EDGES : NO_EDGES}>
      <SafeAreaInsetsContext.Provider value={contentInsets}>
        {children}
      </SafeAreaInsetsContext.Provider>
    </SafeAreaView>
  );
}

export function WindowLayoutDivisionGap({
  layout,
  sidebarVisible,
  compact,
}: {
  layout: DesktopDivisionLayout | null;
  sidebarVisible: boolean;
  compact: boolean;
}) {
  const style = useMemo(
    () => ({
      width: layout ? layout.gap + (sidebarVisible ? 0 : layout.sidebarWidth) : 0,
    }),
    [layout, sidebarVisible],
  );
  return !compact && layout ? <View style={[styles.divisionGap, style]} /> : null;
}

const styles = StyleSheet.create((theme) => ({
  divisionGap: {
    backgroundColor: theme.colors.surfaceSidebar,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
}));
