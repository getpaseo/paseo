import React from "react";
import { View, Text } from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import type { DiffLine } from "@/utils/tool-call-parsers";

interface DiffViewerProps {
  diffLines: DiffLine[];
  maxHeight?: number;
  emptyLabel?: string;
}

export function DiffViewer({ diffLines, maxHeight = 280, emptyLabel = "No changes to display" }: DiffViewerProps) {
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
      >
        <View style={styles.linesContainer}>
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
            </View>
          ))}
        </View>
      </ScrollView>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  verticalScroll: {},
  verticalContent: {
    flexGrow: 1,
  },
  horizontalContent: {
    flexDirection: "column" as const,
  },
  linesContainer: {
    alignSelf: "flex-start",
  },
  line: {
    minWidth: "100%",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  lineText: {
    fontFamily: "monospace",
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  headerLine: {
    backgroundColor: theme.colors.muted,
  },
  headerText: {
    color: theme.colors.mutedForeground,
  },
  addLine: {
    backgroundColor: theme.colors.palette.green[900],
  },
  addText: {
    color: theme.colors.palette.green[200],
  },
  removeLine: {
    backgroundColor: theme.colors.palette.red[900],
  },
  removeText: {
    color: theme.colors.palette.red[200],
  },
  contextLine: {
    backgroundColor: theme.colors.card,
  },
  contextText: {
    color: theme.colors.mutedForeground,
  },
  emptyState: {
    padding: theme.spacing[4],
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.mutedForeground,
  },
}));
