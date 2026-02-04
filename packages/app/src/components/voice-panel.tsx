import { View, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { MicOff, Square } from "lucide-react-native";
import { VolumeMeter } from "./volume-meter";
import { useVoice } from "@/contexts/voice-context";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";

export function VoicePanel() {
  const { theme } = useUnistyles();
  const { connectionStates } = useDaemonConnections();
  const {
    volume,
    isMuted,
    isDetecting,
    isSpeaking,
    stopVoice,
    toggleMute,
    activeServerId,
  } = useVoice();

  const activeHost = activeServerId ? connectionStates.get(activeServerId) ?? null : null;
  const hostLabel = activeHost?.daemon.label ?? null;
  const hostSuffix = hostLabel ? ` (${hostLabel})` : "";

  return (
    <View style={styles.container}>
      <View style={styles.contentRow}>
        <View style={styles.meterContainer}>
          <VolumeMeter
            volume={volume}
            isMuted={isMuted}
            isDetecting={isDetecting}
            isSpeaking={isSpeaking}
            orientation="horizontal"
            variant="compact"
          />
        </View>

        <View style={styles.actionsRow}>
          <Pressable
            onPress={toggleMute}
            accessibilityRole="button"
            accessibilityLabel={`${isMuted ? "Unmute voice" : "Mute voice"}${hostSuffix}`}
            style={[
              styles.iconButton,
              isMuted && styles.iconButtonMuted,
            ]}
          >
            <MicOff
              size={18}
              color={isMuted ? theme.colors.surface0 : theme.colors.foreground}
            />
          </Pressable>

          <Pressable
            onPress={() => void stopVoice()}
            accessibilityRole="button"
            accessibilityLabel={`Stop voice mode${hostSuffix}`}
            style={[styles.iconButton, styles.iconButtonStop]}
          >
            <Square size={16} color="white" fill="white" />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    marginHorizontal: theme.spacing[4],
    marginBottom: theme.spacing[3],
    borderRadius: theme.borderRadius["2xl"],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  contentRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  meterContainer: {
    flex: 1,
    justifyContent: "center",
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  iconButtonMuted: {
    backgroundColor: theme.colors.palette.red[500],
    borderColor: theme.colors.palette.red[600],
  },
  iconButtonStop: {
    backgroundColor: theme.colors.palette.red[600],
    borderColor: theme.colors.palette.red[800],
  },
}));
