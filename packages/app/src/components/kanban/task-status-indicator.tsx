// TaskStatusIndicator — adapted from emdash for React Native
// Shows spinner (working), dot (unread), or nothing

import { View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Loader2 } from "lucide-react-native";

interface TaskStatusIndicatorProps {
  status: "working" | "unread" | "idle";
}

export function TaskStatusIndicator({ status }: TaskStatusIndicatorProps) {
  const { theme } = useUnistyles();

  if (status === "working") {
    return (
      <View style={indicatorStyles.container}>
        <Loader2 size={12} color={theme.colors.foregroundMuted} />
      </View>
    );
  }

  if (status === "unread") {
    return (
      <View style={indicatorStyles.container}>
        <View style={indicatorStyles.dot} />
      </View>
    );
  }

  return null;
}

const indicatorStyles = StyleSheet.create((theme) => ({
  container: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.foreground,
  },
}));
