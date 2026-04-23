import React from "react";
import { View, Text, ScrollView as RNScrollView } from "react-native";
import { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { Fonts } from "@/constants/theme";
import type { DiffLine } from "@/utils/tool-call-parsers";
import { useWebScrollbarStyle } from "@/hooks/use-web-scrollbar-style";
import { getCodeInsets } from "./code-insets";
import { isWeb } from "@/constants/platform";

const ScrollView = isWeb ? RNScrollView : GHScrollView;

interface DiffViewerProps {
  diffLines: DiffLine[];
  maxHeight?: number;
  emptyLabel?: string;
  fillAvailableHeight?: boolean;
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

  return (
    <View style={lineContainerStyle}>
      {line.segments ? (
        <Text style={styles.lineText}>
          <Text style={line.type === "add" ? styles.addText : styles.removeText}>
            {line.content[0]}
          </Text>
          {line.segments.map((segment, segIdx) => (
            <DiffSegment key={segIdx} segment={segment} lineType={line.type} />
          ))}
        </Text>
      ) : (
        <Text style={plainLineTextStyle}>{line.content}</Text>
      )}
    </View>
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
  maxHeight,
  emptyLabel = "No changes to display",
  fillAvailableHeight = false,
}: DiffViewerProps) {
  const [scrollViewWidth, setScrollViewWidth] = React.useState(0);
  const webScrollbarStyle = useWebScrollbarStyle();
  const handleInnerLayout = React.useCallback(
    (e: { nativeEvent: { layout: { width: number } } }) =>
      setScrollViewWidth(e.nativeEvent.layout.width),
    [],
  );

  const outerScrollStyle = React.useMemo(
    () => [
      styles.verticalScroll,
      maxHeight !== undefined && { maxHeight },
      fillAvailableHeight && styles.fillHeight,
      webScrollbarStyle,
    ],
    [maxHeight, fillAvailableHeight, webScrollbarStyle],
  );
  const linesContainerStyle = React.useMemo(
    () => [styles.linesContainer, scrollViewWidth > 0 && { minWidth: scrollViewWidth }],
    [scrollViewWidth],
  );

  if (!diffLines.length) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyText}>{emptyLabel}</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={outerScrollStyle}
      contentContainerStyle={styles.verticalContent}
      nestedScrollEnabled
      showsVerticalScrollIndicator
    >
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator
        style={webScrollbarStyle}
        contentContainerStyle={styles.horizontalContent}
        onLayout={handleInnerLayout}
      >
        <View style={linesContainerStyle}>
          {diffLines.map((line, index) => (
            <DiffLineRow key={`${line.type}-${index}`} line={line} />
          ))}
        </View>
      </ScrollView>
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
      alignSelf: "flex-start",
      padding: insets.padding,
    },
    line: {
      minWidth: "100%",
      paddingHorizontal: 0,
      paddingVertical: theme.spacing[1],
    },
    lineText: {
      fontFamily: Fonts.mono,
      fontSize: theme.fontSize.xs,
      color: theme.colors.foreground,
      ...(isWeb
        ? {
            whiteSpace: "pre",
            overflowWrap: "normal",
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
    },
    addText: {
      color: theme.colors.foreground,
    },
    removeLine: {
      backgroundColor: "rgba(248, 81, 73, 0.1)",
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
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
  };
});
