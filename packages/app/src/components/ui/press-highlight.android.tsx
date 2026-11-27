import { forwardRef, useCallback, useMemo } from "react";
import {
  Pressable,
  type PressableProps,
  type PressableStateCallbackType,
  type View,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { PressHighlightProps } from "./press-highlight.types";

interface RipplePressableProps extends Omit<PressableProps, "style"> {
  rippleColor?: string;
  // `withUnistyles` flattens a `style` prop, which would drop the caller's state callback.
  pressableStyle: PressableProps["style"];
}

// A foreground ripple tints the content with the surface, so nothing inside needs to know the
// row is pressed.
const RipplePressable = withUnistyles(
  forwardRef<View, RipplePressableProps>(function RipplePressable(
    { rippleColor, pressableStyle, ...props },
    ref,
  ) {
    const ripple = useMemo(
      () => (rippleColor ? { color: rippleColor, foreground: true } : undefined),
      [rippleColor],
    );
    return <Pressable {...props} ref={ref} style={pressableStyle} android_ripple={ripple} />;
  }),
);

// Android's own `ViewConfiguration.getTapTimeout()`: a native list in a scroll view waits this long
// before showing pressed, so a scroll that claims the touch first cancels it.
const TAP_TIMEOUT_MS = 100;

const rippleColorMapping = (theme: Theme) => ({ rippleColor: theme.colors.interactionHighlight });

/**
 * The platform ripple replaces `highlightStyle`. Pressable starts it from JS after the press
 * delay, then the animation runs on the UI thread without a React commit.
 */
export const PressHighlight = forwardRef<View, PressHighlightProps>(function PressHighlight(
  {
    highlightStyle,
    onHighlightChange: _onHighlightChange,
    style,
    unstable_pressDelay = TAP_TIMEOUT_MS,
    ...props
  },
  ref,
) {
  const hasRipple = highlightStyle != null;
  const rippleStyle = useCallback(
    (state: PressableStateCallbackType) => [
      hasRipple && styles.rippleBorderReset,
      typeof style === "function" ? style(state) : style,
      hasRipple && styles.rippleClip,
    ],
    [style, hasRipple],
  );
  return (
    <RipplePressable
      {...props}
      ref={ref}
      pressableStyle={rippleStyle}
      uniProps={hasRipple ? rippleColorMapping : undefined}
      unstable_pressDelay={unstable_pressDelay}
    />
  );
});

const styles = StyleSheet.create({
  // React Native 0.86 sends NaN when a style drops `borderWidth`, and an overflow-hidden view then
  // clips to a NaN padding box and stops painting. A sidebar row loses its drag border on drop.
  // An explicit 0 under the caller's style sends 0 instead. Fixed upstream in
  // facebook/react-native#57789; remove once the app ships a React Native release with it.
  rippleBorderReset: {
    borderWidth: 0,
  },
  // React Native draws ripples in the view's rectangle. With overflow hidden, the view clips its
  // children to its rounded padding box, and that clip is still on the canvas when Android draws
  // the foreground, so the ripple follows the corners.
  rippleClip: {
    overflow: "hidden",
  },
});
