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
import { parseToolCallDisplay, buildLineDiff, type DiffLine } from "@/utils/tool-call-parsers";
import { DiffViewer } from "./diff-viewer";

// ----- Types -----

export interface ToolCallSheetData {
  toolName: string;
  kind?: string;
  status?: "executing" | "completed" | "failed";
  args?: unknown;
  result?: unknown;
  error?: unknown;
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

// ----- Provider Component -----

interface ToolCallSheetProviderProps {
  children: ReactNode;
}

export function ToolCallSheetProvider({ children }: ToolCallSheetProviderProps) {
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const [sheetData, setSheetData] = React.useState<ToolCallSheetData | null>(null);

  const snapPoints = useMemo(() => ["60%", "95%"], []);

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
        index={0}
        enableDynamicSizing={false}
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
  const { toolName, kind, args, result, error } = data;

  const IconComponent = kind
    ? toolKindIcons[kind.toLowerCase()] || Wrench
    : Wrench;

  const serializedError = useMemo(
    () => (error !== undefined ? formatValue(error) : ""),
    [error]
  );

  // Parse tool call display using discriminated union
  const toolCallDisplay = useMemo(
    () => parseToolCallDisplay(args, result),
    [args, result]
  );

  // Compute diff lines for edit type
  const editDiffLines = useMemo((): DiffLine[] => {
    if (toolCallDisplay.type !== "edit") return [];
    return buildLineDiff(toolCallDisplay.oldString, toolCallDisplay.newString);
  }, [toolCallDisplay]);

  // Render content sections
  const renderSections = useCallback(() => {
    const sections: ReactNode[] = [];

    if (toolCallDisplay.type === "shell") {
      // Shell tool: show command and output as single block
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
            <Text style={styles.scrollText}>{toolCallDisplay.command}</Text>
          </ScrollView>
          {toolCallDisplay.output ? (
            <ScrollView
              style={styles.scrollArea}
              contentContainerStyle={styles.scrollContent}
              nestedScrollEnabled
              showsVerticalScrollIndicator={true}
            >
              <ScrollView
                horizontal
                nestedScrollEnabled
                showsHorizontalScrollIndicator={true}
              >
                <Text style={styles.scrollText}>{toolCallDisplay.output}</Text>
              </ScrollView>
            </ScrollView>
          ) : null}
        </View>
      );
    } else if (toolCallDisplay.type === "edit") {
      // Edit tool: show file path and diff
      sections.push(
        <View key="edit" style={styles.section}>
          <Text style={styles.sectionTitle}>File</Text>
          <View style={styles.fileBadge}>
            <Text style={styles.fileBadgeText}>{toolCallDisplay.filePath}</Text>
          </View>
          {editDiffLines.length > 0 ? (
            <View style={styles.diffContainer}>
              <DiffViewer diffLines={editDiffLines} maxHeight={300} />
            </View>
          ) : null}
        </View>
      );
    } else {
      // Generic tool: show input/output as key-value pairs
      if (toolCallDisplay.input.length > 0) {
        sections.push(
          <View key="input-header" style={styles.groupHeader}>
            <Text style={styles.groupHeaderText}>Input</Text>
          </View>
        );
        toolCallDisplay.input.forEach((pair, index) => {
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

      if (toolCallDisplay.output.length > 0) {
        sections.push(
          <View key="output-header" style={styles.groupHeader}>
            <Text style={styles.groupHeaderText}>Output</Text>
          </View>
        );
        toolCallDisplay.output.forEach((pair, index) => {
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
  }, [toolCallDisplay, editDiffLines, error, serializedError]);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <IconComponent size={20} color={styles.headerIcon.color} />
          <Text style={styles.headerTitle} numberOfLines={1}>
            {toolName}
          </Text>
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
}));
