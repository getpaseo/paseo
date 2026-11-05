import { useCallback, useState, type ReactNode } from "react";
import { StyleSheet, View, type NativeSyntheticEvent, type ViewProps } from "react-native";
import { requireNativeViewManager } from "expo-modules-core";
import { WindowLayoutContext } from "./context";
import type { WindowLayout } from "./model";

export { useWindowLayout } from "./context";
export { WindowLayoutActions, WindowLayoutActionsHost } from "./actions";
export { WindowLayoutSurface, WindowLayoutDivisionGap } from "./surface";
export {
  resolveDesktopDivisionLayout,
  resolveWorkspaceActionPlacement,
  resolveWorkspaceBarActions,
} from "./model";
export type { DesktopDivisionLayout, WindowLayout, WindowLayoutRect } from "./model";

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
        {children}
      </View>
    </WindowLayoutContext.Provider>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
