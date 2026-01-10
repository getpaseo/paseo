import React, {
  createContext,
  useContext,
  useCallback,
  useMemo,
  useRef,
  ReactNode,
} from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Fonts } from "@/constants/theme";
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetBackdrop,
} from "@gorhom/bottom-sheet";
import { Pencil, Eye, SquareTerminal, Search, Wrench, X } from "lucide-react-native";
import { DiffViewer } from "./diff-viewer";
import {
  extractKeyValuePairs,
  stripCwdPrefix,
  type EditEntry,
  type ReadEntry,
  type CommandDetails,
  type DiffLine,
  type KeyValuePair,
} from "@/utils/tool-call-parsers";

// ----- Types -----

export interface ToolCallSheetData {
  toolName: string;
  kind?: string;
  status?: "executing" | "completed" | "failed";
  args?: unknown;
  result?: unknown;
  error?: unknown;
  parsedEditEntries?: EditEntry[];
  parsedReadEntries?: ReadEntry[];
  parsedCommandDetails?: CommandDetails | null;
  cwd?: string;
}

interface ToolCallSheetContextValue {
  openToolCall: (data: ToolCallSheetData) => void;
  closeToolCall: () => void;
}

// ----- Context -----

const ToolCallSheetContext = createContext<ToolCallSheetContextValue | null>(null);

export function useToolCallSheet(): ToolCallSheetContextValue {
  const context = useContext(ToolCallSheetContext);
  if (!context) {
    throw new Error("useToolCallSheet must be used within a ToolCallSheetProvider");
  }
  return context;
}

// ----- Icon Mapping -----

const toolKindIcons: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  edit: Pencil,
  read: Eye,
  execute: SquareTerminal,
  search: Search,
};

// ----- Helper Functions -----

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

// Type guard for structured tool results
type StructuredToolResult = {
  type: "command" | "file_write" | "file_edit" | "file_read" | "generic";
  [key: string]: unknown;
};

function isStructuredToolResult(result: unknown): result is StructuredToolResult {
  return (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    typeof result.type === "string" &&
    ["command", "file_write", "file_edit", "file_read", "generic"].includes(result.type)
  );
}

// Build diff lines from before/after strings
function buildLineDiffFromStrings(originalText: string, updatedText: string): DiffLine[] {
  const splitIntoLines = (text: string): string[] => {
    if (!text) return [];
    return text.replace(/\r\n/g, "\n").split("\n");
  };

  const originalLines = splitIntoLines(originalText);
  const updatedLines = splitIntoLines(updatedText);

  const hasAnyContent = originalLines.length > 0 || updatedLines.length > 0;
  if (!hasAnyContent) return [];

  const m = originalLines.length;
  const n = updatedLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

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

// ----- Provider Component -----

interface ToolCallSheetProviderProps {
  children: ReactNode;
}

export function ToolCallSheetProvider({ children }: ToolCallSheetProviderProps) {
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const [sheetData, setSheetData] = React.useState<ToolCallSheetData | null>(null);

  const snapPoints = useMemo(() => ["60%", "90%"], []);

  const openToolCall = useCallback((data: ToolCallSheetData) => {
    setSheetData(data);
    bottomSheetRef.current?.present();
  }, []);

  const closeToolCall = useCallback(() => {
    bottomSheetRef.current?.dismiss();
  }, []);

  const handleSheetChange = useCallback((index: number) => {
    if (index === -1) {
      setSheetData(null);
    }
  }, []);

  const renderBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
      />
    ),
    []
  );

  const contextValue = useMemo(
    () => ({ openToolCall, closeToolCall }),
    [openToolCall, closeToolCall]
  );

  return (
    <ToolCallSheetContext.Provider value={contextValue}>
      {children}
      <BottomSheetModal
        ref={bottomSheetRef}
        snapPoints={snapPoints}
        onChange={handleSheetChange}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
        backgroundStyle={styles.sheetBackground}
        handleIndicatorStyle={styles.handleIndicator}
      >
        {sheetData && <ToolCallSheetContent data={sheetData} onClose={closeToolCall} />}
      </BottomSheetModal>
    </ToolCallSheetContext.Provider>
  );
}

// ----- Sheet Content Component -----

interface ToolCallSheetContentProps {
  data: ToolCallSheetData;
  onClose: () => void;
}

function ToolCallSheetContent({ data, onClose }: ToolCallSheetContentProps) {
  const {
    toolName,
    kind,
    status,
    args,
    result,
    error,
    parsedEditEntries,
    parsedReadEntries,
    parsedCommandDetails,
    cwd,
  } = data;

  const IconComponent = kind
    ? toolKindIcons[kind.toLowerCase()] || Wrench
    : Wrench;

  const serializedArgs = useMemo(
    () => (args !== undefined ? formatValue(args) : ""),
    [args]
  );
  const serializedResult = useMemo(
    () => (result !== undefined ? formatValue(result) : ""),
    [result]
  );
  const serializedError = useMemo(
    () => (error !== undefined ? formatValue(error) : ""),
    [error]
  );

  // Check if result has a type field for structured rendering
  const structuredResult = useMemo(
    () => (isStructuredToolResult(result) ? result : null),
    [result]
  );

  // Extract functions for structured results
  const extractCommandFromStructured = useCallback(
    (structured: StructuredToolResult): CommandDetails | null => {
      if (structured.type !== "command") return null;

      const cmd: CommandDetails = {};
      if (typeof structured.command === "string") cmd.command = structured.command;
      if (typeof structured.cwd === "string") cmd.cwd = structured.cwd;
      if (typeof structured.output === "string") cmd.output = structured.output;
      if (typeof structured.exitCode === "number") cmd.exitCode = structured.exitCode;

      return cmd.command || cmd.output ? cmd : null;
    },
    []
  );

  const extractDiffFromStructured = useCallback(
    (structured: StructuredToolResult): EditEntry[] => {
      if (structured.type !== "file_write" && structured.type !== "file_edit") {
        return [];
      }

      const filePath = typeof structured.filePath === "string" ? structured.filePath : undefined;

      if (structured.type === "file_write") {
        const oldContent = typeof structured.oldContent === "string" ? structured.oldContent : "";
        const newContent = typeof structured.newContent === "string" ? structured.newContent : "";
        const diffLines = buildLineDiffFromStrings(oldContent, newContent);
        if (diffLines.length > 0) {
          return [{ filePath, diffLines }];
        }
      }

      if (structured.type === "file_edit") {
        if (Array.isArray(structured.diffLines)) {
          return [{ filePath, diffLines: structured.diffLines as DiffLine[] }];
        }
        const oldContent = typeof structured.oldContent === "string" ? structured.oldContent : "";
        const newContent = typeof structured.newContent === "string" ? structured.newContent : "";
        const diffLines = buildLineDiffFromStrings(oldContent, newContent);
        if (diffLines.length > 0) {
          return [{ filePath, diffLines }];
        }
      }

      return [];
    },
    []
  );

  const extractReadFromStructured = useCallback(
    (structured: StructuredToolResult): ReadEntry[] => {
      if (structured.type !== "file_read") return [];

      const filePath = typeof structured.filePath === "string" ? structured.filePath : undefined;
      const content = typeof structured.content === "string" ? structured.content : "";

      if (content) {
        return [{ filePath, content }];
      }

      return [];
    },
    []
  );

  // Render content sections
  const renderSections = useCallback(() => {
    const sections: ReactNode[] = [];
    let hasOutput = false;

    // Always show args first if available
    if (args !== undefined) {
      // Add Input group header
      sections.push(
        <View key="input-header" style={styles.groupHeader}>
          <Text style={styles.groupHeaderText}>Input</Text>
        </View>
      );

      const argPairs = extractKeyValuePairs(args);
      if (argPairs.length > 0) {
        argPairs.forEach((pair, index) => {
          sections.push(
            <View key={`arg-${index}-${pair.key}`} style={styles.section}>
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
      } else {
        // Fallback to raw JSON display
        sections.push(
          <View key="args" style={styles.section}>
            <Text style={styles.sectionTitle}>Arguments</Text>
            <ScrollView
              horizontal
              nestedScrollEnabled
              style={styles.jsonScroll}
              contentContainerStyle={styles.jsonContent}
              showsHorizontalScrollIndicator={true}
            >
              <Text style={styles.scrollText}>{serializedArgs}</Text>
            </ScrollView>
          </View>
        );
      }
    }

    // Helper to add output header once
    const addOutputHeader = () => {
      if (!hasOutput) {
        hasOutput = true;
        sections.push(
          <View key="output-header" style={styles.groupHeader}>
            <Text style={styles.groupHeaderText}>Output</Text>
          </View>
        );
      }
    };

    // Render based on structured result type or raw data
    if (structuredResult) {
      switch (structuredResult.type) {
        case "command": {
          const cmd = parsedCommandDetails ?? extractCommandFromStructured(structuredResult);
          if (cmd) {
            addOutputHeader();
            sections.push(
              <View key="command" style={styles.section}>
                <Text style={styles.sectionTitle}>Command</Text>
                {cmd.command ? (
                  <ScrollView
                    horizontal
                    nestedScrollEnabled
                    style={styles.jsonScroll}
                    contentContainerStyle={styles.jsonContent}
                    showsHorizontalScrollIndicator={true}
                  >
                    <Text style={styles.scrollText}>{cmd.command}</Text>
                  </ScrollView>
                ) : null}
                {cmd.cwd ? (
                  <View style={styles.metaRow}>
                    <Text style={styles.metaLabel}>Directory</Text>
                    <Text style={styles.metaValue}>{cmd.cwd}</Text>
                  </View>
                ) : null}
                {cmd.exitCode !== undefined ? (
                  <View style={styles.metaRow}>
                    <Text style={styles.metaLabel}>Exit Code</Text>
                    <Text style={styles.metaValue}>
                      {cmd.exitCode === null ? "Unknown" : cmd.exitCode}
                    </Text>
                  </View>
                ) : null}
                {cmd.output ? (
                  <ScrollView
                    style={styles.scrollArea}
                    contentContainerStyle={styles.scrollContent}
                    nestedScrollEnabled
                    showsVerticalScrollIndicator={true}
                  >
                    <Text style={styles.scrollText}>{cmd.output}</Text>
                  </ScrollView>
                ) : null}
              </View>
            );
          }
          break;
        }

        case "file_write":
        case "file_edit": {
          const diffs = parsedEditEntries?.length
            ? parsedEditEntries
            : extractDiffFromStructured(structuredResult);
          if (diffs.length > 0) {
            addOutputHeader();
          }
          diffs.forEach((entry, index) => {
            sections.push(
              <View key={`diff-${index}`} style={styles.section}>
                <Text style={styles.sectionTitle}>Diff</Text>
                {entry.filePath ? (
                  <View style={styles.fileBadge}>
                    <Text style={styles.fileBadgeText}>{stripCwdPrefix(entry.filePath, cwd)}</Text>
                  </View>
                ) : null}
                <View style={styles.diffContainer}>
                  <DiffViewer diffLines={entry.diffLines} maxHeight={300} />
                </View>
              </View>
            );
          });
          break;
        }

        case "file_read": {
          const reads = parsedReadEntries?.length
            ? parsedReadEntries
            : extractReadFromStructured(structuredResult);
          if (reads.length > 0) {
            addOutputHeader();
          }
          reads.forEach((entry, index) => {
            sections.push(
              <View key={`read-${index}`} style={styles.section}>
                <Text style={styles.sectionTitle}>Read Result</Text>
                {entry.filePath ? (
                  <View style={styles.fileBadge}>
                    <Text style={styles.fileBadgeText}>{stripCwdPrefix(entry.filePath, cwd)}</Text>
                  </View>
                ) : null}
                <ScrollView
                  style={styles.scrollArea}
                  contentContainerStyle={styles.scrollContent}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator={true}
                >
                  <Text style={styles.scrollText}>{entry.content}</Text>
                </ScrollView>
              </View>
            );
          });
          break;
        }

        case "generic":
        default: {
          if (result !== undefined && sections.length === 1) {
            // Only args shown, add result
            addOutputHeader();
            sections.push(
              <View key="result" style={styles.section}>
                <Text style={styles.sectionTitle}>Result</Text>
                <ScrollView
                  horizontal
                  nestedScrollEnabled
                  style={styles.jsonScroll}
                  contentContainerStyle={styles.jsonContent}
                  showsHorizontalScrollIndicator={true}
                >
                  <Text style={styles.scrollText}>{serializedResult}</Text>
                </ScrollView>
              </View>
            );
          }
          break;
        }
      }
    } else if (result !== undefined) {
      // No structured result - try to extract key-value pairs
      addOutputHeader();
      const keyValuePairs = extractKeyValuePairs(result);
      if (keyValuePairs.length > 0) {
        keyValuePairs.forEach((pair, index) => {
          sections.push(
            <View key={`kv-${index}-${pair.key}`} style={styles.section}>
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
      } else {
        // Fallback to raw JSON display
        sections.push(
          <View key="result" style={styles.section}>
            <Text style={styles.sectionTitle}>Result</Text>
            <ScrollView
              horizontal
              nestedScrollEnabled
              style={styles.jsonScroll}
              contentContainerStyle={styles.jsonContent}
              showsHorizontalScrollIndicator={true}
            >
              <Text style={styles.scrollText}>{serializedResult}</Text>
            </ScrollView>
          </View>
        );
      }
    }

    // Always show errors if available
    if (error !== undefined) {
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
            <Text style={[styles.scrollText, styles.errorText]}>{serializedError}</Text>
          </ScrollView>
        </View>
      );
    }

    if (sections.length === 0) {
      return (
        <Text style={styles.emptyStateText}>No additional details available</Text>
      );
    }

    return sections;
  }, [
    args,
    result,
    error,
    serializedArgs,
    serializedResult,
    serializedError,
    structuredResult,
    parsedEditEntries,
    parsedReadEntries,
    parsedCommandDetails,
    extractCommandFromStructured,
    extractDiffFromStructured,
    extractReadFromStructured,
  ]);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <IconComponent size={20} color={styles.headerIcon.color} />
          <Text style={styles.headerTitle} numberOfLines={1}>
            {toolName}
          </Text>
          {status && (
            <View
              style={[
                styles.statusBadge,
                status === "executing" && styles.statusExecuting,
                status === "completed" && styles.statusCompleted,
                status === "failed" && styles.statusFailed,
              ]}
            >
              <Text
                style={[
                  styles.statusText,
                  status === "executing" && styles.statusTextExecuting,
                  status === "completed" && styles.statusTextCompleted,
                  status === "failed" && styles.statusTextFailed,
                ]}
              >
                {status === "executing" ? "Running" : status === "completed" ? "Done" : "Failed"}
              </Text>
            </View>
          )}
        </View>
        <Pressable onPress={onClose} style={styles.closeButton}>
          <X size={20} color={styles.closeIcon.color} />
        </Pressable>
      </View>

      {/* Content */}
      <BottomSheetScrollView
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
      >
        {renderSections()}
      </BottomSheetScrollView>
    </View>
  );
}

// ----- Styles -----

const styles = StyleSheet.create((theme) => ({
  sheetBackground: {
    backgroundColor: theme.colors.card,
  },
  handleIndicator: {
    backgroundColor: theme.colors.palette.zinc[600],
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.card,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
  },
  headerIcon: {
    color: theme.colors.foreground,
  },
  headerTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flex: 1,
  },
  statusBadge: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
  },
  statusExecuting: {
    backgroundColor: theme.colors.palette.blue[900],
  },
  statusCompleted: {
    backgroundColor: theme.colors.palette.green[900],
  },
  statusFailed: {
    backgroundColor: theme.colors.palette.red[900],
  },
  statusText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  statusTextExecuting: {
    color: theme.colors.palette.blue[200],
  },
  statusTextCompleted: {
    color: theme.colors.palette.green[200],
  },
  statusTextFailed: {
    color: theme.colors.palette.red[200],
  },
  closeButton: {
    padding: theme.spacing[2],
  },
  closeIcon: {
    color: theme.colors.mutedForeground,
  },
  content: {
    flex: 1,
    backgroundColor: theme.colors.card,
  },
  contentContainer: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[8],
    gap: theme.spacing[6],
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
    maxHeight: 260,
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
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  metaLabel: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  metaValue: {
    color: theme.colors.foreground,
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.xs,
    flex: 1,
  },
}));
