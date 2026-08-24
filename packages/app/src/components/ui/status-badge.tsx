import React, { useMemo, type ReactNode } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export type StatusBadgeVariant = "success" | "warning" | "error" | "muted";

interface StatusBadgeProps {
  label: string;
  variant?: StatusBadgeVariant;
  leading?: ReactNode;
}

export function StatusBadge({ label, variant = "muted", leading }: StatusBadgeProps) {
  const textStyle = useMemo(
    () => [
      styles.pillText,
      variant === "success" && styles.pillTextSuccess,
      variant === "warning" && styles.pillTextWarning,
      variant === "error" && styles.pillTextError,
    ],
    [variant],
  );

  return (
    <View style={styles.pill}>
      {leading}
      <Text style={textStyle}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface3,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
  },
  pillText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  pillTextSuccess: {
    color: theme.colors.statusSuccess,
  },
  pillTextWarning: {
    color: theme.colors.statusWarning,
  },
  pillTextError: {
    color: theme.colors.statusDanger,
  },
}));
