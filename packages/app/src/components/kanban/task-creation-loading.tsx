// TaskCreationLoading — loading spinner during task creation
import { View, Text, ActivityIndicator } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

interface TaskCreationLoadingProps {
  message?: string;
}

export function TaskCreationLoading({ message = "Creating task..." }: TaskCreationLoadingProps) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={theme.colors.foreground} />
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  text: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
}));
