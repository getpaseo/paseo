import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { MessageCircle, Mic, MicOff, Square } from "lucide-react-native";
import { useVoiceTelemetry } from "@/contexts/voice-context";
import { VolumeMeter } from "./volume-meter";

interface RealtimeVoiceOverlayProps {
  isMuted: boolean;
  isSwitching: boolean;
  isTranscriptOpen: boolean;
  onToggleTranscript: () => void;
  onToggleMute: () => void;
  onStop: () => void;
}

const OVERLAY_BUTTON_SIZE = 28;

export function RealtimeVoiceOverlay({
  isMuted,
  isSwitching,
  isTranscriptOpen,
  onToggleTranscript,
  onToggleMute,
  onStop,
}: RealtimeVoiceOverlayProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const { volume, isSpeaking } = useVoiceTelemetry();
  const muteButtonStyle = useMemo(
    () => [
      styles.actionButton,
      styles.muteButton,
      isMuted ? styles.muteButtonMuted : undefined,
      isSwitching ? styles.buttonDisabled : undefined,
    ],
    [isMuted, isSwitching],
  );
  const stopButtonStyle = useMemo(
    () => [styles.actionButton, styles.stopButton, isSwitching ? styles.buttonDisabled : undefined],
    [isSwitching],
  );
  return (
    <View style={styles.container}>
      <Pressable
        onPress={onToggleTranscript}
        accessibilityRole="button"
        accessibilityLabel={isTranscriptOpen ? "Hide voice transcript" : "Show voice transcript"}
        style={[
          styles.actionButton,
          styles.transcriptButton,
          isTranscriptOpen && styles.transcriptButtonOpen,
        ]}
      >
        <MessageCircle size={theme.iconSize.md} color={theme.colors.foreground} strokeWidth={2.5} />
      </Pressable>

      <View style={styles.meterContainer}>
        <VolumeMeter
          volume={volume}
          isMuted={isMuted}
          isSpeaking={isSpeaking}
          orientation="horizontal"
          variant="compact"
        />
      </View>

      <View style={styles.actionsContainer}>
        <Pressable
          onPress={onToggleMute}
          disabled={isSwitching}
          accessibilityRole="button"
          accessibilityLabel={
            isMuted ? t("realtimeVoice.actions.unmute") : t("realtimeVoice.actions.mute")
          }
          style={muteButtonStyle}
        >
          {isMuted ? (
            <MicOff size={theme.iconSize.md} color={theme.colors.palette.white} strokeWidth={2.5} />
          ) : (
            <Mic size={theme.iconSize.md} color={theme.colors.foreground} strokeWidth={2.5} />
          )}
        </Pressable>

        <Pressable
          onPress={onStop}
          disabled={isSwitching}
          accessibilityRole="button"
          accessibilityLabel={t("realtimeVoice.actions.stop")}
          style={stopButtonStyle}
        >
          {isSwitching ? (
            <LoadingSpinner size="small" color={theme.colors.palette.white} />
          ) : (
            <Square
              size={theme.iconSize.md}
              color={theme.colors.palette.white}
              fill={theme.colors.palette.white}
              strokeWidth={2.5}
            />
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    minHeight: 40,
    borderRadius: theme.borderRadius.xl,
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  meterContainer: {
    flex: 1,
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  actionsContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  actionButton: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  muteButton: {
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  transcriptButton: {
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  transcriptButtonOpen: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  muteButtonMuted: {
    backgroundColor: theme.colors.palette.red[600],
    borderColor: theme.colors.palette.red[800],
  },
  stopButton: {
    backgroundColor: theme.colors.palette.red[600],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.palette.red[800],
  },
  buttonDisabled: {
    opacity: 0.5,
  },
}));
