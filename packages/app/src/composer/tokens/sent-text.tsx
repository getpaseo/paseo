import { memo, useMemo } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ComposerSigils } from "./sigils";
import {
  collectSubmittedComposerTokens,
  getComposerTokenDisplayText,
  segmentComposerText,
} from "./tokens";

interface SentComposerTokenTextProps {
  text: string;
  sigils: ComposerSigils;
  style: StyleProp<TextStyle>;
}

export const SentComposerTokenText = memo(function SentComposerTokenText({
  text,
  sigils,
  style,
}: SentComposerTokenTextProps) {
  const segments = useMemo(
    () => segmentComposerText(text, collectSubmittedComposerTokens(text)),
    [text],
  );

  return (
    <Text selectable style={style}>
      {segments.map((segment) =>
        segment.kind === "text" ? (
          segment.text
        ) : (
          <Text key={segment.start} testID="sent-message-token" style={styles.token}>
            {getComposerTokenDisplayText(segment.token, sigils)}
          </Text>
        ),
      )}
    </Text>
  );
});

const styles = StyleSheet.create((theme) => ({
  token: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.accentBright,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    color: theme.colors.accentBright,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 1,
  },
}));
