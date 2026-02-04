import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { MicOff, Square, AudioLines } from "lucide-react-native";
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
  const hostStatus = activeHost?.status ?? null;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.titleRow}>
          <AudioLines size={16} color={theme.colors.foregroundMuted} />
          <Text style={styles.titleText}>Voice</Text>
        </View>
        <Text style={styles.hostText} numberOfLines={1}>
          {hostLabel ? `Host: ${hostLabel}` : "Host: unknown"}
          {hostStatus ? ` (${hostStatus})` : ""}
        </Text>
      </View>

      <View style={styles.contentRow}>
        <View style={styles.meterContainer}>
          <VolumeMeter
            volume={volume}
            isMuted={isMuted}
            isDetecting={isDetecting}
            isSpeaking={isSpeaking}
            orientation="horizontal"
          />
        </View>

        <View style={styles.actionsRow}>
          <Pressable
            onPress={toggleMute}
            accessibilityRole="button"
            accessibilityLabel={isMuted ? "Unmute voice" : "Mute voice"}
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
            accessibilityLabel="Stop voice mode"
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
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    gap: theme.spacing[3],
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  titleText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  hostText: {
    flex: 1,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
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
