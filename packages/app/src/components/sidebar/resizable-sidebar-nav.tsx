import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import { View, useWindowDimensions, type AccessibilityActionEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { usePanelStore } from "@/stores/panel-store";
import { SidebarNavRows } from "./sidebar-nav-rows";

export function ResizableSidebarNav(props: Omit<ComponentProps<typeof SidebarNavRows>, "maxRows">) {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { items } = useSidebarNavItems("header");
  const maxNavRows = Math.max(
    1,
    Math.min(
      items.filter((item) => item.visible).length,
      Math.floor((windowHeight - insets.top - insets.bottom - 220) / 38),
    ),
  );
  const savedNavRows = usePanelStore((state) => state.sidebarNavRows);
  const saveNavRows = usePanelStore((state) => state.setSidebarNavRows);
  const [previewNavRows, setPreviewNavRows] = useState<number | null>(null);
  const navRows = Math.min(previewNavRows ?? savedNavRows, maxNavRows);
  const startNavRows = useSharedValue(navRows);
  const currentNavRows = useSharedValue(navRows);
  const dragNavRows = useSharedValue(navRows);
  useEffect(() => {
    currentNavRows.value = navRows;
  }, [navRows, currentNavRows]);

  const resizeNav = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-4, 4])
        .failOffsetX([-15, 15])
        .onStart(() => {
          startNavRows.value = currentNavRows.value;
          dragNavRows.value = currentNavRows.value;
        })
        .onUpdate((event) => {
          const rows = Math.max(
            1,
            Math.min(maxNavRows, startNavRows.value + Math.round(event.translationY / 38)),
          );
          if (rows !== dragNavRows.value) {
            dragNavRows.value = rows;
            runOnJS(setPreviewNavRows)(rows);
          }
        })
        .onEnd((_event, success) => {
          if (success) runOnJS(saveNavRows)(dragNavRows.value);
        })
        .onFinalize(() => {
          runOnJS(setPreviewNavRows)(null);
        }),
    [maxNavRows, startNavRows, currentNavRows, dragNavRows, saveNavRows],
  );

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      saveNavRows(
        Math.max(
          1,
          Math.min(maxNavRows, navRows + (event.nativeEvent.actionName === "increment" ? 1 : -1)),
        ),
      );
    },
    [maxNavRows, navRows, saveNavRows],
  );

  return (
    <>
      <SidebarNavRows {...props} maxRows={navRows} />
      <GestureDetector gesture={resizeNav}>
        <View
          style={styles.divider}
          testID="sidebar-nav-resize-handle"
          accessibilityLabel="Resize menu"
          accessibilityRole="adjustable"
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={handleAccessibilityAction}
        >
          <View style={styles.grip} />
        </View>
      </GestureDetector>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  divider: { height: 20, marginTop: -10, alignItems: "center", justifyContent: "center" },
  grip: { width: 36, height: 4, borderRadius: 2, backgroundColor: theme.colors.border },
}));
