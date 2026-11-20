import type { StreamedTextProps } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useRevealedText } from "@/hooks/use-revealed-text";

export function StreamedText({ text, phase, style, ...props }: StreamedTextProps) {
  const revealed = useRevealedText(text, phase);
  return (
    <Text {...props} style={[styles.text, style]}>
      {revealed}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.content,
    lineHeight: Math.round(theme.fontSize.content * 1.4),
  },
}));
