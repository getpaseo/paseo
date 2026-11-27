import { requireNativeView } from "expo";
import { type Ref } from "react";
import { usePanelStore } from "@/stores/panel-store";
import { withUnistyles } from "react-native-unistyles";
import { View, StyleSheet, type ViewProps } from "react-native";

export interface RowFeedbackHandle {
  acknowledge(): Promise<void>;
}
interface FeedbackProps extends ViewProps {
  ref?: Ref<RowFeedbackHandle>;
  resetKey: string;
  tint?: string;
  radius?: number;
}
const NativeFeedback = withUnistyles(requireNativeView<FeedbackProps>("PaseoPressFeedback"));
const mapTheme = (theme: import("@/styles/theme").Theme) => ({
  tint: theme.colors.interactionHighlight,
  radius: theme.borderRadius.lg,
});
export function RowFeedback({
  ref,
  selected,
}: {
  ref?: Ref<RowFeedbackHandle>;
  selected: boolean;
}) {
  const revision = usePanelStore((state) => state.mobilePanel.revision);
  // Selection takes over the fill; a new panel transition clears it before reopening.
  const resetKey = `${selected}:${revision}`;
  return (
    <View pointerEvents="none" style={styles.overlay}>
      <NativeFeedback
        ref={ref}
        resetKey={resetKey}
        pointerEvents="none"
        style={styles.fill}
        uniProps={mapTheme}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  fill: { flex: 1 },
});
