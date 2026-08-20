import { useMemo, type ReactElement } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { MatchRange } from "@getpaseo/protocol/search/text-match";
import { toHighlightSegments } from "./highlighted-text-segments";

export interface HighlightedTextProps {
  text: string;
  /** Character spans to mark, in order and non-overlapping. */
  ranges?: readonly MatchRange[];
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  testID?: string;
}

/**
 * Text with some of its characters marked. Used to show why a search result is
 * in the list — the subsequence and typo tiers can match on characters the eye
 * would never find unaided.
 *
 * The mark is a surface tint rather than the accent: it appears many times on a
 * screen, so it has to stay quiet and survive every theme, and the one accent
 * per surface is spoken for.
 */
export function HighlightedText({
  text,
  ranges,
  style,
  numberOfLines,
  testID,
}: HighlightedTextProps): ReactElement {
  const segments = useMemo(
    () => (ranges && ranges.length > 0 ? toHighlightSegments(text, ranges) : null),
    [ranges, text],
  );

  if (!segments) {
    return (
      <Text style={style} numberOfLines={numberOfLines} testID={testID}>
        {text}
      </Text>
    );
  }

  return (
    <Text style={style} numberOfLines={numberOfLines} testID={testID}>
      {segments.map((segment) =>
        segment.marked ? (
          <Text key={segment.start} style={styles.mark}>
            {segment.text}
          </Text>
        ) : (
          <Text key={segment.start}>{segment.text}</Text>
        ),
      )}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  mark: {
    backgroundColor: theme.colors.surface3,
    color: theme.colors.foreground,
  },
}));
