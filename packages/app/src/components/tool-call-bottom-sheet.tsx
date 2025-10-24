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

    if (payload.source === "acp") {
      const data = payload.data;

      const content = data.content
        ?.flatMap((item) => {
          if (item.type === "content" && item.content.type === "text") {
            return [item.content.text];
          }
          return [];
        })
        .join("\n");

      return {
        toolName: data.kind ?? "Unknown Tool",
        args: data.rawInput,
        result: content,
        error: undefined, // ACP doesn't have a separate error field
      };
    } else {
      // Orchestrator tool call
      const data = payload.data;
      return {
        toolName: data.toolName,
        args: data.arguments,
        result: data.result,
        error: data.error,
      };
    }
  }, [selectedToolCall]);

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
