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
          orientation="horizontal"
        />
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
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    height: 88,
  },
  volumeContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "flex-start",
  },
  buttons: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
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
}));
