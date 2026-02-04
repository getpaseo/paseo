import React from "react";
import { View, Text } from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { Fonts } from "@/constants/theme";
import type { DiffLine, DiffSegment } from "@/utils/tool-call-parsers";
import { getCodeInsets } from "./code-insets";

interface DiffViewerProps {
  diffLines: DiffLine[];
  maxHeight?: number;
  emptyLabel?: string;
}

export function DiffViewer({ diffLines, maxHeight = 280, emptyLabel = "No changes to display" }: DiffViewerProps) {
  const [scrollViewWidth, setScrollViewWidth] = React.useState(0);

  if (!diffLines.length) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyText}>{emptyLabel}</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.verticalScroll, { maxHeight }]}
      contentContainerStyle={styles.verticalContent}
      nestedScrollEnabled
      showsVerticalScrollIndicator
    >
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator
        contentContainerStyle={styles.horizontalContent}
        onLayout={(e) => setScrollViewWidth(e.nativeEvent.layout.width)}
      >
        <View style={[styles.linesContainer, scrollViewWidth > 0 && { minWidth: scrollViewWidth }]}>
          {diffLines.map((line, index) => (
            <View
              key={`${line.type}-${index}`}
              style={[
                styles.line,
                line.type === "header" && styles.headerLine,
                line.type === "add" && styles.addLine,
                line.type === "remove" && styles.removeLine,
                line.type === "context" && styles.contextLine,
              ]}
            >
              {line.segments ? (
                <Text style={styles.lineText}>
                  <Text style={line.type === "add" ? styles.addText : styles.removeText}>
                    {line.content[0]}
                  </Text>
                  {line.segments.map((segment, segIdx) => (
                    <Text
                      key={segIdx}
                      style={[
                        line.type === "add" ? styles.addText : styles.removeText,
                        segment.changed && (line.type === "add" ? styles.addHighlight : styles.removeHighlight),
                      ]}
                    >
                      {segment.text}
                    </Text>
                  ))}
                </Text>
              ) : (
                <Text
                  style={[
                    styles.lineText,
                    line.type === "header" && styles.headerText,
                    line.type === "add" && styles.addText,
                    line.type === "remove" && styles.removeText,
                    line.type === "context" && styles.contextText,
                  ]}
                >
                  {line.content}
                </Text>
              )}
            </View>
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
    },
    line: {
      minWidth: "100%",
      paddingHorizontal: insets.padding,
      paddingVertical: insets.padding,
    },
    lineText: {
      fontFamily: Fonts.mono,
      fontSize: theme.fontSize.xs,
      color: theme.colors.foreground,
    },
    headerLine: {
      backgroundColor: theme.colors.surface2,
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
      backgroundColor: theme.colors.surface2,
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
