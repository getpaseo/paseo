import { ComposerDockBackground } from "./internal/background";
export { ComposerDockBackground } from "./internal/background";
import { ScrollView } from "@/components/ui/scroll-view";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HEADER_INNER_HEIGHT, MAX_CONTENT_WIDTH } from "@/constants/layout";
import { KeyboardTranslateView } from "@/keyboard/shift";
import { createContext, useCallback, useContext, type ReactNode } from "react";
import { View, type LayoutChangeEvent, type ViewProps, StyleSheet } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  useDerivedValue,
  useAnimatedReaction,
  type SharedValue,
} from "react-native-reanimated";
import { useKeyboardShift } from "@/keyboard/shift";
import { updateComposerCapacity, type ComposerCapacity } from "./internal/capacity";

const ViewportCapacity = createContext<SharedValue<number | undefined> | null>(null);

interface ComposerViewportProps extends ViewProps {
  bottomInset?: number;
  centered?: boolean;
}

/** Measure the stationary space below the header, outside keyboard translation. */
function ComposerViewport({
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
    [],
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
function ComposerViewportContent({ style, ...props }: ViewProps) {
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

interface ComposerDockProps {
  children: [ReactNode, ReactNode, ReactNode?];
  centered?: boolean;
}

/** The stationary viewport, translated surface, and bounded composer are one owner. */
export function ComposerDock({
  children: [content, composer, overlay],
  centered = false,
}: ComposerDockProps) {
  const insets = useSafeAreaInsets();
  // Preserve the existing centered form's visual balance on tablets.
  const bottomInset = centered ? HEADER_INNER_HEIGHT + 24 : 0;
  if (centered) {
    return (
      <ComposerViewport
        style={[dockStyles.centeredViewport, { paddingBottom: bottomInset }]}
        bottomInset={bottomInset}
        centered
      >
        <KeyboardTranslateView style={dockStyles.centered}>
          <ComposerViewportContent style={dockStyles.composer}>
            <ScrollView style={dockStyles.setup} keyboardShouldPersistTaps="handled">
              {content}
            </ScrollView>
            <ComposerViewportContent style={dockStyles.centeredComposer}>
              {composer}
            </ComposerViewportContent>
          </ComposerViewportContent>
          {overlay}
        </KeyboardTranslateView>
      </ComposerViewport>
    );
  }
  return (
    <ComposerViewport style={dockStyles.viewport}>
      <KeyboardTranslateView style={dockStyles.surface}>
        <View
          testID="composer-dock-content"
          collapsable={false}
          style={dockStyles.content}
          pointerEvents="box-none"
        >
          {/* A responder ancestor intercepts native scroll drags on Android Fabric.
              Only unclaimed background touches may reach this sibling. */}
          <ComposerDockBackground style={StyleSheet.absoluteFill} />
          <View style={dockStyles.content} pointerEvents="box-none">
            {content}
          </View>
        </View>
        <ComposerViewportContent style={dockStyles.composer}>
          <View style={[dockStyles.composer, { paddingBottom: insets.bottom }]}>{composer}</View>
        </ComposerViewportContent>
        {overlay}
      </KeyboardTranslateView>
    </ComposerViewport>
  );
}

const dockStyles = StyleSheet.create({
  viewport: { flex: 1, overflow: "hidden" },
  surface: { flex: 1 },
  content: { flex: 1, justifyContent: "flex-end" },
  composer: { width: "100%", flexShrink: 1 },
  centeredViewport: { flex: 1, alignItems: "center", justifyContent: "center" },
  centered: { flexShrink: 1, width: "100%", maxWidth: MAX_CONTENT_WIDTH },
  // Reserve the composer's own capped height before the setup scroll view shrinks.
  centeredComposer: { width: "100%", flexShrink: 0 },
  setup: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
});
