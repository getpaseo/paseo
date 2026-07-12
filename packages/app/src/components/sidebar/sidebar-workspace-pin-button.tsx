import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pin, PinOff } from "lucide-react-native";
import {
  Pressable,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

const ThemedPin = withUnistyles(Pin);
const ThemedPinOff = withUnistyles(PinOff);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const buttonStyle = ({ hovered }: PressableStateCallbackType) => [
  styles.button,
  hovered && styles.buttonHovered,
];

export function SidebarWorkspacePinButton({
  workspaceKey,
  isPinned,
  onTogglePin,
}: {
  workspaceKey: string;
  isPinned?: boolean;
  onTogglePin: () => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onTogglePin();
    },
    [onTogglePin],
  );
  const Icon = isPinned ? ThemedPinOff : ThemedPin;

  return (
    <Pressable
      hitSlop={8}
      style={buttonStyle}
      accessibilityRole="button"
      accessibilityLabel={
        isPinned ? t("sidebar.workspace.actions.unpin") : t("sidebar.workspace.actions.pin")
      }
      onPress={handlePress}
      testID={`sidebar-workspace-pin-${workspaceKey}`}
    >
      <Icon size={14} uniProps={foregroundMutedColorMapping} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  buttonHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
