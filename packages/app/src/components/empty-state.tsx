import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Plus, Download } from "lucide-react-native";

interface EmptyStateProps {
  onCreateAgent: () => void;
  onImportAgent?: () => void;
}

export function EmptyState({ onCreateAgent, onImportAgent }: EmptyStateProps) {
  const { theme } = useUnistyles();
  const hasImportCta = typeof onImportAgent === "function";

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Hammock</Text>
      <Text style={styles.subtitle}>What would you like to work on?</Text>
      <View style={styles.buttonGroup}>
        <Pressable onPress={onCreateAgent} style={[styles.button, styles.primaryButton]}>
          <Plus size={20} color={styles.primaryButtonText.color} />
          <Text style={styles.primaryButtonText}>New agent</Text>
        </Pressable>
        {hasImportCta ? (
          <Pressable
            onPress={onImportAgent}
            style={[styles.button, styles.secondaryButton]}
          >
            <Download size={20} color={styles.secondaryButtonText.color} />
            <Text style={styles.secondaryButtonText}>Import agent</Text>
          </Pressable>
        ) : null}
      </View>
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
  buttonGroup: {
    width: "100%",
    gap: theme.spacing[3],
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[6],
    borderRadius: theme.borderRadius.lg,
    justifyContent: "center",
  },
  primaryButton: {
    backgroundColor: theme.colors.primary,
  },
  primaryButtonText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.primaryForeground,
  },
  secondaryButton: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.muted,
  },
  secondaryButtonText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
}));
