import { useMemo, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { isWeb } from "@/constants/platform";
import { useWindowLayout } from "./context";
import { resolveWorkspaceActionPlacement, type DesktopDivisionLayout } from "./model";

/** Consume safe areas once; compact headers own their top inset. */
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
  const usesBar = resolveWorkspaceActionPlacement(useWindowLayout()) === "vertical-bar";
  // Wide browser layouts have no compact header to clear the standalone iOS status bar.
  // Native window chrome owns its own top band.
  const consumesTop = isWeb && !compact;
  const surfaceStyle = useMemo(
    () => [
      style,
      consumesTop && { paddingTop: insets.top },
      (!compact || usesBar) && { paddingLeft: insets.left, paddingRight: insets.right },
    ],
    [style, compact, usesBar, consumesTop, insets.top, insets.left, insets.right],
  );
  const contentInsets = useMemo(
    () => ({
      ...insets,
      ...(consumesTop ? { top: 0 } : {}),
      ...(compact && usesBar ? { left: 0, right: 0 } : {}),
    }),
    [compact, usesBar, consumesTop, insets],
  );
  return (
    <View style={surfaceStyle}>
      <SafeAreaInsetsContext.Provider value={contentInsets}>
        {children}
      </SafeAreaInsetsContext.Provider>
    </View>
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
