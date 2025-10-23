import React, { useCallback, useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScrollView } from "react-native-gesture-handler";
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
}

export function ToolCallBottomSheet({
  bottomSheetRef,
  selectedToolCall,
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

const styles = StyleSheet.create({
  handleIndicator: {
    backgroundColor: "#4b5563",
  },
  background: {
    backgroundColor: "#1f2937",
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#374151",
    backgroundColor: "#1f2937",
  },
  toolName: {
    fontSize: 18,
    fontWeight: "600",
    color: "#f9fafb",
  },
  sheetContent: {
    paddingTop: 20,
    paddingBottom: 20,
  },
  section: {
    marginBottom: 20,
    paddingHorizontal: 20,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#9ca3af",
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  jsonContainer: {
    backgroundColor: "#111827",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#374151",
    // Natural height based on content
  },
  jsonContent: {
    padding: 12,
  },
  jsonText: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "#e5e7eb",
    lineHeight: 18,
    // Text maintains whitespace and formatting
  },
  errorContainer: {
    borderColor: "#ef4444",
    backgroundColor: "#1f1416",
  },
  errorText: {
    color: "#fca5a5",
  },
});
