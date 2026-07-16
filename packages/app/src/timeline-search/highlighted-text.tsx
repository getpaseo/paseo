import React, { useMemo, type ReactNode } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { splitHighlightSegments, useTimelineHighlightQuery } from "./highlight";

export const timelineHighlightStyles = StyleSheet.create((theme) => ({
  match: {
    backgroundColor: theme.colors.accent,
    color: theme.colors.accentForeground,
  },
}));

/**
 * Wraps occurrences of the active timeline-search query in `text` with an
 * accent highlight so the searched term is visible in the rendered thread —
 * used across plain-text message surfaces (user prompts, activity logs, tool
 * call names/args/output). Returns the plain string when nothing is searched,
 * so highlighting adds no render cost while the search panel is closed.
 *
 * For plain `<Text>` surfaces only. Markdown text leaves are highlighted
 * separately (message.tsx) so matched spans compose with the markdown text
 * primitives on every platform.
 */
export function HighlightedText({ text }: { text: string }): ReactNode {
  const query = useTimelineHighlightQuery();
  const segments = useMemo(() => splitHighlightSegments(text, query), [text, query]);
  if (segments.length === 1 && !segments[0]?.isMatch) {
    return text;
  }
  return segments.map((segment) =>
    segment.isMatch ? (
      <Text key={segment.offset} style={timelineHighlightStyles.match}>
        {segment.text}
      </Text>
    ) : (
      <React.Fragment key={segment.offset}>{segment.text}</React.Fragment>
    ),
  );
}
