import { ActivityIndicator, Alert, Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Mic, MicOff, Square } from "lucide-react-native";
import { VolumeMeter } from "@/components/volume-meter";
import { useVoice, useVoiceTelemetry } from "@/contexts/voice-context";

export function VoiceCompactIndicator() {
  const { theme } = useUnistyles();
  const { volume, isSpeaking } = useVoiceTelemetry();
  const { isVoiceMode, isVoiceSwitching, isMuted, toggleMute, stopVoice } = useVoice();
  if (!isVoiceMode) {
    return null;
  }

  return (
    <View style={[styles.container, isMuted && styles.containerMuted]}>
      <View style={styles.meterContainer}>
        <VolumeMeter
          volume={volume}
          isMuted={isMuted}
          isSpeaking={isSpeaking}
          orientation="horizontal"
          variant="compact"
        />
      </View>

      <View style={styles.controlsRow}>
        <Pressable
          onPress={toggleMute}
          disabled={isVoiceSwitching}
          accessibilityRole="button"
          accessibilityLabel={isMuted ? "Unmute voice" : "Mute voice"}
          style={[styles.muteButton, isVoiceSwitching ? styles.buttonDisabled : undefined]}
          hitSlop={8}
        >
          {isMuted ? (
            <MicOff size={14} color={theme.colors.palette.white} />
          ) : (
            <Mic size={14} color={theme.colors.foreground} />
          )}
        </Pressable>

        <Pressable
          onPress={() => {
            void stopVoice().catch((error) => {
              console.error("[VoiceCompactIndicator] Failed to stop voice mode", error);
              Alert.alert("Voice failed", "Unable to stop realtime voice mode.");
            });
          }}
          disabled={isVoiceSwitching}
          accessibilityRole="button"
          accessibilityLabel="Disable realtime voice mode"
          style={[styles.stopButton, isVoiceSwitching ? styles.buttonDisabled : undefined]}
          hitSlop={8}
        >
          {isVoiceSwitching ? (
            <ActivityIndicator size="small" color={theme.colors.palette.white} />
          ) : (
            <Square
              size={14}
              color={theme.colors.palette.white}
              fill={theme.colors.palette.white}
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
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    height: 32,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  containerMuted: {
    backgroundColor: theme.colors.palette.red[600],
    borderWidth: 0,
  },
  meterContainer: {
    justifyContent: "center",
  },
  controlsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  muteButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
    borderWidth: 0,
  },
  stopButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.palette.red[600],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.palette.red[800],
  },
  buttonDisabled: {
    opacity: 0.5,
  },
}));
