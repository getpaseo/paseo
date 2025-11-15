import React, { useCallback, useMemo } from "react";
import { View, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import type { SelectedToolCall } from "@/types/shared";
import {
  extractCommandDetails,
  extractEditEntries,
  extractReadEntries,
  type CommandDetails,
  type EditEntry,
  type ReadEntry,
} from "@/utils/tool-call-parsers";
import { DiffViewer } from "./diff-viewer";

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
  const { toolName, args, result, error, parsedEdits, parsedReads, parsedCommand } = useMemo(() => {
    if (!selectedToolCall) {
      return {
        toolName: "Tool Call",
        args: undefined,
        result: undefined,
        error: undefined,
        parsedEdits: undefined,
        parsedReads: undefined,
        parsedCommand: undefined,
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
        parsedEdits: data.parsedEdits,
        parsedReads: data.parsedReads,
        parsedCommand: data.parsedCommand,
      };
    }

    const data = payload.data;
    return {
      toolName: data.toolName,
      args: data.arguments,
      result: data.result,
      error: data.error,
      parsedEdits: undefined,
      parsedReads: undefined,
      parsedCommand: undefined,
    };
  }, [selectedToolCall]);

  const fallbackEditEntries = useMemo(() => extractEditEntries(args, result), [
    args,
    result,
  ]);
  const editEntries: EditEntry[] = parsedEdits ?? fallbackEditEntries;

  const fallbackReadEntries = useMemo(() => extractReadEntries(result, args), [
    args,
    result,
  ]);
  const readEntries: ReadEntry[] = parsedReads ?? fallbackReadEntries;

  const fallbackCommandDetails = useMemo(
    () => extractCommandDetails(args, result),
    [args, result]
  );
  const commandDetails: CommandDetails | null =
    parsedCommand ?? fallbackCommandDetails;

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
                <DiffViewer diffLines={entry.diffLines} />
              </View>
            </View>
          ))}

        {readEntries.length > 0 &&
          readEntries.map((entry, index) => (
            <View key={`${entry.filePath ?? "read"}-${index}`} style={styles.section}>
              <Text style={styles.sectionTitle}>Read Result</Text>
              {entry.filePath && (
                <View style={styles.fileInfoContainer}>
                  <Text style={styles.fileInfoText}>{entry.filePath}</Text>
                </View>
              )}
              <ScrollView
                style={styles.contentScroll}
                contentContainerStyle={styles.contentContainer}
                nestedScrollEnabled={true}
                showsVerticalScrollIndicator={true}
              >
                <Text style={styles.contentText}>{entry.content}</Text>
              </ScrollView>
            </View>
          ))}

        {commandDetails && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Command Output</Text>
            {commandDetails.command && (
              <View style={styles.commandMetaContainer}>
                <Text style={styles.commandMetaLabel}>Command</Text>
                <ScrollView horizontal nestedScrollEnabled={true} showsHorizontalScrollIndicator={true}>
                  <Text style={styles.commandMetaValue}>{commandDetails.command}</Text>
                </ScrollView>
              </View>
            )}
            {commandDetails.cwd && (
              <View style={styles.commandMetaContainer}>
                <Text style={styles.commandMetaLabel}>Directory</Text>
                <ScrollView horizontal nestedScrollEnabled={true} showsHorizontalScrollIndicator={true}>
                  <Text style={styles.commandMetaValue}>{commandDetails.cwd}</Text>
                </ScrollView>
              </View>
            )}
            {commandDetails.exitCode !== undefined && (
              <View style={styles.commandMetaContainer}>
                <Text style={styles.commandMetaLabel}>Exit Code</Text>
                <Text style={styles.commandMetaValue}>
                  {commandDetails.exitCode === null ? "Unknown" : commandDetails.exitCode}
                </Text>
              </View>
            )}
            {commandDetails.output && (
              <View style={styles.commandOutputContainer}>
                <Text style={styles.commandOutputLabel}>Output</Text>
                <ScrollView
                  style={styles.contentScroll}
                  contentContainerStyle={styles.contentContainer}
                  nestedScrollEnabled={true}
                  showsVerticalScrollIndicator={true}
                >
                  <Text style={styles.contentText}>{commandDetails.output}</Text>
                </ScrollView>
              </View>
            )}
          </View>
        )}

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
  contentScroll: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    maxHeight: 280,
  },
  contentContainer: {
    padding: theme.spacing[3],
  },
  contentText: {
    fontFamily: "monospace",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    lineHeight: 20,
  },
  errorContainer: {
    borderColor: theme.colors.destructive,
    backgroundColor: theme.colors.background,
  },
  errorText: {
    color: theme.colors.destructive,
  },
  commandMetaContainer: {
    marginBottom: theme.spacing[2],
  },
  commandMetaLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.mutedForeground,
    marginBottom: theme.spacing[1],
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  commandMetaValue: {
    fontFamily: "monospace",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  commandOutputContainer: {
    marginTop: theme.spacing[3],
  },
  commandOutputLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.mutedForeground,
    marginBottom: theme.spacing[1],
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
}));
