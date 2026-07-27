import { useMemo, type PropsWithChildren } from "react";
import { StyleSheet as RNStyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { resolveFloatingComposerBottom } from "@/hooks/keyboard-shift-policy";
import { useCompactIosWebComposerMetrics } from "@/hooks/use-compact-ios-web-composer-metrics";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";

interface ComposerDockProps extends PropsWithChildren {
  compact: boolean;
  onLayout?: (event: LayoutChangeEvent) => void;
}

export function ComposerDock({ compact, onLayout, children }: ComposerDockProps) {
  const insets = useSafeAreaInsets();
  const { shift: keyboardShift, style: nativeKeyboardStyle } = useKeyboardShiftStyle({
    mode: "translate",
  });
  const iosWebMetrics = useCompactIosWebComposerMetrics(compact);

  const dockPositionStyle = useAnimatedStyle(() => {
    const bottom = resolveFloatingComposerBottom({
      isWeb,
      isCompact: compact,
      keyboardShift: keyboardShift.value,
      bottomInset: insets.bottom,
    });
    if (isWeb && compact && iosWebMetrics.offset.value !== null) {
      return {
        bottom,
        transform: [{ translateY: iosWebMetrics.offset.value }],
      };
    }
    return { bottom };
  }, [compact, insets.bottom]);

  const dockFillStyle = useAnimatedStyle(() => ({
    bottom: isWeb && compact ? -iosWebMetrics.dockFillDepth.value : 0,
  }));

  // Keep Unistyles theme colors off Animated.View — theme toggle + Reanimated
  // crash with "Unable to find node on an unmounted component" (docs/unistyles.md).
  const dockStyle = useMemo(() => [staticStyles.dock, dockPositionStyle], [dockPositionStyle]);
  const fillStyle = useMemo(() => [staticStyles.fill, dockFillStyle], [dockFillStyle]);
  const contentStyle = useMemo(
    () => [staticStyles.content, { paddingBottom: insets.bottom }, nativeKeyboardStyle],
    [insets.bottom, nativeKeyboardStyle],
  );

  return (
    <Animated.View style={dockStyle} onLayout={onLayout}>
      <View pointerEvents="none" style={styles.surfaceFill} />
      <Animated.View pointerEvents="none" style={fillStyle}>
        <View style={styles.surfaceFill} />
      </Animated.View>
      <Animated.View style={contentStyle}>{children}</Animated.View>
    </Animated.View>
  );
}

const staticStyles = RNStyleSheet.create({
  dock: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 20,
    width: "100%",
  },
  fill: {
    position: "absolute",
    top: 0,
    right: 0,
    left: 0,
  },
  content: {
    width: "100%",
  },
});

const styles = StyleSheet.create((theme) => ({
  surfaceFill: {
    ...RNStyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.surface0,
  },
}));
