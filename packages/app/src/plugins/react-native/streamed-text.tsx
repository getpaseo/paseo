import type { StreamedTextProps } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useRevealedText } from "@/hooks/use-revealed-text";
import { useScopedTextZoom } from "@/text-zoom/scope";
import { zoomedFontSize } from "@/text-zoom/model";

export function StreamedText({ text, phase, style, ...props }: StreamedTextProps) {
  const revealed = useRevealedText(text, phase);
  const zoom = useScopedTextZoom();
  return (
    <Text {...props} style={[styles.text(zoom), style]}>
      {revealed}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Inside the chat, follows its pinch zoom like the rest of the transcript.
  text: (zoom: number) => ({
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.ui,
    fontSize: zoomedFontSize(theme.fontSize.content, zoom),
    lineHeight: Math.round(zoomedFontSize(theme.fontSize.content, zoom) * 1.4),
  }),
}));
