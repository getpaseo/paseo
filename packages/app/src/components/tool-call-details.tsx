import React, { useMemo, ReactNode } from "react";
import { View, Text } from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { Fonts } from "@/constants/theme";
import { getNowMs, isPerfLoggingEnabled, perfLog } from "@/utils/perf";
import {
  parseToolCallDisplay,
  buildLineDiff,
  parseUnifiedDiff,
  type ToolCallDisplay,
} from "@/utils/tool-call-parsers";
import { DiffViewer } from "./diff-viewer";

// ---- Types ----

export interface ToolCallDetailsData {
  toolName: string;
  args?: unknown;
  result?: unknown;
  error?: unknown;
}

const TOOL_CALL_DETAILS_LOG_TAG = "[ToolCallDetails]";
const TOOL_CALL_DETAILS_DURATION_THRESHOLD_MS = 8;
const TOOL_CALL_DETAILS_SIZE_THRESHOLD = 20000;

type ToolCallDisplaySummary = {
  displayType: ToolCallDisplay["type"];
  totalChars: number;
  detail: Record<string, unknown>;
};

function summarizeToolCallDisplay(display: ToolCallDisplay): ToolCallDisplaySummary {
  switch (display.type) {
    case "shell": {
      const commandLength = display.command.length;
      const outputLength = display.output.length;
      return {
        displayType: display.type,
        totalChars: commandLength + outputLength,
        detail: {
          commandLength,
          outputLength,
        },
      };
    }
    case "edit": {
      const oldLength = display.oldString.length;
      const newLength = display.newString.length;
      return {
        displayType: display.type,
        totalChars: oldLength + newLength,
        detail: {
          filePath: display.filePath,
          oldLength,
          newLength,
        },
      };
    }
    case "read": {
      const contentLength = display.content.length;
      return {
        displayType: display.type,
        totalChars: contentLength,
        detail: {
          filePath: display.filePath,
          contentLength,
          offset: display.offset,
          limit: display.limit,
        },
      };
    }
    case "generic": {
      const inputPairs = display.input.length;
      const outputPairs = display.output.length;
      const inputChars = display.input.reduce((sum, pair) => sum + pair.value.length, 0);
      const outputChars = display.output.reduce((sum, pair) => sum + pair.value.length, 0);
      return {
        displayType: display.type,
        totalChars: inputChars + outputChars,
        detail: {
          inputPairs,
          outputPairs,
          inputChars,
          outputChars,
        },
      };
    }
    case "thinking": {
      const contentLength = display.content.length;
      return {
        displayType: display.type,
        totalChars: contentLength,
        detail: { contentLength },
      };
    }
    default:
      return assertNever(display);
  }
}

// ---- Helper ----

function assertNever(value: never): never {
  throw new Error(`Unhandled tool call display: ${JSON.stringify(value)}`);
}

function formatValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  // Extract content from tool_result objects
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type: string }).type === "tool_result" &&
    "content" in value
  ) {
    const content = (value as { content: unknown }).content;
    if (typeof content === "string") {
      return content;
    }
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
    // Use pre-computed unified diff if available (e.g., from apply_patch)
    if (display.unifiedDiff) {
      return parseUnifiedDiff(display.unifiedDiff);
    }
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
          <Text selectable style={styles.scrollText}>{display.command}</Text>
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
              <Text selectable style={styles.scrollText}>{display.output}</Text>
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
              <Text selectable style={styles.scrollText}>{display.content}</Text>
            </ScrollView>
          </ScrollView>
        ) : null}
      </View>
    );
  } else if (display.type === "thinking") {
    // Thinking: display the content as plain text
    sections.push(
      <View key="thinking" style={styles.section}>
        <ScrollView
          style={[styles.scrollArea, { maxHeight }]}
          contentContainerStyle={styles.scrollContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator={true}
        >
          <Text selectable style={styles.scrollText}>{display.content}</Text>
        </ScrollView>
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
              <Text selectable style={styles.scrollText}>{pair.value}</Text>
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
              <Text selectable style={styles.scrollText}>{pair.value}</Text>
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
          <Text selectable style={[styles.scrollText, styles.errorText]}>
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
  const { toolName, args, result, error } = data;

  return useMemo(() => {
    const shouldLog = isPerfLoggingEnabled();
    const startMs = shouldLog ? getNowMs() : 0;
    const display = parseToolCallDisplay(toolName, args, result);
    const errorText = error !== undefined ? formatValue(error) : undefined;
    if (shouldLog) {
      const durationMs = getNowMs() - startMs;
      const summary = summarizeToolCallDisplay(display);
      if (
        durationMs >= TOOL_CALL_DETAILS_DURATION_THRESHOLD_MS ||
        summary.totalChars >= TOOL_CALL_DETAILS_SIZE_THRESHOLD
      ) {
        perfLog(TOOL_CALL_DETAILS_LOG_TAG, {
          event: "parse",
          durationMs: Math.round(durationMs),
          displayType: summary.displayType,
          totalChars: summary.totalChars,
          errorLength: errorText ? errorText.length : 0,
          ...summary.detail,
        });
      }
    }
    return { display, errorText };
  }, [toolName, args, result, error]);
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
    color: theme.colors.foregroundMuted,
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
    backgroundColor: theme.colors.surface2,
  },
  fileBadgeText: {
    color: theme.colors.foreground,
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.xs,
  },
  rangeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  diffContainer: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
  },
  scrollArea: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
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
    backgroundColor: theme.colors.surface2,
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
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontStyle: "italic",
  },
}));
