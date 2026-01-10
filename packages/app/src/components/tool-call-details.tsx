import React, { useMemo, ReactNode } from "react";
import { View, Text } from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { Fonts } from "@/constants/theme";
import {
  parseToolCallDisplay,
  buildLineDiff,
  type ToolCallDisplay,
} from "@/utils/tool-call-parsers";
import { DiffViewer } from "./diff-viewer";

// ---- Types ----

export interface ToolCallDetailsData {
  args?: unknown;
  result?: unknown;
  error?: unknown;
}

// ---- Helper ----

function formatValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ---- Content Component ----

interface ToolCallDetailsContentProps {
  display: ToolCallDisplay;
  errorText?: string;
  maxHeight?: number;
}

export function ToolCallDetailsContent({
  display,
  errorText,
  maxHeight = 300,
}: ToolCallDetailsContentProps) {
  // Compute diff lines for edit type
  const diffLines = useMemo(() => {
    if (display.type !== "edit") return undefined;
    return buildLineDiff(display.oldString, display.newString);
  }, [display]);

  const sections: ReactNode[] = [];

  if (display.type === "shell") {
    sections.push(
      <View key="shell" style={styles.section}>
        <Text style={styles.sectionTitle}>Command</Text>
        <ScrollView
          horizontal
          nestedScrollEnabled
          style={styles.jsonScroll}
          contentContainerStyle={styles.jsonContent}
          showsHorizontalScrollIndicator={true}
        >
          <Text style={styles.scrollText}>{display.command}</Text>
        </ScrollView>
        {display.output ? (
          <ScrollView
            style={[styles.scrollArea, { maxHeight }]}
            contentContainerStyle={styles.scrollContent}
            nestedScrollEnabled
            showsVerticalScrollIndicator={true}
          >
            <ScrollView
              horizontal
              nestedScrollEnabled
              showsHorizontalScrollIndicator={true}
            >
              <Text style={styles.scrollText}>{display.output}</Text>
            </ScrollView>
          </ScrollView>
        ) : null}
      </View>
    );
  } else if (display.type === "edit") {
    sections.push(
      <View key="edit" style={styles.section}>
        <Text style={styles.sectionTitle}>File</Text>
        <View style={styles.fileBadge}>
          <Text style={styles.fileBadgeText}>{display.filePath}</Text>
        </View>
        {diffLines && diffLines.length > 0 ? (
          <View style={styles.diffContainer}>
            <DiffViewer diffLines={diffLines} maxHeight={maxHeight} />
          </View>
        ) : null}
      </View>
    );
  } else if (display.type === "read") {
    sections.push(
      <View key="read" style={styles.section}>
        <Text style={styles.sectionTitle}>File</Text>
        <View style={styles.fileBadge}>
          <Text style={styles.fileBadgeText}>{display.filePath}</Text>
        </View>
        {(display.offset !== undefined || display.limit !== undefined) ? (
          <Text style={styles.rangeText}>
            {display.offset !== undefined ? `Offset: ${display.offset}` : ""}
            {display.offset !== undefined && display.limit !== undefined ? " • " : ""}
            {display.limit !== undefined ? `Limit: ${display.limit}` : ""}
          </Text>
        ) : null}
        {display.content ? (
          <ScrollView
            style={[styles.scrollArea, { maxHeight }]}
            contentContainerStyle={styles.scrollContent}
            nestedScrollEnabled
            showsVerticalScrollIndicator={true}
          >
            <ScrollView
              horizontal
              nestedScrollEnabled
              showsHorizontalScrollIndicator={true}
            >
              <Text style={styles.scrollText}>{display.content}</Text>
            </ScrollView>
          </ScrollView>
        ) : null}
      </View>
    );
  } else {
    // Generic tool: show input/output as key-value pairs
    if (display.input.length > 0) {
      sections.push(
        <View key="input-header" style={styles.groupHeader}>
          <Text style={styles.groupHeaderText}>Input</Text>
        </View>
      );
      display.input.forEach((pair, index) => {
        sections.push(
          <View key={`input-${index}-${pair.key}`} style={styles.section}>
            <Text style={styles.sectionTitle}>{pair.key}</Text>
            <ScrollView
              horizontal
              nestedScrollEnabled
              style={styles.jsonScroll}
              contentContainerStyle={styles.jsonContent}
              showsHorizontalScrollIndicator={true}
            >
              <Text style={styles.scrollText}>{pair.value}</Text>
            </ScrollView>
          </View>
        );
      });
    }

    if (display.output.length > 0) {
      sections.push(
        <View key="output-header" style={styles.groupHeader}>
          <Text style={styles.groupHeaderText}>Output</Text>
        </View>
      );
      display.output.forEach((pair, index) => {
        sections.push(
          <View key={`output-${index}-${pair.key}`} style={styles.section}>
            <Text style={styles.sectionTitle}>{pair.key}</Text>
            <ScrollView
              horizontal
              nestedScrollEnabled
              style={styles.jsonScroll}
              contentContainerStyle={styles.jsonContent}
              showsHorizontalScrollIndicator={true}
            >
              <Text style={styles.scrollText}>{pair.value}</Text>
            </ScrollView>
          </View>
        );
      });
    }
  }

  // Always show errors if available
  if (errorText) {
    sections.push(
      <View key="error" style={styles.section}>
        <Text style={[styles.sectionTitle, styles.errorText]}>Error</Text>
        <ScrollView
          horizontal
          nestedScrollEnabled
          style={[styles.jsonScroll, styles.jsonScrollError]}
          contentContainerStyle={styles.jsonContent}
          showsHorizontalScrollIndicator={true}
        >
          <Text style={[styles.scrollText, styles.errorText]}>
            {errorText}
          </Text>
        </ScrollView>
      </View>
    );
  }

  if (sections.length === 0) {
    return (
      <Text style={styles.emptyStateText}>No additional details available</Text>
    );
  }

  return <View style={styles.container}>{sections}</View>;
}

// ---- Hook for parsing tool call data ----

export function useToolCallDetails(data: ToolCallDetailsData) {
  const { args, result, error } = data;

  return useMemo(() => {
    const display = parseToolCallDisplay(args, result);
    const errorText = error !== undefined ? formatValue(error) : undefined;
    return { display, errorText };
  }, [args, result, error]);
}

// ---- Styles ----

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[4],
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  groupHeaderText: {
    color: theme.colors.primary,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.bold,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  fileBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
  },
  fileBadgeText: {
    color: theme.colors.foreground,
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.xs,
  },
  rangeText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
  },
  diffContainer: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    overflow: "hidden",
    backgroundColor: theme.colors.card,
  },
  scrollArea: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.card,
  },
  scrollContent: {
    padding: theme.spacing[2],
  },
  scrollText: {
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    lineHeight: 18,
  },
  jsonScroll: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.card,
  },
  jsonScrollError: {
    borderColor: theme.colors.destructive,
  },
  jsonContent: {
    padding: theme.spacing[2],
  },
  errorText: {
    color: theme.colors.destructive,
  },
  emptyStateText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    fontStyle: "italic",
  },
}));
