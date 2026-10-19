import {
  BottomSheetModalInternalProvider,
  INITIAL_CONTAINER_LAYOUT,
  useBottomSheetModalInternal,
} from "@gorhom/bottom-sheet";
import { PortalHost } from "@gorhom/portal";
import { useCallback, useId, useMemo, useRef, type ReactNode } from "react";
import {
  Dimensions,
  StatusBar,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSharedValue } from "react-native-reanimated";

/**
 * Hosts the sheets presented from inside it.
 *
 * A sheet's content normally lands at the app root, on the far side of the portal, where every
 * context between the root and the call site is gone (floating-panels.md Gotcha 7). Inside a
 * scope, a sheet renders into the scope's own host instead, so its content reads the scope's
 * contexts — the navigator, the workspace providers — without bridging each one by hand. The
 * scope only moves where the sheet draws: it still joins the app-wide sheet stack, so stacking,
 * Back and the backdrop treat it like every other sheet.
 *
 * The host fills the scope, and the sheets presented in it size and dock to the scope, not the
 * window. Sheets presented outside the scope keep drawing at the root, above it.
 */
export function SheetHostScope({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const parent = useBottomSheetModalInternal();
  const hostName = `sheet-host-${useId()}`;
  const containerLayoutState = useSharedValue({ ...INITIAL_CONTAINER_LAYOUT });
  const hostRef = useRef<View>(null);

  // Mirrors Gorhom's own hosting container measurement, so a sheet in the scope lays out against
  // the scope the way a root sheet lays out against the window.
  const handleLayout = useCallback(
    ({ nativeEvent }: LayoutChangeEvent) => {
      const { height } = nativeEvent.layout;
      hostRef.current?.measure((_x, _y, _width, _height, _pageX, pageY) => {
        const windowHeight = Dimensions.get("window").height;
        const top = pageY ?? 0;
        containerLayoutState.set({
          height,
          offset: {
            top,
            bottom: Math.max(0, windowHeight - (top + height + (StatusBar.currentHeight ?? 0))),
            left: 0,
            right: 0,
          },
        });
      });
    },
    [containerLayoutState],
  );

  const value = useMemo(
    () => ({ ...parent, hostName, containerLayoutState }),
    [containerLayoutState, hostName, parent],
  );

  return (
    <BottomSheetModalInternalProvider value={value}>
      <View style={[styles.scope, style]}>
        {children}
        <View ref={hostRef} style={styles.host} pointerEvents="box-none" onLayout={handleLayout}>
          <PortalHost name={hostName} />
        </View>
      </View>
    </BottomSheetModalInternalProvider>
  );
}

const styles = StyleSheet.create({
  scope: {
    flex: 1,
    minHeight: 0,
  },
  host: {
    ...StyleSheet.absoluteFillObject,
  },
});
