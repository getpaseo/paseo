import type { ReactNode } from "react";
import { StyleSheet, type ViewProps } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { KeyboardTranslateView, useKeyboardShift } from "@/keyboard/shift";

/**
 * The editing region of a composer. Inline it only continues the shrink chain. In
 * fullscreen it fills the stationary frame and reserves the keyboard's space at
 * motion boundaries, the same boundary-time layout the dock capacity uses: the
 * keyboard start/end events write `layoutShift`; frames in between move the footer.
 */
export function ComposerFullscreenBody({
  fullscreen,
  children,
}: {
  fullscreen: boolean;
  children: ReactNode;
}) {
  const { layoutShift } = useKeyboardShift();
  const reservation = useAnimatedStyle(() => ({
    marginBottom: fullscreen ? layoutShift.value : 0,
  }));
  return (
    <Animated.View style={[fullscreen ? styles.fullscreen : styles.inline, reservation]}>
      {children}
    </Animated.View>
  );
}

/** The Send row of a fullscreen composer rides the keyboard like the inline dock surface. */
export function ComposerFullscreenFooter({ children, ...props }: ViewProps) {
  return <KeyboardTranslateView {...props}>{children}</KeyboardTranslateView>;
}

// Plain React Native styles: these land on Reanimated views (docs/unistyles.md).
const styles = StyleSheet.create({
  inline: { flexShrink: 1 },
  fullscreen: { flex: 1, minHeight: 0 },
});
