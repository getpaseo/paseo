import { useCallback, type ReactElement } from "react";
import Animated, {
  measure,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
} from "react-native-reanimated";
import { placeAboveAnchor, type PopoverFrameProps } from "./placement";

/**
 * The composer grows upward from a fixed bottom edge as its text wraps. Its height is read on the
 * UI thread every frame, so the popover moves in the frame the composer's new layout mounts; an
 * asynchronous measurement through JS painted the composer over or away from the popover first.
 *
 * The frame mounts only with a measured anchor. Reanimated computes the first style when the hook
 * first runs and sends later values after the mounting commit, which native paints: a placement
 * computed before the measurement painted the popover over the composer for a frame on every open.
 */
export function PopoverFrame({
  anchorRef,
  anchorAtRest,
  reservedLift,
  topInset,
  children,
}: PopoverFrameProps): ReactElement {
  "use no memo";
  // React Compiler memoizes effect captures by reading SharedValue.value during render.
  const anchorHeight = useSharedValue(anchorAtRest.height);
  const anchorLost = useSharedValue(false);
  const readAnchorHeight = useCallback(() => {
    "worklet";
    if (anchorLost.value) return;
    const measured = measure(anchorRef);
    if (!measured) {
      // The anchor left the shadow tree, usually as the composer unmounts; the portal removes the
      // frame a commit later. Each failed measure() logs a warning, and a busy JS thread holds
      // that commit for many frames, so stop measuring and follow the rest measurement.
      anchorLost.value = true;
      return;
    }
    if (measured.height !== anchorHeight.value) {
      anchorHeight.value = measured.height;
    }
  }, [anchorHeight, anchorLost, anchorRef]);
  useFrameCallback(readAnchorHeight);

  const style = useAnimatedStyle(() => {
    const anchorBottom = anchorAtRest.y + anchorAtRest.height;
    const liveHeight = anchorLost.value ? anchorAtRest.height : anchorHeight.value;
    return {
      position: "absolute",
      left: anchorAtRest.x,
      width: anchorAtRest.width,
      ...placeAboveAnchor({
        anchorTop: anchorBottom - liveHeight,
        hostHeight: anchorAtRest.hostHeight,
        reservedLift: reservedLift.value,
        topInset,
      }),
    };
  }, [anchorAtRest, anchorHeight, anchorLost, reservedLift, topInset]);

  return (
    <Animated.View testID="composer-autocomplete-popover" style={style}>
      {children}
    </Animated.View>
  );
}
