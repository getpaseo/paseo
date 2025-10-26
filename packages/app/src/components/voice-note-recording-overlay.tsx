import { View, Text, Pressable, ActivityIndicator } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { X, ArrowUp } from "lucide-react-native";
import { VolumeMeter } from "./volume-meter";
import { FOOTER_HEIGHT } from "@/contexts/footer-controls-context";

interface VoiceNoteRecordingOverlayProps {
  volume: number;
  duration: number;
  onCancel: () => void;
  onSend: () => void;
  isTranscribing?: boolean;
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
}: VoiceNoteRecordingOverlayProps) {
  const { theme } = useUnistyles();

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.palette.blue[600] }]}>
      {/* Cancel button */}
      <Pressable onPress={onCancel} disabled={isTranscribing} style={[styles.cancelButton, isTranscribing && styles.buttonDisabled]}>
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
      <Pressable onPress={onSend} disabled={isTranscribing} style={[styles.sendButton, { backgroundColor: theme.colors.palette.white }]}>
        {isTranscribing ? (
          <ActivityIndicator size="small" color={theme.colors.palette.blue[600]} />
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
