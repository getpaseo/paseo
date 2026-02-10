import { View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

export function AgentStatusDot({
  status,
  requiresAttention,
  showInactive = false,
}: {
  status: string | null | undefined;
  requiresAttention: boolean | null | undefined;
  showInactive?: boolean;
}) {
  const { theme } = useUnistyles();

  const isRunning = status === "running";
  const color = isRunning
    ? theme.colors.palette.blue[500]
    : requiresAttention
      ? theme.colors.success
      : showInactive
        ? theme.colors.border
        : null;

  if (!color) {
    return null;
  }

  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

const styles = StyleSheet.create((theme) => ({
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
}));
