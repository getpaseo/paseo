import React, { useCallback, useMemo, useRef, type ReactNode } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  splitHighlightSegments,
  useTimelineHighlightFieldQuery,
  useTimelineHighlightTarget,
  type HighlightSegment,
} from "./highlight";
import { useTimelineSearchOccurrenceAnchor } from "./occurrence-anchor";
import type { TimelineSearchTarget } from "./search-target";
import type { TimelineSearchField } from "./timeline-search-model";

export const timelineHighlightStyles = StyleSheet.create((theme) => ({
  match: {
    backgroundColor: theme.colors.searchHighlight,
    color: theme.colors.accentForeground,
  },
  // Color swap only — no borders or text decorations. This same style is
  // reused for the markdown-leaf path (message.tsx), where a segment is
  // nested inside another styled span; borders/underlines applied to a
  // nested Text are unreliable across platforms (see docs/hover.md-adjacent
  // native Text nesting gotchas), so background+foreground color is the only
  // "active" signal that is guaranteed to render everywhere.
  activeMatch: {
    backgroundColor: theme.colors.searchHighlightActive,
    color: theme.colors.searchHighlightActiveForeground,
  },
}));

/** Context a segment is evaluated against to decide if it's the ACTIVE occurrence. */
export interface HighlightSegmentMatchContext {
  /** Identify the stream source so one selected occurrence can receive active styling. */
  itemId?: string;
  field: TimelineSearchField;
  target: TimelineSearchTarget | null;
  /** Offset of this rendered text run within its owning search field. */
  fieldOffsetBase?: number;
}

export interface FindNextTextRunFieldOffsetInput {
  sourceText: string;
  sourceFieldOffset: number;
  runText: string;
  searchFrom: number;
}

/** Maps the next rendered text run to its monotonic occurrence in the markdown source. */
export function findNextTextRunFieldOffset({
  sourceText,
  sourceFieldOffset,
  runText,
  searchFrom,
}: FindNextTextRunFieldOffsetInput): number | null {
  if (runText.length === 0) {
    return null;
  }

  const runOffset = sourceText.indexOf(runText, searchFrom);
  return runOffset === -1 ? null : sourceFieldOffset + runOffset;
}

export interface MarkdownTextRun {
  key: string;
  text: string;
}

export interface MapMarkdownTextRunOffsetsInput {
  sourceText: string;
  sourceFieldOffset: number;
  runs: readonly MarkdownTextRun[];
}

/** Maps rendered markdown text-node keys to monotonically aligned source offsets. */
export function mapMarkdownTextRunOffsets({
  sourceText,
  sourceFieldOffset,
  runs,
}: MapMarkdownTextRunOffsetsInput): ReadonlyMap<string, number> {
  const offsets = new Map<string, number>();
  let searchFrom = 0;
  for (const run of runs) {
    const fieldOffset = findNextTextRunFieldOffset({
      sourceText,
      sourceFieldOffset,
      runText: run.text,
      searchFrom,
    });
    if (fieldOffset === null) {
      continue;
    }
    offsets.set(run.key, fieldOffset);
    searchFrom = fieldOffset - sourceFieldOffset + run.text.length;
  }
  return offsets;
}

/**
 * Whether `segment` is the exact occurrence the timeline-search model has
 * currently selected. `target.fieldOffset` is relative to the OWNING field's
 * own text (see `TimelineSearchTarget.fieldOffset`'s doc comment) — so this
 * must be compared against `segment.offset`, never `target.matchOffset`
 * (which is relative to the item's cross-field CONCATENATED text and is
 * meaningless to a component that only owns one field's raw text).
 */
export function isActiveHighlightSegment(
  segment: HighlightSegment,
  context: HighlightSegmentMatchContext,
): boolean {
  const { itemId, field, target, fieldOffsetBase = 0 } = context;
  return (
    segment.isMatch &&
    target !== null &&
    itemId !== undefined &&
    itemId === target.itemId &&
    field === target.field &&
    fieldOffsetBase + segment.offset === target.fieldOffset
  );
}

function ActiveHighlightedText({ children }: { children: string }) {
  const target = useTimelineHighlightTarget();
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

export interface RenderHighlightedSegmentsOptions {
  text: string;
  /** Identify the stream source so one selected occurrence can receive active styling. */
  itemId?: string;
  field: TimelineSearchField;
  /** Offset of `text` within the complete owning field. Defaults to zero. */
  fieldOffsetBase?: number;
  /** Renders one segment (match or non-match). `isActive` is only ever true for a match segment. */
  renderMatch: (segment: HighlightSegment, isActive: boolean) => ReactNode;
}

/**
 * Shared segment mapper for every "highlight the timeline-search query"
 * surface — both plain `<Text>` (`HighlightedText`) and the markdown-leaf
 * path (`message.tsx`'s `MarkdownHighlightedTextRun`) route through this so
 * the split/active-match logic is defined exactly once. Splits `text` via
 * `splitHighlightSegments` and hands each segment to `renderMatch`, along
 * with whether it's the currently-selected occurrence (see
 * `isActiveHighlightSegment`). Returns the raw string when nothing matches,
 * so highlighting adds no render cost while the search panel is closed.
 */
export function useHighlightedSegments({
  text,
  itemId,
  field,
  fieldOffsetBase = 0,
  renderMatch,
}: RenderHighlightedSegmentsOptions): ReactNode {
  const query = useTimelineHighlightFieldQuery(itemId, field);
  const target = useTimelineHighlightTarget();
  const segments = useMemo(() => splitHighlightSegments(text, query), [text, query]);
  if (segments.length === 1 && !segments[0]?.isMatch) {
    return text;
  }
  return segments.map((segment) => (
    <React.Fragment key={segment.offset}>
      {renderMatch(
        segment,
        isActiveHighlightSegment(segment, { itemId, field, target, fieldOffsetBase }),
      )}
    </React.Fragment>
  ));
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
  field?: TimelineSearchField;
}): ReactNode {
  return useHighlightedSegments({
    text,
    itemId,
    field,
    renderMatch: (segment, isActive) => {
      if (!segment.isMatch) {
        return segment.text;
      }
      if (isActive) {
        return <ActiveHighlightedText>{segment.text}</ActiveHighlightedText>;
      }
      return <Text style={timelineHighlightStyles.match}>{segment.text}</Text>;
    },
  });
}
