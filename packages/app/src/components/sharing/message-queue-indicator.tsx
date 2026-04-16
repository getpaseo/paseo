import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { SharedSessionQueueItem } from "@/hooks/sharing";

interface MessageQueueIndicatorProps {
  queue: SharedSessionQueueItem[];
}

export function MessageQueueIndicator({ queue }: MessageQueueIndicatorProps) {
  const { theme } = useUnistyles();

  if (queue.length === 0) return null;

  const processing = queue.find((m) => m.status === "processing");
  const waiting = queue.filter((m) => m.status === "queued").length;

  return (
    <View style={styles.container}>
      {processing && (
        <Text style={styles.processingText} numberOfLines={1}>
          Sending: {processing.username} — {processing.content}
        </Text>
      )}
      {waiting > 0 && (
        <Text style={styles.queuedText}>
          {waiting} message{waiting > 1 ? "s" : ""} queued
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  processingText: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  queuedText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
