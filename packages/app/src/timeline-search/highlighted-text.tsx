import React, { useCallback, useMemo, useRef, type ReactNode } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  splitHighlightSegments,
  useTimelineHighlightQuery,
  useTimelineHighlightTarget,
} from "./highlight";
import { useTimelineSearchOccurrenceAnchor } from "./occurrence-anchor";
import type { TimelineSearchTarget } from "./search-target";

export const timelineHighlightStyles = StyleSheet.create((theme) => ({
  match: {
    backgroundColor: theme.colors.accent,
    color: theme.colors.accentForeground,
  },
  activeMatch: {
    backgroundColor: theme.colors.accentBright,
    color: theme.colors.accentForeground,
    fontWeight: theme.fontWeight.semibold,
    textDecorationLine: "underline",
    textDecorationColor: theme.colors.accentForeground,
  },
}));

function ActiveHighlightedText({
  target,
  children,
}: {
  target: TimelineSearchTarget;
  children: string;
}) {
  const ref = useRef<Text>(null);
  const measure = useCallback((report: (centerY: number) => void) => {
    ref.current?.measureInWindow?.((_x, y, _width, height) => {
      report(y + height / 2);
    });
  }, []);
  useTimelineSearchOccurrenceAnchor(target, measure, 2);
  return (
    <Text ref={ref} style={timelineHighlightStyles.activeMatch}>
      {children}
    </Text>
  );
}

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
export function HighlightedText({
  text,
  itemId,
  field = "text",
}: {
  text: string;
  /** Identify the stream source so one selected occurrence can receive active styling. */
  itemId?: string;
  field?: "text" | "tool" | "other";
}): ReactNode {
  const query = useTimelineHighlightQuery();
  const target = useTimelineHighlightTarget();
  const segments = useMemo(() => splitHighlightSegments(text, query), [text, query]);
  if (segments.length === 1 && !segments[0]?.isMatch) {
    return text;
  }
  return segments.map((segment) => {
    const isActive =
      segment.isMatch &&
      itemId === target?.itemId &&
      field === target.field &&
      segment.offset === target.matchOffset &&
      segment.text.length === target.matchLength;
    if (isActive && target) {
      return (
        <ActiveHighlightedText key={segment.offset} target={target}>
          {segment.text}
        </ActiveHighlightedText>
      );
    }
    return segment.isMatch ? (
      <Text key={segment.offset} style={timelineHighlightStyles.match}>
        {segment.text}
      </Text>
    ) : (
      <React.Fragment key={segment.offset}>{segment.text}</React.Fragment>
    );
  });
}
