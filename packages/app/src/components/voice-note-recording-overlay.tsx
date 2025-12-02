import { View, Text, Pressable, ActivityIndicator } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { X, ArrowUp, RefreshCcw } from "lucide-react-native";
import { VolumeMeter } from "./volume-meter";
import { FOOTER_HEIGHT } from "@/contexts/footer-controls-context";
import type { DictationStatus } from "@/hooks/use-dictation";

interface VoiceNoteRecordingOverlayProps {
  volume: number;
  duration: number;
  onCancel: () => void;
  onSend: () => void;
  isTranscribing?: boolean;
  status?: DictationStatus;
  onRetry?: () => void;
  onDiscardFailed?: () => void;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export function VoiceNoteRecordingOverlay({
  volume,
  duration,
  onCancel,
  onSend,
  isTranscribing = false,
  status = "idle",
  onRetry,
  onDiscardFailed,
}: VoiceNoteRecordingOverlayProps) {
  const { theme } = useUnistyles();
  const isRetrying = status === "retrying";
  const isFailed = status === "failed";
  const primaryDisabled = isTranscribing || isRetrying;
  const handlePrimary = isFailed ? onRetry ?? onSend : onSend;
  const handleCancel = isFailed && onDiscardFailed ? onDiscardFailed : onCancel;

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.palette.blue[600] }]}>
      {/* Cancel button */}
      <Pressable
        onPress={handleCancel}
        disabled={isTranscribing}
        style={[styles.cancelButton, isTranscribing && styles.buttonDisabled]}
      >
        <X size={24} color={theme.colors.palette.white} strokeWidth={2.5} />
      </Pressable>

      {/* Center: Volume meter and timer */}
      <View style={styles.centerContainer}>
        <VolumeMeter
          volume={volume}
          isMuted={false}
          isDetecting={true}
          isSpeaking={false}
          orientation="horizontal"
        />
        <Text style={[styles.timerText, { color: theme.colors.palette.white }]}>
          {formatDuration(duration)}
        </Text>
      </View>

      {/* Send button */}
      <Pressable
        onPress={handlePrimary}
        disabled={primaryDisabled}
        style={[styles.sendButton, { backgroundColor: theme.colors.palette.white }, primaryDisabled && styles.buttonDisabled]}
      >
        {isRetrying ? (
          <ActivityIndicator size="small" color={theme.colors.palette.blue[600]} />
        ) : isTranscribing ? (
          <ActivityIndicator size="small" color={theme.colors.palette.blue[600]} />
        ) : isFailed ? (
          <RefreshCcw size={24} color={theme.colors.palette.blue[600]} strokeWidth={2.5} />
        ) : (
          <ArrowUp size={24} color={theme.colors.palette.blue[600]} strokeWidth={2.5} />
        )}
      </Pressable>
    </View>
  );
}

const BUTTON_SIZE = 56;
const VERTICAL_PADDING = (FOOTER_HEIGHT - BUTTON_SIZE) / 2;

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: VERTICAL_PADDING,
    height: FOOTER_HEIGHT,
  },
  cancelButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: "rgba(0, 0, 0, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  centerContainer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[4],
  },
  timerText: {
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.semibold,
    fontVariant: ["tabular-nums"],
  },
  sendButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
}));
