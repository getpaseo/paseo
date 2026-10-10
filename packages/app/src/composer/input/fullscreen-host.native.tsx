import { useEffect, type ReactNode } from "react";
import { Portal } from "@gorhom/portal";
import { BackHandler, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { DEFAULT_FLOATING_PANEL_PORTAL_HOST } from "@/components/ui/floating-panel-portal";
import { useKeyboardShift } from "@/keyboard/shift";

/** Same-window host keeps the IME attached while escaping the dock's clipping. */
export function ComposerFullscreenHost({
  children,
  onExit,
  active,
}: {
  children: ReactNode;
  onExit: () => void;
  active: boolean;
}) {
  useEffect(() => {
    if (!active) return;
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      onExit();
      return true;
    });
    return () => handler.remove();
  }, [active, onExit]);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const { layoutShift } = useKeyboardShift();
  const frame = useAnimatedStyle(() => ({
    height: Math.max(0, height - layoutShift.value),
    paddingTop: insets.top,
    paddingBottom: insets.bottom,
    paddingLeft: insets.left,
    paddingRight: insets.right,
  }));
  return (
    <Portal hostName={DEFAULT_FLOATING_PANEL_PORTAL_HOST}>
      <View style={[styles.background, !active && styles.hidden]}>
        <Animated.View style={[{ width: "100%" }, frame]}>{children}</Animated.View>
      </View>
    </Portal>
  );
}

const styles = StyleSheet.create((theme) => ({
  hidden: { display: "none" },
  background: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: theme.colors.surface1,
  },
}));
