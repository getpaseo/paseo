import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const ThemedCheck = withUnistyles(Check);
const checkedIconMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });

interface CheckboxRowProps {
  /** Passed back to onToggle, so a list can share one handler. */
  value: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  withBorder?: boolean;
  onToggle: (value: string) => void;
  testID?: string;
}

/** A settings-card row that toggles one item in a list the user picks from. */
export function CheckboxRow({
  value,
  label,
  hint,
  checked,
  disabled = false,
  withBorder = false,
  onToggle,
  testID,
}: CheckboxRowProps) {
  const handlePress = useCallback(() => onToggle(value), [onToggle, value]);
  const accessibilityState = useMemo(() => ({ checked, disabled }), [checked, disabled]);
  const rowStyle = useMemo(
    () => [
      settingsStyles.row,
      withBorder ? settingsStyles.rowBorder : null,
      styles.row,
      disabled ? styles.disabled : null,
    ],
    [disabled, withBorder],
  );
  const boxStyle = useMemo(() => [styles.box, checked ? styles.boxChecked : null], [checked]);

  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      aria-checked={checked}
      testID={testID}
    >
      <View style={boxStyle}>
        {checked ? <ThemedCheck size={14} uniProps={checkedIconMapping} /> : null}
      </View>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{label}</Text>
        {hint ? <Text style={settingsStyles.rowHint}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    justifyContent: "flex-start",
    gap: theme.spacing[3],
  },
  disabled: {
    opacity: theme.opacity[50],
  },
  box: {
    width: 22,
    height: 22,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  boxChecked: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
}));
