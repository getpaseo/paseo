import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AssistantVideoRenderBinding } from "@/assistant-image/use-assistant-video";

export interface AssistantVideoSurfaceProps {
  binding: AssistantVideoRenderBinding;
  style: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  testID?: string;
}

const styles = StyleSheet.create((theme) => ({
  unsupported: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[4],
  },
  unsupportedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));

// Native has no player: one would mean adding expo-video and a native rebuild, so
// the timeline says so instead of rendering a frame that never starts. The web and
// Electron renderers get the real element from assistant-video-surface.web.tsx.
export function AssistantVideoSurface({ style, testID }: AssistantVideoSurfaceProps) {
  const { t } = useTranslation();
  return (
    <View style={[style, styles.unsupported]} testID={testID}>
      <Text style={styles.unsupportedText}>
        {t("message.attachments.videoPlaybackUnsupported")}
      </Text>
    </View>
  );
}
