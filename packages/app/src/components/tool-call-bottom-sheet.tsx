import React, { useCallback, useMemo } from "react";
import { View, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import {
  BottomSheetModal,
  BottomSheetView,
  BottomSheetScrollView,
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import type { SelectedToolCall } from "@/types/shared";

type DiffLine = {
  type: "add" | "remove" | "context" | "header";
  content: string;
};

type EditEntry = {
  filePath?: string;
  diffLines: DiffLine[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function splitIntoLines(text: string): string[] {
  if (!text) {
    return [];
  }

  return text.replace(/\r\n/g, "\n").split("\n");
}

function buildLineDiff(originalText: string, updatedText: string): DiffLine[] {
  const originalLines = splitIntoLines(originalText);
  const updatedLines = splitIntoLines(updatedText);

  const hasAnyContent = originalLines.length > 0 || updatedLines.length > 0;
  if (!hasAnyContent) {
    return [];
  }

  const m = originalLines.length;
  const n = updatedLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (originalLines[i] === updatedLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const diff: DiffLine[] = [];

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (originalLines[i] === updatedLines[j]) {
      diff.push({ type: "context", content: ` ${originalLines[i]}` });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      diff.push({ type: "remove", content: `-${originalLines[i]}` });
      i += 1;
    } else {
      diff.push({ type: "add", content: `+${updatedLines[j]}` });
      j += 1;
    }
  }

  while (i < m) {
    diff.push({ type: "remove", content: `-${originalLines[i]}` });
    i += 1;
  }

  while (j < n) {
    diff.push({ type: "add", content: `+${updatedLines[j]}` });
    j += 1;
  }

  return diff;
}

function parseUnifiedDiff(diffText?: string): DiffLine[] {
  if (!diffText) {
    return [];
  }

  const lines = splitIntoLines(diffText);
  const diff: DiffLine[] = [];

  for (const line of lines) {
    if (!line.length) {
      diff.push({ type: "context", content: line });
      continue;
    }

    if (line.startsWith("@@")) {
      diff.push({ type: "header", content: line });
      continue;
    }

    if (line.startsWith("+")) {
      if (!line.startsWith("+++")) {
        diff.push({ type: "add", content: line });
      }
      continue;
    }

    if (line.startsWith("-")) {
      if (!line.startsWith("---")) {
        diff.push({ type: "remove", content: line });
      }
      continue;
    }

    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++")
    ) {
      continue;
    }

    if (line.startsWith("\\ No newline")) {
      diff.push({ type: "header", content: line });
      continue;
    }

    diff.push({ type: "context", content: line });
  }

  return diff;
}

function deriveDiffLines({
  unifiedDiff,
  original,
  updated,
}: {
  unifiedDiff?: string;
  original?: string;
  updated?: string;
}): DiffLine[] {
  if (unifiedDiff) {
    const parsed = parseUnifiedDiff(unifiedDiff);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  if (original !== undefined || updated !== undefined) {
    return buildLineDiff(original ?? "", updated ?? "");
  }

  return [];
}

interface ToolCallBottomSheetProps {
  bottomSheetRef: React.RefObject<BottomSheetModal | null>;
  selectedToolCall: SelectedToolCall | null;
  onDismiss: () => void;
}

export function ToolCallBottomSheet({
  bottomSheetRef,
  selectedToolCall,
  onDismiss,
}: ToolCallBottomSheetProps) {
  const insets = useSafeAreaInsets();
  const snapPoints = useMemo(() => ["80%"], []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
      />
    ),
    []
  );

  // Extract data based on source
  const { toolName, args, result, error } = useMemo(() => {
    if (!selectedToolCall) {
      return {
        toolName: "Tool Call",
        args: undefined,
        result: undefined,
        error: undefined,
      };
    }

    const { payload } = selectedToolCall;

    if (payload.source === "agent") {
      const data = payload.data;
      return {
        toolName: data.displayName ?? `${data.server}/${data.tool}`,
        args: data.raw,
        result: data.result,
        error: data.error,
      };
    }

    const data = payload.data;
    return {
      toolName: data.toolName,
      args: data.arguments,
      result: data.result,
      error: data.error,
    };
  }, [selectedToolCall]);

  const editEntries = useMemo(() => {
    if (!args || !isRecord(args)) {
      return [] as EditEntry[];
    }

    const rawArgs = args as Record<string, unknown>;
    const changesValue = rawArgs["changes"];

    if (isRecord(changesValue)) {
      const changeEntries = Object.entries(
        changesValue as Record<string, unknown>
      );

      return changeEntries
        .map<EditEntry | null>(([filePath, value]) => {
          if (!isRecord(value)) {
            return null;
          }

          let changeBlock: Record<string, unknown> | null = null;
          if (isRecord(value["update"])) {
            changeBlock = value["update"] as Record<string, unknown>;
          } else if (isRecord(value["create"])) {
            changeBlock = value["create"] as Record<string, unknown>;
          } else if (isRecord(value["delete"])) {
            changeBlock = value["delete"] as Record<string, unknown>;
          } else {
            changeBlock = value;
          }

          if (!changeBlock) {
            return null;
          }

          const diffLines = deriveDiffLines({
            unifiedDiff: getString(
              changeBlock["unified_diff"] ??
                changeBlock["diff"] ??
                changeBlock["patch"] ??
                changeBlock["unifiedDiff"]
            ),
            original:
              getString(
                changeBlock["old_content"] ??
                  changeBlock["oldContent"] ??
                  changeBlock["old_string"] ??
                  changeBlock["previous_content"] ??
                  changeBlock["previousContent"] ??
                  changeBlock["base_content"] ??
                  changeBlock["baseContent"]
              ) ?? undefined,
            updated:
              getString(
                changeBlock["new_content"] ??
                  changeBlock["newContent"] ??
                  changeBlock["new_string"] ??
                  changeBlock["content"] ??
                  changeBlock["replace_with"] ??
                  changeBlock["replaceWith"]
              ) ?? undefined,
          });

          return {
            filePath,
            diffLines,
          };
        })
        .filter((entry): entry is EditEntry => Boolean(entry));
    }

    const filePath =
      getString(
        rawArgs["file_path"] ?? rawArgs["filePath"] ?? rawArgs["path"]
      ) || undefined;
    const diffLines = deriveDiffLines({
      original:
        getString(
          rawArgs["old_string"] ??
            rawArgs["oldString"] ??
            rawArgs["old_content"] ??
            rawArgs["previous_content"] ??
            rawArgs["base_content"]
        ) ?? undefined,
      updated:
        getString(
          rawArgs["new_string"] ??
            rawArgs["newString"] ??
            rawArgs["new_content"] ??
            rawArgs["content"]
        ) ?? undefined,
    });

    if (!filePath && diffLines.length === 0) {
      return [];
    }

    return [
      {
        filePath,
        diffLines,
      },
    ];
  }, [args]);

  return (
    <BottomSheetModal
      ref={bottomSheetRef}
      snapPoints={snapPoints}
      backdropComponent={renderBackdrop}
      enablePanDownToClose={true}
      handleIndicatorStyle={styles.handleIndicator}
      backgroundStyle={styles.background}
      topInset={insets.top}
      onDismiss={onDismiss}
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.toolName}>{toolName || "Tool Call"}</Text>
      </View>

      {/* Scrollable content */}
      <BottomSheetScrollView
        contentContainerStyle={styles.sheetContent}
        showsVerticalScrollIndicator={true}
      >
        {editEntries.length > 0 &&
          editEntries.map((entry, index) => (
            <View key={`${entry.filePath ?? "file"}-${index}`} style={styles.section}>
              <Text style={styles.sectionTitle}>File</Text>
              <View style={styles.fileInfoContainer}>
                <Text style={styles.fileInfoText}>
                  {entry.filePath ?? "Unknown file"}
                </Text>
              </View>

              <Text style={styles.sectionTitle}>Diff</Text>
              <View style={styles.diffContainer}>
                {entry.diffLines.length === 0 ? (
                  <View style={styles.diffEmptyState}>
                    <Text style={styles.diffEmptyText}>No changes to display</Text>
                  </View>
                ) : (
                  <ScrollView
                    style={styles.diffScrollVertical}
                    contentContainerStyle={styles.diffVerticalContent}
                    nestedScrollEnabled
                    showsVerticalScrollIndicator
                  >
                    <ScrollView
                      horizontal
                      nestedScrollEnabled
                      showsHorizontalScrollIndicator
                      contentContainerStyle={styles.diffScrollContent}
                    >
                      <View style={styles.diffLinesContainer}>
                        {entry.diffLines.map((line, lineIndex) => (
                          <View
                            key={`${line.type}-${lineIndex}`}
                            style={[
                              styles.diffLine,
                              line.type === "header" && styles.diffHeaderLine,
                              line.type === "add" && styles.diffAddLine,
                              line.type === "remove" && styles.diffRemoveLine,
                              line.type === "context" && styles.diffContextLine,
                            ]}
                          >
                            <Text
                              style={[
                                styles.diffLineText,
                                line.type === "header" && styles.diffHeaderText,
                                line.type === "add" && styles.diffAddText,
                                line.type === "remove" && styles.diffRemoveText,
                                line.type === "context" && styles.diffContextText,
                              ]}
                            >
                              {line.content}
                            </Text>
                          </View>
                        ))}
                      </View>
                    </ScrollView>
                  </ScrollView>
                )}
              </View>
            </View>
          ))}

        {/* Content sections */}
        {args !== undefined && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Arguments</Text>
            <ScrollView
              horizontal
              style={styles.jsonContainer}
              contentContainerStyle={styles.jsonContent}
              showsHorizontalScrollIndicator={true}
              nestedScrollEnabled={true}
            >
              <Text style={styles.jsonText}>
                {JSON.stringify(args, null, 2)}
              </Text>
            </ScrollView>
          </View>
        )}

        {result !== undefined && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Result</Text>
            <ScrollView
              horizontal
              style={styles.jsonContainer}
              contentContainerStyle={styles.jsonContent}
              showsHorizontalScrollIndicator={true}
              nestedScrollEnabled={true}
            >
              <Text style={styles.jsonText}>
                {typeof result === "string"
                  ? result
                  : JSON.stringify(result, null, 2)}
              </Text>
            </ScrollView>
          </View>
        )}

        {error !== undefined && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Error</Text>
            <ScrollView
              horizontal
              style={[styles.jsonContainer, styles.errorContainer]}
              contentContainerStyle={styles.jsonContent}
              showsHorizontalScrollIndicator={true}
              nestedScrollEnabled={true}
            >
              <Text style={[styles.jsonText, styles.errorText]}>
                {JSON.stringify(error, null, 2)}
              </Text>
            </ScrollView>
          </View>
        )}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create((theme) => ({
  handleIndicator: {
    backgroundColor: theme.colors.border,
  },
  background: {
    backgroundColor: theme.colors.popover,
  },
  header: {
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[4],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.popover,
  },
  toolName: {
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.popoverForeground,
  },
  sheetContent: {
    paddingTop: theme.spacing[6],
    paddingBottom: theme.spacing[6],
  },
  section: {
    marginBottom: theme.spacing[6],
    paddingHorizontal: theme.spacing[6],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.mutedForeground,
    marginBottom: theme.spacing[2],
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  fileInfoContainer: {
    backgroundColor: theme.colors.background,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    padding: theme.spacing[3],
    marginBottom: theme.spacing[4],
  },
  fileInfoText: {
    fontFamily: "monospace",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  diffContainer: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    overflow: "hidden",
  },
  diffScrollVertical: {
    maxHeight: 280,
  },
  diffVerticalContent: {
    flexGrow: 1,
  },
  diffScrollContent: {
    flexDirection: "column" as const,
  },
  diffLinesContainer: {
    alignSelf: "flex-start",
  },
  diffLine: {
    minWidth: "100%",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  diffLineText: {
    fontFamily: "monospace",
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  diffHeaderLine: {
    backgroundColor: theme.colors.muted,
  },
  diffHeaderText: {
    color: theme.colors.mutedForeground,
  },
  diffAddLine: {
    backgroundColor: theme.colors.palette.green[900],
  },
  diffAddText: {
    color: theme.colors.palette.green[200],
  },
  diffRemoveLine: {
    backgroundColor: theme.colors.palette.red[900],
  },
  diffRemoveText: {
    color: theme.colors.palette.red[200],
  },
  diffContextLine: {
    backgroundColor: theme.colors.card,
  },
  diffContextText: {
    color: theme.colors.mutedForeground,
  },
  diffEmptyState: {
    padding: theme.spacing[4],
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  diffEmptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.mutedForeground,
  },
  jsonContainer: {
    backgroundColor: theme.colors.background,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    // Natural height based on content
  },
  jsonContent: {
    padding: theme.spacing[3],
  },
  jsonText: {
    fontFamily: "monospace",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    lineHeight: 20,
    // Text maintains whitespace and formatting
  },
  errorContainer: {
    borderColor: theme.colors.destructive,
    backgroundColor: theme.colors.background,
  },
  errorText: {
    color: theme.colors.destructive,
  },
}));
