import { useCallback, useMemo } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";

export interface WorkspaceAutoTitleToggleProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  testID?: string;
  labelKey?: "workspace.autoUpdateTitle.label" | "newWorkspace.autoUpdateTitle.label";
  hintKey?: "workspace.autoUpdateTitle.hint" | "newWorkspace.autoUpdateTitle.hint";
}

export function WorkspaceAutoTitleToggle({
  value,
  onValueChange,
  disabled = false,
  testID,
  labelKey = "workspace.autoUpdateTitle.label",
  hintKey = "workspace.autoUpdateTitle.hint",
}: WorkspaceAutoTitleToggleProps) {
  const { t } = useTranslation();

  const handleToggle = useCallback(() => {
    onValueChange(!value);
  }, [onValueChange, value]);

  const accessibilityState = useMemo(() => ({ checked: value, disabled }), [value, disabled]);

  const rowStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      Boolean(hovered) && !disabled && styles.rowHovered,
      pressed && !disabled && styles.rowPressed,
    ],
    [disabled],
  );

  return (
    <Pressable
      onPress={handleToggle}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={accessibilityState}
      testID={testID}
      style={rowStyle}
    >
      <Switch value={value} onValueChange={onValueChange} disabled={disabled} />
      <View style={styles.textColumn}>
        <Text style={styles.label}>{t(labelKey)}</Text>
        <Text style={styles.hint}>{t(hintKey)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  textColumn: {
    gap: theme.spacing[1],
  },
  label: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  hint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
