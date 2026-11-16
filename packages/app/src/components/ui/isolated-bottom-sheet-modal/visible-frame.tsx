import type { ReactNode } from "react";
import { Platform, View, StyleSheet } from "react-native";
import { ANIMATION_STATUS, KEYBOARD_STATUS, useBottomSheetInternal } from "@gorhom/bottom-sheet";
import { State } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useDerivedValue } from "react-native-reanimated";
import { getBottomSheetVisibleContentHeight, getMotionFrameLayout } from "./visible-frame-layout";

/** Fixed-detent sheet content. The footer shares the sheet's translation below its lowest snap. */
export function SheetVisibleFrame({
  children,
  footer,
  stableViewport = false,
}: {
  children: ReactNode;
  footer?: ReactNode;
  stableViewport?: boolean;
}) {
  if (stableViewport && Platform.OS === "android" && footer) {
    return <MotionSheetVisibleFrame footer={footer}>{children}</MotionSheetVisibleFrame>;
  }
  return <ResizableSheetVisibleFrame footer={footer}>{children}</ResizableSheetVisibleFrame>;
}

function ResizableSheetVisibleFrame({
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

function MotionSheetVisibleFrame({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  const {
    animatedAnimationState,
    animatedContentGestureState,
    animatedDetentsState,
    animatedHandleGestureState,
    animatedKeyboardState,
    animatedLayoutState,
    animatedPosition,
  } = useBottomSheetInternal();
  const visibleHeight = useDerivedValue(() => {
    const { containerHeight, handleHeight } = animatedLayoutState.get();
    const keyboard = animatedKeyboardState.get();
    return getBottomSheetVisibleContentHeight({
      containerHeight,
      handleHeight,
      contentPosition: animatedPosition.get(),
      lowestDetentPosition: animatedDetentsState.get().detents?.[0],
      keyboardHeight: keyboard.heightWithinContainer,
      isKeyboardVisible: keyboard.status === KEYBOARD_STATUS.SHOWN,
    });
  });
  const bodyHeight = useDerivedValue(() => {
    const { containerHeight, handleHeight } = animatedLayoutState.get();
    const keyboard = animatedKeyboardState.get();
    const detents = animatedDetentsState.get();
    const expandedHeight = getBottomSheetVisibleContentHeight({
      containerHeight,
      handleHeight,
      contentPosition: detents.highestDetentPosition ?? animatedPosition.get(),
      lowestDetentPosition: detents.detents?.[0],
      keyboardHeight: keyboard.heightWithinContainer,
      isKeyboardVisible: keyboard.status === KEYBOARD_STATUS.SHOWN,
    });
    const moving =
      animatedAnimationState.get().status === ANIMATION_STATUS.RUNNING ||
      animatedHandleGestureState.get() === State.ACTIVE ||
      animatedContentGestureState.get() === State.ACTIVE;
    return getMotionFrameLayout(visibleHeight.get(), expandedHeight, moving).bodyHeight;
  });
  const frameStyle = useAnimatedStyle(() => ({ height: visibleHeight.get() }));
  const contentStyle = useAnimatedStyle(() => ({ height: bodyHeight.get() }));
  const footerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: visibleHeight.get() - bodyHeight.get() }],
  }));
  return (
    <Animated.View style={[styles.frame, frameStyle]}>
      <Animated.View style={[styles.motionContent, contentStyle]}>
        <View style={styles.body}>{children}</View>
        <Animated.View style={footerStyle}>{footer}</Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  frame: { minHeight: 0, overflow: "hidden" },
  body: { flex: 1, minHeight: 0 },
  motionContent: { position: "absolute", top: 0, left: 0, right: 0 },
});
