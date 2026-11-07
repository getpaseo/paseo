import { forwardRef, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { resolveHighlightCorners } from "./press-highlight.shape";
import type { PressHighlightProps } from "./press-highlight.types";

export const PressHighlight = forwardRef<View, PressHighlightProps>(function PressHighlight(
  { children, disabled, highlightStyle, ...props },
  ref,
) {
  const highlighted = useSharedValue(0);
  const touchStartX = useSharedValue(0);
  const touchStartY = useSharedValue(0);
  const corners = useMemo(() => resolveHighlightCorners(props.style), [props.style]);
  const animatedHighlightStyle = useAnimatedStyle(() => ({ opacity: highlighted.value }));
  // Never activate the highlight recognizer: Android mouse taps activate on
  // ACTION_BUTTON_RELEASE before Pressable receives ACTION_UP, cancelling its press
  // (including presses on nested action buttons). Observe touches and fail on release.
  const pressGesture = useMemo(
    () =>
      Gesture.Manual()
        .enabled(disabled !== true && highlightStyle != null)
        .shouldCancelWhenOutside(true)
        .onTouchesDown((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }
          touchStartX.value = touch.absoluteX;
          touchStartY.value = touch.absoluteY;
          highlighted.value = 1;
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }
          const deltaX = touch.absoluteX - touchStartX.value;
          const deltaY = touch.absoluteY - touchStartY.value;
          if (deltaX * deltaX + deltaY * deltaY > 8 * 8) {
            stateManager.fail();
          }
        })
        .onTouchesUp((_event, stateManager) => {
          stateManager.fail();
        })
        .onTouchesCancelled((_event, stateManager) => {
          stateManager.fail();
        })
        .onFinalize(() => {
          highlighted.value = 0;
        }),
    [disabled, highlightStyle, highlighted, touchStartX, touchStartY],
  );

  const highlight = highlightStyle ? (
    <Animated.View pointerEvents="none" style={[styles.highlight, animatedHighlightStyle]}>
      {/* Keep the themed Unistyles node separate from the node Reanimated patches. The
          pressable's corners come first so `highlightStyle` can still override them. */}
      <View style={[styles.highlightFill, corners, highlightStyle]} />
    </Animated.View>
  ) : null;
  const renderedChildren =
    typeof children === "function" ? (
      (state: Parameters<typeof children>[0]) => (
        <>
          {highlight}
          {children(state)}
        </>
      )
    ) : (
      <>
        {highlight}
        {children}
      </>
    );

  const pressable = (
    <Pressable ref={ref} {...props} collapsable={false} disabled={disabled}>
      {renderedChildren}
    </Pressable>
  );

  if (!highlightStyle) {
    return pressable;
  }

  return <GestureDetector gesture={pressGesture}>{pressable}</GestureDetector>;
});

const styles = StyleSheet.create({
  highlight: {
    ...StyleSheet.absoluteFill,
  },
  highlightFill: {
    ...StyleSheet.absoluteFill,
  },
});
