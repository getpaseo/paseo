export { ComposerDockBackground } from "./internal/background";
export { ComposerFullscreenBody, ComposerFullscreenFooter } from "./internal/fullscreen";
import { ScrollView } from "@/components/ui/scroll-view";
import { useState, useCallback, useMemo, useRef, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { resolveInlineComposerCapacity } from "./internal/capacity";
import { useFullscreenSlotFrame } from "./internal/fullscreen";
import { useIsCompactFormFactor } from "@/constants/layout";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";

interface ComposerDockProps {
  children: [ReactNode, ReactNode, ReactNode?];
  centered?: boolean;
  /** See the native dock: the same mounted composer fills the visible surface. */
  fullscreen?: boolean;
}

export function ComposerDock({
  children: [content, composer, overlay],
  centered = false,
  fullscreen = false,
}: ComposerDockProps) {
  const compact = useIsCompactFormFactor();
  const [surfaceSize, setSurfaceSize] = useState<{ width: number; height: number }>();
  const surfaceRef = useRef<View>(null);
  const fullscreenFrame = useFullscreenSlotFrame(fullscreen, surfaceRef, surfaceSize);
  const constraint = useMemo(
    () => ({ maxHeight: resolveInlineComposerCapacity(surfaceSize?.height, compact) }),
    [surfaceSize?.height, compact],
  );
  const measureViewport = useCallback((event: import("react-native").LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (height > 0) setSurfaceSize({ width, height });
  }, []);
  if (centered) {
    return (
      <View ref={surfaceRef} style={styles.centered} onLayout={measureViewport}>
        <View style={styles.form}>
          <ScrollView style={styles.setup} keyboardShouldPersistTaps="handled">
            {content}
          </ScrollView>
          <View
            style={
              fullscreen
                ? [styles.fullscreenComposer, fullscreenFrame]
                : [styles.centeredComposer, constraint]
            }
          >
            {composer}
          </View>
          {overlay}
        </View>
      </View>
    );
  }
  return (
    <View ref={surfaceRef} style={styles.surface} onLayout={measureViewport}>
      <View style={styles.content}>{content}</View>
      <View
        style={
          fullscreen ? [styles.fullscreenComposer, fullscreenFrame] : [styles.composer, constraint]
        }
      >
        {composer}
      </View>
      {overlay}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  surface: { flex: 1, overflow: "hidden" },
  content: { flex: 1, justifyContent: "flex-end" },
  composer: { width: "100%", flexShrink: 1 },
  // Fixed, not absolute: a touch pan that starts inside an overflow-hidden ancestor
  // never reaches the zoomed visual viewport, while a fixed box chains to the viewport
  // directly. React Native Web renders `fixed`; React Native's style type omits it.
  fullscreenComposer: { position: "fixed" as "absolute" },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: HEADER_INNER_HEIGHT + 24,
  },
  form: { flexShrink: 1, width: "100%", maxWidth: theme.contentMaxWidth },
  centeredComposer: { flexShrink: 0 },
  setup: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
}));
