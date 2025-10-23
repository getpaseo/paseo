import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { MicOff, Square } from "lucide-react-native";
import { VolumeMeter } from "./volume-meter";
import { useRealtime } from "@/contexts/realtime-context";
import { useSession } from "@/contexts/session-context";

export function RealtimeControls() {
  const { theme } = useUnistyles();
  const { audioPlayer } = useSession();
  const {
    volume,
    isMuted,
    isDetecting,
    isSpeaking,
    segmentDuration,
    stopRealtime,
    toggleMute,
  } = useRealtime();

  function handleStop() {
    audioPlayer.stop();
    stopRealtime();
  }

  return (
    <View style={styles.container}>
      <View style={styles.volumeContainer}>
        <VolumeMeter
          volume={volume}
          isMuted={isMuted}
          isDetecting={isDetecting}
          isSpeaking={isSpeaking}
        />
        {/* Debug timer */}
        {(isDetecting || isSpeaking) && (
          <Text style={styles.debugTimer}>
            {(segmentDuration / 1000).toFixed(1)}s
          </Text>
        )}
      </View>
      <View style={styles.buttons}>
        {/* Mute button */}
        <Pressable
          onPress={toggleMute}
          style={[
            styles.muteButton,
            isMuted && styles.muteButtonActive,
          ]}
        >
          <MicOff
            size={20}
            color={
              isMuted
                ? theme.colors.background
                : theme.colors.foreground
            }
          />
        </Pressable>
        {/* Stop button */}
        <Pressable
          onPress={handleStop}
          style={styles.stopButton}
        >
          <Square size={18} color="white" fill="white" />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    minHeight: 200,
    padding: theme.spacing[4],
  },
  volumeContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  buttons: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingTop: theme.spacing[4],
  },
  muteButton: {
    width: 48,
    height: 48,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.muted,
    borderWidth: theme.borderWidth[2],
    borderColor: theme.colors.border,
  },
  muteButtonActive: {
    backgroundColor: theme.colors.palette.red[500],
    borderColor: theme.colors.palette.red[600],
  },
  stopButton: {
    width: 48,
    height: 48,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.palette.red[600],
  },
  debugTimer: {
    marginTop: theme.spacing[2],
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    fontFamily: "monospace",
  },
}));
