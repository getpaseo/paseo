import { useState, useMemo } from "react";
import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import * as Clipboard from "expo-clipboard";
import { Check, Copy, X } from "lucide-react-native";

export interface AudioDebugInfo {
  requestId?: string | null;
  transcript?: string;
  debugRecordingPath?: string;
  format?: string;
  byteLength?: number;
  duration?: number;
  avgLogprob?: number;
  isLowConfidence?: boolean;
}

interface AudioDebugNoticeProps {
  info: AudioDebugInfo | null;
  onDismiss?: () => void;
  title?: string;
}

function formatBytes(bytes?: number): string | null {
  if (!bytes || bytes <= 0) {
    return null;
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDuration(duration?: number): string | null {
  if (!duration || duration <= 0) {
    return null;
  }
  const seconds = duration / 1000;
  if (seconds < 1) {
    return `${(seconds * 1000).toFixed(0)} ms`;
  }
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
}

export function AudioDebugNotice({ info, onDismiss, title = "Dictation Debug" }: AudioDebugNoticeProps) {
  const { theme } = useUnistyles();
  const [copied, setCopied] = useState(false);

  const stats = useMemo(() => {
    if (!info) {
      return null;
    }
    const parts: string[] = [];
    if (info.format) {
      parts.push(info.format);
    }
    const size = formatBytes(info.byteLength);
    if (size) {
      parts.push(size);
    }
    const duration = formatDuration(info.duration);
    if (duration) {
      parts.push(duration);
    }
    if (info.avgLogprob !== undefined) {
      const label = `${info.avgLogprob.toFixed(2)} avg logprob`;
      parts.push(info.isLowConfidence ? `${label} (low confidence)` : label);
    }
    return parts.join(" · ");
  }, [info]);

  if (!info) {
    return null;
  }

  const handleCopyPath = async () => {
    if (!info.debugRecordingPath) {
      return;
    }
    try {
      await Clipboard.setStringAsync(info.debugRecordingPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.warn("[AudioDebug] Failed to copy path", error);
    }
  };

  const pathMissing = !info.debugRecordingPath;

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <View style={styles.headerRow}>
        <Text style={[styles.title, { color: theme.colors.foregroundMuted }]}>{title}</Text>
        {onDismiss ? (
          <Pressable accessibilityLabel="Dismiss audio debug" onPress={onDismiss} hitSlop={8}>
            <X size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>

      {info.debugRecordingPath ? (
        <Pressable style={styles.pathRow} onPress={handleCopyPath} accessibilityLabel="Copy raw audio path">
          <Text
            numberOfLines={2}
            style={[styles.pathText, { color: theme.colors.foreground }]}
          >
            {info.debugRecordingPath}
          </Text>
          <View style={[styles.copyPill, { backgroundColor: theme.colors.primary }]}>
            {copied ? (
              <Check size={12} color={theme.colors.primaryForeground} />
            ) : (
              <Copy size={12} color={theme.colors.primaryForeground} />
            )}
          </View>
        </Pressable>
      ) : (
        <Text style={[styles.hint, { color: theme.colors.foregroundMuted }]}>
          Raw audio path unavailable. Set STT_DEBUG_AUDIO_DIR on the server to persist recordings.
        </Text>
      )}

      {stats ? (
        <Text style={[styles.stats, { color: theme.colors.foregroundMuted }]}>
          {stats}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 8,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  pathRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  pathText: {
    flex: 1,
    fontSize: 13,
  },
  copyPill: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  stats: {
    fontSize: 12,
  },
  hint: {
    fontSize: 12,
  },
});
