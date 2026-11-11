import { useCallback, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View, type NativeSyntheticEvent, type ViewProps } from "react-native";
import { requireNativeViewManager } from "expo-modules-core";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { TopBandContext, WindowLayoutContext, useWindowLayout } from "./context";
import { resolveSafeAreaInsets, resolveTopBand, type WindowLayout } from "./model";

export { useWindowLayout } from "./context";
export { WindowLayoutActions, WindowLayoutActionsHost } from "./actions";
export { WindowLayoutSurface, WindowLayoutDivisionGap } from "./surface";
export { useTopBand } from "./context";
export {
  resolveDesktopDivisionLayout,
  resolveWorkspaceActionPlacement,
  resolveWorkspaceBarActions,
} from "./model";
export type { DesktopDivisionLayout, TopBand, WindowLayout, WindowLayoutRect } from "./model";

const GeometryProbe = requireNativeViewManager<
  ViewProps & {
    onGeometryChange: (event: NativeSyntheticEvent<WindowLayout>) => void;
  }
>("PaseoWindowLayout");

export function WindowLayoutProvider({ children }: { children: ReactNode }) {
  const [geometry, setGeometry] = useState<WindowLayout | null>(null);
  const onGeometryChange = useCallback(
    (event: NativeSyntheticEvent<WindowLayout>) => setGeometry(event.nativeEvent),
    [],
  );
  return (
    <WindowLayoutContext.Provider value={geometry}>
      <View style={styles.root}>
        <GeometryProbe
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
          onGeometryChange={onGeometryChange}
        />
        <WindowSafeAreaInsets>{children}</WindowSafeAreaInsets>
      </View>
    </WindowLayoutContext.Provider>
  );
}

/**
 * The one top and bottom inset every descendant reads through `useSafeAreaInsets()`, and
 * the top band that `WindowChromeProvider` reads through `useTopBand()`.
 */
function WindowSafeAreaInsets({ children }: { children: ReactNode }) {
  const systemInsets = useSafeAreaInsets();
  const layout = useWindowLayout();
  const insets = useMemo(() => resolveSafeAreaInsets(systemInsets, layout), [systemInsets, layout]);
  const topBand = useMemo(
    () => resolveTopBand(systemInsets.top, layout),
    [systemInsets.top, layout],
  );
  return (
    <TopBandContext.Provider value={topBand}>
      <SafeAreaInsetsContext.Provider value={insets}>{children}</SafeAreaInsetsContext.Provider>
    </TopBandContext.Provider>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
