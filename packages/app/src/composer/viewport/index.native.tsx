import { createContext, useCallback, useContext } from "react";
import { View, type LayoutChangeEvent, type ViewProps } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  useDerivedValue,
  useAnimatedReaction,
  type SharedValue,
} from "react-native-reanimated";
import { useKeyboardShift } from "@/hooks/keyboard-shift-context";
import { updateComposerCapacity, type ComposerCapacity } from "./capacity";

const ViewportCapacity = createContext<SharedValue<number | undefined> | null>(null);

interface ComposerViewportProps extends ViewProps {
  bottomInset?: number;
  centered?: boolean;
}

/** Measure the stationary space below the header, outside keyboard translation. */
export function ComposerViewport({
  children,
  onLayout,
  bottomInset = 0,
  centered = false,
  ...props
}: ComposerViewportProps) {
  const measuredHeight = useSharedValue(0);
  const sizing = useSharedValue<ComposerCapacity | undefined>(undefined);
  const { layoutShift } = useKeyboardShift();
  useAnimatedReaction(
    () => ({
      height: measuredHeight.value,
      bottomInset,
      keyboardShift: layoutShift.value,
      centered,
    }),
    (geometry) => {
      if (geometry.height <= 0) return;
      sizing.value = updateComposerCapacity(sizing.value, geometry);
    },
  );
  const capacity = useDerivedValue(() => sizing.value?.capacity);
  const measureViewport = useCallback(
    (event: LayoutChangeEvent) => {
      measuredHeight.value = event.nativeEvent.layout.height;
      onLayout?.(event);
    },
    [measuredHeight, onLayout],
  );

  return (
    <View testID="composer-viewport" {...props} onLayout={measureViewport} collapsable={false}>
      <ViewportCapacity.Provider value={capacity}>{children}</ViewportCapacity.Provider>
    </View>
  );
}

/** Bound the complete composer (including its controls), not just the text input. */
export function ComposerViewportContent({ style, ...props }: ViewProps) {
  const capacity = useContext(ViewportCapacity);
  if (!capacity) throw new Error("ComposerViewportContent requires ComposerViewport");
  const constraint = useAnimatedStyle(() => ({
    // Only viewport changes and keyboard start/end events trigger layout. Motion
    // stays in KeyboardTranslateView and never changes this constraint per frame.
    maxHeight: capacity.value,
  }));

  return (
    <Animated.View testID="composer-viewport-content" {...props} style={[style, constraint]} />
  );
}
