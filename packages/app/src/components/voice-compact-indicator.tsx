import { Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AudioLines, MicOff } from "lucide-react-native";
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
    <View style={styles.container}>
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
        style={[styles.muteButton, isMuted && styles.muteButtonMuted]}
      >
        {isMuted ? (
          <MicOff size={14} color={theme.colors.surface0} />
        ) : (
          <AudioLines size={14} color={theme.colors.foreground} />
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
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[1],
    height: 32,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
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
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  muteButtonMuted: {
    backgroundColor: theme.colors.palette.red[600],
    borderColor: theme.colors.palette.red[800],
  },
}));

