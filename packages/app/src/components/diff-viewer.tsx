import React from "react";
import { useTranslation } from "react-i18next";
import { View, Text, ScrollView as RNScrollView } from "react-native";
import { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import type { DiffLine } from "@/utils/tool-call-parsers";
import { diffLinePrefix, mergeDiffTokensAndSegments } from "@/utils/diff-highlight";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import { getCodeInsets } from "./code-insets";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { isWeb } from "@/constants/platform";

const ScrollView = isWeb ? RNScrollView : GHScrollView;

interface DiffViewerProps {
  diffLines: DiffLine[];
  emptyLabel?: string;
  fillAvailableHeight?: boolean;
}

function highlightStyleForLineType(lineType: DiffLine["type"]) {
  if (lineType === "add") return styles.addHighlight;
  if (lineType === "remove") return styles.removeHighlight;
  return undefined;
}

function resolveRunStyle(
  tokenStyle: ReturnType<typeof syntaxTokenStyleFor> | undefined,
  highlightStyle: typeof styles.addHighlight | typeof styles.removeHighlight | undefined,
  changed: boolean,
) {
  if (!changed || !highlightStyle) return tokenStyle;
  if (!tokenStyle) return highlightStyle;
  return [tokenStyle, highlightStyle];
}

function keySegments(segments: NonNullable<DiffLine["segments"]>) {
  let offset = 0;
  return segments.map((segment) => {
    const key = `${offset}-${segment.changed ? "c" : "u"}:${segment.text}`;
    offset += segment.text.length;
    return { key, segment };
  });
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const lineContainerStyle = React.useMemo(
    () => [
      styles.line,
      line.type === "header" && styles.headerLine,
      line.type === "add" && styles.addLine,
      line.type === "remove" && styles.removeLine,
      line.type === "context" && styles.contextLine,
    ],
    [line.type],
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

  const prefixStyle = React.useMemo(
    () => [
      line.type === "add" && styles.addText,
      line.type === "remove" && styles.removeText,
      line.type === "context" && styles.contextText,
    ],
    [line.type],
  );
  const keyedSegments = React.useMemo(
    () => (line.segments ? keySegments(line.segments) : null),
    [line.segments],
  );

  if (line.tokens) {
    return (
      <View style={lineContainerStyle}>
        <Text style={styles.lineText}>
          <Text style={prefixStyle}>{diffLinePrefix(line)}</Text>
          <DiffTokens tokens={line.tokens} segments={line.segments} lineType={line.type} />
        </Text>
      </View>
    );
  }

  return (
    <View style={lineContainerStyle}>
      {keyedSegments ? (
        <Text style={styles.lineText}>
          <Text style={line.type === "add" ? styles.addText : styles.removeText}>
            {line.content[0]}
          </Text>
          {keyedSegments.map(({ key, segment }) => (
            <DiffSegment key={key} segment={segment} lineType={line.type} />
          ))}
        </Text>
      ) : (
        <Text style={plainLineTextStyle}>{line.content}</Text>
      )}
    </View>
  );
}

function DiffTokens({
  tokens,
  segments,
  lineType,
}: {
  tokens: NonNullable<DiffLine["tokens"]>;
  segments?: DiffLine["segments"];
  lineType: DiffLine["type"];
}) {
  const keyed = React.useMemo(() => {
    let offset = 0;
    return mergeDiffTokensAndSegments(tokens, segments).map((run) => {
      const key = `${offset}-${run.changed ? "c" : "u"}-${run.text}`;
      offset += run.text.length;
      return { key, run };
    });
  }, [tokens, segments]);
  const highlightStyle = highlightStyleForLineType(lineType);

  return (
    <>
      {keyed.map(({ key, run }) => {
        const tokenStyle = run.style ? syntaxTokenStyleFor(run.style) : undefined;
        return (
          <Text key={key} style={resolveRunStyle(tokenStyle, highlightStyle, run.changed)}>
            {run.text}
          </Text>
        );
      })}
    </>
  );
}

function DiffSegment({
  segment,
  lineType,
}: {
  segment: NonNullable<DiffLine["segments"]>[number];
  lineType: DiffLine["type"];
}) {
  const segmentStyle = React.useMemo(
    () => [
      lineType === "add" ? styles.addText : styles.removeText,
      segment.changed && (lineType === "add" ? styles.addHighlight : styles.removeHighlight),
    ],
    [lineType, segment.changed],
  );
  return <Text style={segmentStyle}>{segment.text}</Text>;
}

export function DiffViewer({
  diffLines,
  emptyLabel,
  fillAvailableHeight = false,
}: DiffViewerProps) {
  const { t } = useTranslation();
  const resolvedEmptyLabel = emptyLabel ?? t("diffViewer.empty");

  const outerScrollStyle = React.useMemo(
    () => [styles.verticalScroll, fillAvailableHeight && styles.fillHeight],
    [fillAvailableHeight],
  );
  const keyedDiffLines = React.useMemo(
    () => diffLines.map((line, index) => ({ key: `${index}-${line.type}-${line.content}`, line })),
    [diffLines],
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
    <View style={styles.linesContainer} dataSet={CODE_SURFACE_DATASET}>
      {keyedDiffLines.map(({ key, line }) => (
        <DiffLineRow key={key} line={line} />
      ))}
    </View>
  );

  // Capped tool details own vertical scrolling outside the diff.
  if (!fillAvailableHeight) return lines;

  return (
    <ScrollView
      style={outerScrollStyle}
      contentContainerStyle={webVerticalContentStyle}
      nestedScrollEnabled
      showsVerticalScrollIndicator
    >
      {lines}
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
    linesContainer: {
      width: "100%",
      padding: insets.padding,
    },
    line: {
      width: "100%",
      borderLeftWidth: 2,
      borderLeftColor: "transparent",
      paddingLeft: 4,
      paddingRight: 4,
      paddingVertical: theme.spacing[1],
    },
    lineText: {
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
      backgroundColor: "rgba(46, 160, 67, 0.15)",
      borderLeftColor: "rgba(46, 160, 67, 0.75)",
    },
    addText: {
      color: theme.colors.foreground,
    },
    removeLine: {
      backgroundColor: "rgba(248, 81, 73, 0.1)",
      borderLeftColor: "rgba(248, 81, 73, 0.75)",
    },
    removeText: {
      color: theme.colors.foreground,
    },
    addHighlight: {
      backgroundColor: "rgba(46, 160, 67, 0.4)",
    },
    removeHighlight: {
      backgroundColor: "rgba(248, 81, 73, 0.35)",
    },
    contextLine: {
      backgroundColor: theme.colors.surface1,
    },
    contextText: {
      color: theme.colors.foregroundMuted,
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
