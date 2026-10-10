export { ComposerDockBackground } from "./internal/background";
import { ScrollView } from "@/components/ui/scroll-view";
import { useState, useCallback, useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { resolveInlineComposerCapacity } from "./internal/capacity";
import { useIsCompactFormFactor } from "@/constants/layout";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";

interface ComposerDockProps {
  children: [ReactNode, ReactNode, ReactNode?];
  centered?: boolean;
}

export function ComposerDock({
  children: [content, composer, overlay],
  centered = false,
}: ComposerDockProps) {
  const compact = useIsCompactFormFactor();
  const [availableHeight, setAvailableHeight] = useState<number>();
  const constraint = useMemo(
    () => ({ maxHeight: resolveInlineComposerCapacity(availableHeight, compact) }),
    [availableHeight, compact],
  );
  const measureViewport = useCallback((event: import("react-native").LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    if (height > 0) setAvailableHeight(height);
  }, []);
  if (centered) {
    return (
      <View style={styles.centered} onLayout={measureViewport}>
        <View style={styles.form}>
          <ScrollView style={styles.setup} keyboardShouldPersistTaps="handled">
            {content}
          </ScrollView>
          <View style={[styles.centeredComposer, constraint]}>{composer}</View>
          {overlay}
        </View>
      </View>
    );
  }
  return (
    <View style={styles.surface} onLayout={measureViewport}>
      <View style={styles.content}>{content}</View>
      <View style={[styles.composer, constraint]}>{composer}</View>
      {overlay}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  surface: { flex: 1, overflow: "hidden" },
  content: { flex: 1, justifyContent: "flex-end" },
  composer: { width: "100%", flexShrink: 1 },
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
