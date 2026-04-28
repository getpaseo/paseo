import { View, Text } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

type StatusBadgeVariant = "success" | "error" | "muted";

interface StatusBadgeProps {
  label: string;
  variant?: StatusBadgeVariant;
}

export function StatusBadge({ label, variant = "muted" }: StatusBadgeProps) {
  const { theme } = useUnistyles();

  return (
    <View
      style={[
        styles.pill,
        variant === "success" && styles.pillSuccess,
        variant === "error" && styles.pillError,
      ]}
    >
      <Text
        style={[
          styles.pillText,
          variant === "success" && styles.pillTextSuccess,
          variant === "error" && styles.pillTextError,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface3,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
  },
  pillSuccess: {
    backgroundColor: theme.colors.palette.green[900],
    borderColor: theme.colors.palette.green[800],
  },
  pillError: {
    backgroundColor: theme.colors.palette.red[900],
    borderColor: theme.colors.palette.red[800],
  },
  pillText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  pillTextSuccess: {
    color: theme.colors.palette.green[400],
  },
  pillTextError: {
    color: theme.colors.palette.red[500],
  },
}));
