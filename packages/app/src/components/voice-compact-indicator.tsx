import { Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Mic, MicOff } from "lucide-react-native";
import { VolumeMeter } from "@/components/volume-meter";
import { useVoice } from "@/contexts/voice-context";

export function VoiceCompactIndicator() {
  const { theme } = useUnistyles();
  const { isVoiceMode, volume, isMuted, isDetecting, isSpeaking, toggleMute } =
    useVoice();

  if (!isVoiceMode) {
    return null;
  }

  return (
    <View style={[styles.container, isMuted && styles.containerMuted]}>
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

      <Pressable
        onPress={toggleMute}
        accessibilityRole="button"
        accessibilityLabel={isMuted ? "Unmute voice" : "Mute voice"}
        style={styles.muteButton}
        hitSlop={8}
      >
        {isMuted ? (
          <MicOff size={14} color={theme.colors.palette.white} />
        ) : (
          <Mic size={14} color={theme.colors.foreground} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
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
  muteButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
    borderWidth: 0,
  },
}));
