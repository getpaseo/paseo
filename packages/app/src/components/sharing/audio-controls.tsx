import { Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Mic, MicOff } from "lucide-react-native";

interface AudioControlsProps {
  audioEnabled: boolean;
  onToggle: (enabled: boolean) => void;
}

export function AudioControls({ audioEnabled, onToggle }: AudioControlsProps) {
  const { theme } = useUnistyles();

  return (
    <Pressable
      style={({ hovered }) => [
        styles.button,
        audioEnabled && styles.buttonActive,
        hovered && styles.buttonHovered,
      ]}
      onPress={() => onToggle(!audioEnabled)}
    >
      {audioEnabled ? (
        <Mic size={16} color={theme.colors.foreground} />
      ) : (
        <MicOff size={16} color={theme.colors.foregroundMuted} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  buttonActive: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.foregroundMuted,
  },
  buttonHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
