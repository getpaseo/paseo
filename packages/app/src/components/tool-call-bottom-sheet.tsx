import React, { useCallback, useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import {
  BottomSheetModal,
  BottomSheetView,
  BottomSheetScrollView,
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";

interface ToolCallBottomSheetProps {
  bottomSheetRef: React.RefObject<BottomSheetModal | null>;
  toolName?: string;
  status?: "pending" | "in_progress" | "executing" | "completed" | "failed";
  args?: any;
  result?: any;
  error?: any;
}

export function ToolCallBottomSheet({
  bottomSheetRef,
  toolName,
  status,
  args,
  result,
  error,
}: ToolCallBottomSheetProps) {
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

  const statusColor = useMemo(() => {
    switch (status) {
      case "completed":
        return "#22c55e";
      case "failed":
        return "#ef4444";
      case "executing":
      case "in_progress":
        return "#3b82f6";
      case "pending":
      default:
        return "#6b7280";
    }
  }, [status]);

  const statusLabel = useMemo(() => {
    switch (status) {
      case "in_progress":
      case "executing":
        return "Executing";
      case "completed":
        return "Completed";
      case "failed":
        return "Failed";
      case "pending":
      default:
        return "Pending";
    }
  }, [status]);

  return (
    <BottomSheetModal
      ref={bottomSheetRef}
      snapPoints={snapPoints}
      backdropComponent={renderBackdrop}
      enablePanDownToClose={true}
      handleIndicatorStyle={styles.handleIndicator}
      backgroundStyle={styles.background}
    >
      <BottomSheetView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.toolName}>{toolName || "Tool Call"}</Text>
          <View style={[styles.statusBadge, { backgroundColor: statusColor }]}>
            <Text style={styles.statusText}>{statusLabel}</Text>
          </View>
        </View>

        <BottomSheetScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
        >
          {args !== undefined && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Arguments</Text>
              <View style={styles.jsonContainer}>
                <Text style={styles.jsonText}>
                  {JSON.stringify(args, null, 2)}
                </Text>
              </View>
            </View>
          )}

          {result !== undefined && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Result</Text>
              <View style={styles.jsonContainer}>
                <Text style={styles.jsonText}>
                  {JSON.stringify(result, null, 2)}
                </Text>
              </View>
            </View>
          )}

          {error !== undefined && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Error</Text>
              <View style={[styles.jsonContainer, styles.errorContainer]}>
                <Text style={[styles.jsonText, styles.errorText]}>
                  {JSON.stringify(error, null, 2)}
                </Text>
              </View>
            </View>
          )}
        </BottomSheetScrollView>
      </BottomSheetView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1f2937",
  },
  handleIndicator: {
    backgroundColor: "#4b5563",
  },
  background: {
    backgroundColor: "#1f2937",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#374151",
  },
  toolName: {
    fontSize: 18,
    fontWeight: "600",
    color: "#f9fafb",
    flex: 1,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    marginLeft: 12,
  },
  statusText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#fff",
    textTransform: "capitalize",
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  section: {
    marginBottom: 20,
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
    padding: 12,
    borderWidth: 1,
    borderColor: "#374151",
  },
  jsonText: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "#e5e7eb",
    lineHeight: 18,
  },
  errorContainer: {
    borderColor: "#ef4444",
    backgroundColor: "#1f1416",
  },
  errorText: {
    color: "#fca5a5",
  },
});
