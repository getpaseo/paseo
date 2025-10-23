import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Plus } from "lucide-react-native";

interface EmptyStateProps {
  onCreateAgent: () => void;
}

export function EmptyState({ onCreateAgent }: EmptyStateProps) {
  const { theme } = useUnistyles();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Hammock</Text>
      <Text style={styles.subtitle}>What would you like to work on?</Text>
      <Pressable onPress={onCreateAgent} style={styles.button}>
        <Plus size={20} color={styles.buttonText.color} />
        <Text style={styles.buttonText}>New agent</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
  },
  title: {
    fontSize: theme.fontSize["4xl"],
    fontWeight: "700",
    color: theme.colors.foreground,
    marginBottom: theme.spacing[2],
  },
  subtitle: {
    fontSize: theme.fontSize.lg,
    color: theme.colors.mutedForeground,
    textAlign: "center",
    marginBottom: theme.spacing[8],
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[6],
    backgroundColor: theme.colors.primary,
    borderRadius: theme.borderRadius.lg,
  },
  buttonText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.primaryForeground,
  },
}));
