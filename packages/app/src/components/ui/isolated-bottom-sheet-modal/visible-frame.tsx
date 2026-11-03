import type { ReactNode } from "react";
import { View, StyleSheet } from "react-native";
import { KEYBOARD_STATUS, useBottomSheetInternal } from "@gorhom/bottom-sheet";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { getBottomSheetVisibleContentHeight } from "./visible-frame-layout";

/** Fixed-detent sheet content. The footer shares the sheet's translation below its lowest snap. */
export function SheetVisibleFrame({
  children,
  footer,
}: {
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { animatedDetentsState, animatedKeyboardState, animatedLayoutState, animatedPosition } =
    useBottomSheetInternal();
  const visibleStyle = useAnimatedStyle(() => {
    const { containerHeight, handleHeight } = animatedLayoutState.get();
    const keyboard = animatedKeyboardState.get();
    return {
      height: getBottomSheetVisibleContentHeight({
        containerHeight,
        handleHeight,
        contentPosition: animatedPosition.get(),
        lowestDetentPosition: animatedDetentsState.get().detents?.[0],
        keyboardHeight: keyboard.heightWithinContainer,
        isKeyboardVisible: keyboard.status === KEYBOARD_STATUS.SHOWN,
      }),
    };
  }, [animatedDetentsState, animatedKeyboardState, animatedLayoutState, animatedPosition]);
  return (
    <Animated.View style={[styles.frame, visibleStyle]}>
      <View style={styles.body}>{children}</View>
      {footer}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  frame: { minHeight: 0, overflow: "hidden" },
  body: { flex: 1, minHeight: 0 },
});
