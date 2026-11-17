import React from "react";
import { useTranslation } from "react-i18next";
import {
  View,
  Text,
  ScrollView as RNScrollView,
  type StyleProp,
  type TextStyle,
} from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DiffLine, DiffSegment as DiffSegmentModel } from "@/utils/tool-call-parsers";
import type { HighlightToken } from "@getpaseo/highlight";
import { diffLineCode } from "@/utils/diff-highlight";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { getCodeInsets, lineNumberGutterWidth } from "./code-insets";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

const ScrollView = isWeb ? RNScrollView : GHScrollView;
const COLLAPSE_UNMODIFIED_AFTER = 6;
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const foregroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface DiffViewerProps {
  diffLines: DiffLine[];
  maxHeight?: number;
  emptyLabel?: string;
  fillAvailableHeight?: boolean;
}

interface DiffViewerLayoutEvent {
  nativeEvent: { layout: { width: number } };
}

interface NumberedDiffLine {
  key: string;
  line: DiffLine;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

interface RenderDiffSegment extends DiffSegmentModel {
  tokens?: HighlightToken[];
}

interface UnmodifiedGroup {
  kind: "unmodified";
  id: string;
  lines: NumberedDiffLine[];
}

interface SingleLine {
  kind: "line";
  item: NumberedDiffLine;
}

type DisplayRow = UnmodifiedGroup | SingleLine;

function hunkStart(line: DiffLine): { old: number; next: number } | null {
  const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line.content);
  if (!match) return null;
  return { old: Number(match[1]), next: Number(match[2]) };
}

function isNoNewlineMarker(line: DiffLine): boolean {
  return line.type === "header" && line.content.startsWith("\\ No newline");
}

function displayDiffLineCode(line: DiffLine): string {
  if (isNoNewlineMarker(line)) return line.content.slice(2);
  return diffLineCode(line);
}

function buildDisplayRows(diffLines: readonly DiffLine[]): {
  rows: DisplayRow[];
  maxLineNumber: number;
} {
  const rows: DisplayRow[] = [];
  let oldLineNumber = 1;
  let newLineNumber = 1;
  let maxLineNumber = 1;
  let unmodified: NumberedDiffLine[] = [];

  const flushUnmodified = () => {
    if (unmodified.length === 0) return;
    rows.push({ kind: "unmodified", id: `unmodified:${unmodified[0]!.key}`, lines: unmodified });
    unmodified = [];
  };
  const numbered = (
    line: DiffLine,
    index: number,
    oldLine: number | null,
    newLine: number | null,
  ): NumberedDiffLine => {
    maxLineNumber = Math.max(maxLineNumber, oldLine ?? 0, newLine ?? 0);
    return {
      key: `${index}-${line.type}-${line.content}`,
      line,
      oldLineNumber: oldLine,
      newLineNumber: newLine,
    };
  };

  for (const [index, line] of diffLines.entries()) {
    if (line.type === "header") {
      flushUnmodified();
      rows.push({ kind: "line", item: numbered(line, index, null, null) });
      const start = hunkStart(line);
      if (start) {
        oldLineNumber = start.old;
        newLineNumber = start.next;
      }
      continue;
    }
    if (line.type === "context") {
      unmodified.push(numbered(line, index, oldLineNumber, newLineNumber));
      oldLineNumber += 1;
      newLineNumber += 1;
      continue;
    }
    flushUnmodified();
    if (line.type === "add") {
      rows.push({ kind: "line", item: numbered(line, index, null, newLineNumber) });
      newLineNumber += 1;
    } else {
      rows.push({ kind: "line", item: numbered(line, index, oldLineNumber, null) });
      oldLineNumber += 1;
    }
  }
  flushUnmodified();
  return { rows, maxLineNumber };
}

function LineNumber({
  lineType,
  value,
  gutterWidth,
}: {
  lineType: DiffLine["type"];
  value: number | null;
  gutterWidth: number;
}) {
  const style = React.useMemo(
    () => [
      styles.lineNumber,
      lineType === "add" && styles.addLineNumber,
      lineType === "remove" && styles.removeLineNumber,
      inlineUnistylesStyle({ width: gutterWidth }),
    ],
    [gutterWidth, lineType],
  );
  return (
    <Text testID="diff-line-number" style={style}>
      {value ?? ""}
    </Text>
  );
}

function mergeTokensIntoSegments(
  tokens: readonly HighlightToken[],
  segments: readonly DiffSegmentModel[],
): RenderDiffSegment[] {
  const merged: RenderDiffSegment[] = [];
  let tokenIndex = 0;
  let tokenStart = 0;
  let segmentStart = 0;

  for (const segment of segments) {
    const segmentEnd = segmentStart + segment.text.length;
    const segmentTokens: HighlightToken[] = [];
    let cursor = segmentStart;

    while (cursor < segmentEnd && tokenIndex < tokens.length) {
      const token = tokens[tokenIndex]!;
      const tokenEnd = tokenStart + token.text.length;
      if (tokenEnd <= cursor) {
        tokenIndex += 1;
        tokenStart = tokenEnd;
        continue;
      }

      const runEnd = Math.min(segmentEnd, tokenEnd);
      segmentTokens.push({
        text: token.text.slice(cursor - tokenStart, runEnd - tokenStart),
        style: token.style,
      });
      cursor = runEnd;
      if (cursor === tokenEnd) {
        tokenIndex += 1;
        tokenStart = tokenEnd;
      }
    }

    merged.push({ ...segment, tokens: segmentTokens });
    segmentStart = segmentEnd;
  }

  return merged;
}

function DiffSegments({
  lineType,
  segments,
  tokens,
}: {
  lineType: DiffLine["type"];
  segments: NonNullable<DiffLine["segments"]>;
  tokens: DiffLine["tokens"];
}) {
  const merged = React.useMemo(() => {
    if (tokens?.length) return mergeTokensIntoSegments(tokens, segments);
    return segments;
  }, [segments, tokens]);
  const keyed = React.useMemo(() => {
    let start = 0;
    return merged.map((segment) => {
      const key = `${start}:${segment.changed ? "c" : "u"}:${segment.text}`;
      start += segment.text.length;
      return { key, segment };
    });
  }, [merged]);
  return (
    <Text testID="diff-line-text" style={styles.lineText}>
      {keyed.map(({ key, segment }) => (
        <DiffSegment key={key} segment={segment} lineType={lineType} />
      ))}
    </Text>
  );
}

function DiffLineContent({
  line,
  plainLineTextStyle,
}: {
  line: DiffLine;
  plainLineTextStyle: StyleProp<TextStyle>;
}) {
  if (line.segments) {
    return <DiffSegments lineType={line.type} segments={line.segments} tokens={line.tokens} />;
  }
  if (line.tokens) {
    return (
      <Text testID="diff-line-text" style={styles.lineText}>
        <DiffTokens tokens={line.tokens} />
      </Text>
    );
  }
  return (
    <Text testID="diff-line-text" style={plainLineTextStyle}>
      {displayDiffLineCode(line)}
    </Text>
  );
}

function DiffLineRow({ item, gutterWidth }: { item: NumberedDiffLine; gutterWidth: number }) {
  const { line } = item;
  const isMetadata = isNoNewlineMarker(line);
  const lineContainerStyle = React.useMemo(
    () => [
      styles.line,
      line.type === "header" && !isMetadata && styles.headerLine,
      line.type === "add" && styles.addLine,
      line.type === "remove" && styles.removeLine,
      line.type === "context" && styles.contextLine,
    ],
    [isMetadata, line.type],
  );
  const plainLineTextStyle = React.useMemo(
    () => [
      styles.lineText,
      line.type === "header" && styles.headerText,
      line.type === "add" && styles.addText,
      line.type === "remove" && styles.removeText,
      line.type === "context" && styles.contextText,
    ],
    [line.type],
  );
  const indicatorStyle = React.useMemo(
    () => [
      styles.indicator,
      line.type === "add" && styles.addIndicator,
      line.type === "remove" && styles.removeIndicator,
    ],
    [line.type],
  );
  const hasIndicator = line.type === "add" || line.type === "remove";

  return (
    <View style={lineContainerStyle}>
      {hasIndicator && <View testID={`diff-${line.type}-indicator`} style={indicatorStyle} />}
      <LineNumber
        lineType={line.type}
        value={item.newLineNumber ?? item.oldLineNumber}
        gutterWidth={gutterWidth}
      />
      <View style={styles.lineContent}>
        <DiffLineContent line={line} plainLineTextStyle={plainLineTextStyle} />
      </View>
    </View>
  );
}

function DiffTokens({ tokens }: { tokens: NonNullable<DiffLine["tokens"]> }) {
  const keyed = React.useMemo(
    () => tokens.map((token, index) => ({ key: `${index}-${token.text}`, token })),
    [tokens],
  );
  return (
    <>
      {keyed.map(({ key, token }) => (
        <Text
          key={key}
          testID="diff-syntax-token"
          style={token.style ? syntaxTokenStyleFor(token.style) : undefined}
        >
          {token.text}
        </Text>
      ))}
    </>
  );
}

function DiffSegment({
  segment,
  lineType,
}: {
  segment: RenderDiffSegment;
  lineType: DiffLine["type"];
}) {
  const segmentStyle = React.useMemo(
    () => [
      lineType === "add" ? styles.addText : styles.removeText,
      segment.changed && (lineType === "add" ? styles.addHighlight : styles.removeHighlight),
    ],
    [lineType, segment.changed],
  );
  return (
    <Text testID={segment.changed ? "diff-changed-segment" : undefined} style={segmentStyle}>
      {segment.tokens ? <DiffTokens tokens={segment.tokens} /> : segment.text}
    </Text>
  );
}

function UnmodifiedGroupRow({
  group,
  expanded,
  onToggle,
}: {
  group: UnmodifiedGroup;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation();
  const handlePress = React.useCallback(() => onToggle(group.id), [group.id, onToggle]);
  const Chevron = expanded ? ThemedChevronDown : ThemedChevronRight;
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={t("diffViewer.unmodifiedLines", { count: group.lines.length })}
      onPress={handlePress}
      style={styles.unmodifiedRow}
      testID="diff-unmodified-toggle"
    >
      <Chevron size={14} uniProps={foregroundMutedMapping} />
      <Text style={styles.unmodifiedText} numberOfLines={1}>
        {t("diffViewer.unmodifiedLines", { count: group.lines.length })}
      </Text>
    </PressHighlight>
  );
}

export function DiffViewer({
  diffLines,
  emptyLabel,
  maxHeight,
  fillAvailableHeight = false,
}: DiffViewerProps) {
  const { t } = useTranslation();
  const [scrollViewWidth, setScrollViewWidth] = React.useState(0);
  const [expandedUnmodifiedIds, setExpandedUnmodifiedIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const resolvedEmptyLabel = emptyLabel ?? t("diffViewer.empty");
  const handleInnerLayout = React.useCallback(
    (event: DiffViewerLayoutEvent) => setScrollViewWidth(event.nativeEvent.layout.width),
    [],
  );
  const { rows, maxLineNumber } = React.useMemo(() => buildDisplayRows(diffLines), [diffLines]);
  const gutterWidth = lineNumberGutterWidth(maxLineNumber, styles.lineNumber.fontSize);
  const toggleUnmodified = React.useCallback((id: string) => {
    setExpandedUnmodifiedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const outerScrollStyle = React.useMemo(
    () => [
      styles.verticalScroll,
      maxHeight !== undefined && inlineUnistylesStyle({ maxHeight }),
      fillAvailableHeight && styles.fillHeight,
    ],
    [maxHeight, fillAvailableHeight],
  );
  const linesContainerStyle = React.useMemo(
    () => [
      styles.linesContainer,
      scrollViewWidth > 0 && inlineUnistylesStyle({ width: scrollViewWidth }),
    ],
    [scrollViewWidth],
  );
  const webVerticalContentStyle = React.useMemo(
    () => [styles.verticalContent, fillAvailableHeight && styles.fillHeight],
    [fillAvailableHeight],
  );

  if (!diffLines.length) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyText}>{resolvedEmptyLabel}</Text>
      </View>
    );
  }

  const lines = (
    <View style={linesContainerStyle} dataSet={CODE_SURFACE_DATASET}>
      {rows.map((row) => {
        if (row.kind === "unmodified") {
          const expanded = expandedUnmodifiedIds.has(row.id);
          if (row.lines.length > COLLAPSE_UNMODIFIED_AFTER && !expanded) {
            return (
              <UnmodifiedGroupRow
                key={row.id}
                group={row}
                expanded={false}
                onToggle={toggleUnmodified}
              />
            );
          }
          return (
            <React.Fragment key={row.id}>
              {row.lines.length > COLLAPSE_UNMODIFIED_AFTER ? (
                <UnmodifiedGroupRow group={row} expanded onToggle={toggleUnmodified} />
              ) : null}
              {row.lines.map((item) => (
                <DiffLineRow key={item.key} item={item} gutterWidth={gutterWidth} />
              ))}
            </React.Fragment>
          );
        }
        return <DiffLineRow key={row.item.key} item={row.item} gutterWidth={gutterWidth} />;
      })}
    </View>
  );

  const horizontalContent = (
    <View style={styles.horizontalContent} onLayout={handleInnerLayout}>
      {lines}
    </View>
  );

  // Capped tool details own vertical scrolling outside the diff.
  // Hover previews still pass maxHeight and scroll inside this view.
  if (!fillAvailableHeight && maxHeight === undefined) return horizontalContent;

  return (
    <ScrollView
      style={outerScrollStyle}
      contentContainerStyle={webVerticalContentStyle}
      nestedScrollEnabled
      showsVerticalScrollIndicator
    >
      {horizontalContent}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => {
  const insets = getCodeInsets(theme);

  return {
    verticalScroll: {},
    fillHeight: {
      flex: 1,
      minHeight: 0,
    },
    verticalContent: {
      flexGrow: 1,
      paddingBottom: insets.extraBottom,
    },
    horizontalContent: {
      flexDirection: "column" as const,
      paddingRight: insets.extraRight,
    },
    linesContainer: {
      alignSelf: "stretch",
      padding: insets.padding,
    },
    line: {
      minWidth: "100%",
      flexDirection: "row",
      alignItems: "flex-start",
      paddingLeft: theme.spacing[2],
      paddingVertical: theme.spacing[1],
    },
    indicator: {
      position: "absolute",
      top: 0,
      bottom: 0,
      left: 0,
      width: 3,
    },
    addIndicator: {
      backgroundColor: theme.colors.diffAddition,
    },
    removeIndicator: {
      backgroundColor: theme.colors.diffDeletion,
    },
    lineNumber: {
      flexShrink: 0,
      paddingRight: theme.spacing[2],
      color: theme.colors.foregroundMuted,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      textAlign: "right",
    },
    addLineNumber: {
      color: theme.colors.diffAddition,
    },
    removeLineNumber: {
      color: theme.colors.diffDeletion,
    },
    lineContent: {
      flex: 1,
      minWidth: 0,
    },
    lineText: {
      width: "100%",
      flexShrink: 1,
      minWidth: 0,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foreground,
      ...(isWeb
        ? {
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }
        : null),
    },
    headerLine: {
      backgroundColor: theme.colors.surface1,
    },
    headerText: {
      color: theme.colors.foregroundMuted,
    },
    addLine: {
      backgroundColor: theme.colors.diffAdditionBackground,
    },
    addText: {
      color: theme.colors.foreground,
    },
    removeLine: {
      backgroundColor: theme.colors.diffDeletionBackground,
    },
    removeText: {
      color: theme.colors.foreground,
    },
    addHighlight: {
      backgroundColor: theme.colors.diffAdditionHighlight,
    },
    removeHighlight: {
      backgroundColor: theme.colors.diffDeletionHighlight,
    },
    contextLine: {
      backgroundColor: theme.colors.surface1,
    },
    contextText: {
      color: theme.colors.foregroundMuted,
    },
    unmodifiedRow: {
      minWidth: "100%",
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
      paddingVertical: theme.spacing[1],
      backgroundColor: theme.colors.surface1,
    },
    unmodifiedText: {
      flexShrink: 1,
      color: theme.colors.foregroundMuted,
      fontFamily: theme.fontFamily.ui,
      fontSize: theme.fontSize.sm,
    },
    emptyState: {
      padding: theme.spacing[4],
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    emptyText: {
      fontSize: theme.fontSize.base,
      color: theme.colors.foregroundMuted,
    },
  };
});
