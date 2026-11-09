import { useCallback, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View, type NativeSyntheticEvent, type ViewProps } from "react-native";
import { requireNativeModule, requireNativeViewManager } from "expo-modules-core";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { WindowLayoutContext, useWindowLayout } from "./context";
import { resolveSafeAreaInsets, type WindowLayout } from "./model";
import {
  installVerticalBarController,
  reportVerticalBarLayout,
  type VerticalBarBehavior,
} from "./vertical-bar";

export { useWindowLayout } from "./context";
export { WindowLayoutActions, WindowLayoutActionsHost } from "./actions";
export { WindowLayoutSurface, WindowLayoutDivisionGap } from "./surface";
export {
  resolveDesktopDivisionLayout,
  resolveHeaderBesideStatusBar,
  resolveWorkspaceActionPlacement,
  resolveWorkspaceBarActions,
} from "./model";
export type { DesktopDivisionLayout, WindowLayout, WindowLayoutRect } from "./model";
export {
  getVerticalBar,
  setVerticalBarBehavior,
  subscribeVerticalBar,
  useVerticalBarDisabled,
  type VerticalBarBehavior,
  type VerticalBarState,
} from "./vertical-bar";

const GeometryProbe = requireNativeViewManager<
  ViewProps & {
    onGeometryChange: (event: NativeSyntheticEvent<WindowLayout>) => void;
  }
>("PaseoWindowLayout");

const windowLayoutModule = requireNativeModule<{
  // Absent from native builds that predate the vertical bar control.
  setVerticalBarBehavior?: (behavior: VerticalBarBehavior) => void;
}>("PaseoWindowLayout");
installVerticalBarController((behavior) => windowLayoutModule.setVerticalBarBehavior?.(behavior));

export function WindowLayoutProvider({ children }: { children: ReactNode }) {
  const [geometry, setGeometry] = useState<WindowLayout | null>(null);
  const onGeometryChange = useCallback((event: NativeSyntheticEvent<WindowLayout>) => {
    reportVerticalBarLayout(event.nativeEvent);
    setGeometry(event.nativeEvent);
  }, []);
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

/** The one bottom inset every descendant reads through `useSafeAreaInsets()`. */
function WindowSafeAreaInsets({ children }: { children: ReactNode }) {
  const systemInsets = useSafeAreaInsets();
  const layout = useWindowLayout();
  const insets = useMemo(() => resolveSafeAreaInsets(systemInsets, layout), [systemInsets, layout]);
  return <SafeAreaInsetsContext.Provider value={insets}>{children}</SafeAreaInsetsContext.Provider>;
}

const styles = StyleSheet.create({ root: { flex: 1 } });
