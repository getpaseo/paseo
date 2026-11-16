import type { ReactNode } from "react";
import { Platform, View, StyleSheet } from "react-native";
import { ANIMATION_STATUS, KEYBOARD_STATUS, useBottomSheetInternal } from "@gorhom/bottom-sheet";
import { State } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useDerivedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  getBottomSheetSafeAreaPaddingBottom,
  getBottomSheetVisibleContentHeight,
  getMotionFrameLayout,
} from "./visible-frame-layout";

/**
 * UI-thread bottom safe-area padding synchronized with Gorhom's keyboard state.
 * Use this for scrollable sheet bodies without a footer so content scrolls behind the system
 * navigation bar while still clearing it at rest and dropping the padding in lockstep with
 * `SheetVisibleFrame` when the keyboard opens or closes.
 */
export function useBottomSheetSafeAreaPaddingStyle(enabled = true) {
  const { bottom: safeAreaBottom } = useSafeAreaInsets();
  const { animatedKeyboardState } = useBottomSheetInternal();
  return useAnimatedStyle(() => {
    const keyboard = animatedKeyboardState.get();
    return {
      paddingBottom: enabled
        ? getBottomSheetSafeAreaPaddingBottom({
            keyboardHeight: keyboard.heightWithinContainer,
            isKeyboardVisible: keyboard.status === KEYBOARD_STATUS.SHOWN,
            safeAreaBottom,
          })
        : 0,
    };
  }, [animatedKeyboardState, enabled, safeAreaBottom]);
}

/**
 * Fixed-detent sheet content. The footer shares the sheet's translation below its lowest snap,
 * and frame height + bottom safe-area clearance update together in one UI-thread commit so the
 * footer never flashes behind the system navigation bar on keyboard show/hide.
 */
export function SheetVisibleFrame({
  children,
  footer,
  safeAreaInset = "footer",
  stableViewport = false,
}: {
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Where bottom safe-area clearance is applied:
   * - `"footer"` (default): pads the frame whenever `footer` is present.
   * - `"frame"`: always pads the frame, with or without a footer.
   * - `"none"`: caller owns safe-area clearance.
   */
  safeAreaInset?: "footer" | "frame" | "none";
  stableViewport?: boolean;
}) {
  if (stableViewport && Platform.OS === "android" && footer) {
    return (
      <MotionSheetVisibleFrame footer={footer} safeAreaInset={safeAreaInset}>
        {children}
      </MotionSheetVisibleFrame>
    );
  }
  return (
    <ResizableSheetVisibleFrame footer={footer} safeAreaInset={safeAreaInset}>
      {children}
    </ResizableSheetVisibleFrame>
  );
}

function ResizableSheetVisibleFrame({
  children,
  footer,
  safeAreaInset = "footer",
}: {
  children: ReactNode;
  footer?: ReactNode;
  safeAreaInset?: "footer" | "frame" | "none";
}) {
  const { bottom: safeAreaBottom } = useSafeAreaInsets();
  const { animatedDetentsState, animatedKeyboardState, animatedLayoutState, animatedPosition } =
    useBottomSheetInternal();
  const padFrame = safeAreaInset === "frame" || (safeAreaInset === "footer" && Boolean(footer));
  const visibleStyle = useAnimatedStyle(() => {
    const { containerHeight, handleHeight } = animatedLayoutState.get();
    const keyboard = animatedKeyboardState.get();
    const isKeyboardVisible = keyboard.status === KEYBOARD_STATUS.SHOWN;
    return {
      height: getBottomSheetVisibleContentHeight({
        containerHeight,
        handleHeight,
        contentPosition: animatedPosition.get(),
        lowestDetentPosition: animatedDetentsState.get().detents?.[0],
        keyboardHeight: keyboard.heightWithinContainer,
        isKeyboardVisible,
      }),
      paddingBottom: padFrame
        ? getBottomSheetSafeAreaPaddingBottom({
            keyboardHeight: keyboard.heightWithinContainer,
            isKeyboardVisible,
            safeAreaBottom,
          })
        : 0,
    };
  }, [
    animatedDetentsState,
    animatedKeyboardState,
    animatedLayoutState,
    animatedPosition,
    padFrame,
    safeAreaBottom,
  ]);
  return (
    <Animated.View style={[styles.frame, visibleStyle]}>
      <View style={styles.body}>{children}</View>
      {footer}
    </Animated.View>
  );
}

function MotionSheetVisibleFrame({
  children,
  footer,
  safeAreaInset = "footer",
}: {
  children: ReactNode;
  footer: ReactNode;
  safeAreaInset?: "footer" | "frame" | "none";
}) {
  const { bottom: safeAreaBottom } = useSafeAreaInsets();
  const {
    animatedAnimationState,
    animatedContentGestureState,
    animatedDetentsState,
    animatedHandleGestureState,
    animatedKeyboardState,
    animatedLayoutState,
    animatedPosition,
  } = useBottomSheetInternal();
  const padFrame = safeAreaInset === "frame" || safeAreaInset === "footer";
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
  const contentStyle = useAnimatedStyle(() => {
    const keyboard = animatedKeyboardState.get();
    return {
      height: bodyHeight.get(),
      paddingBottom: padFrame
        ? getBottomSheetSafeAreaPaddingBottom({
            keyboardHeight: keyboard.heightWithinContainer,
            isKeyboardVisible: keyboard.status === KEYBOARD_STATUS.SHOWN,
            safeAreaBottom,
          })
        : 0,
    };
  }, [animatedKeyboardState, bodyHeight, padFrame, safeAreaBottom]);
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
