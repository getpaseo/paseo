// SentrySetupForm — adapted from emdash for React Native
import { useState } from "react";
import { View, Text, TextInput, Pressable, ActivityIndicator } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Info } from "lucide-react-native";

interface SentrySetupFormProps {
  onSubmit: (token: string) => void | Promise<void>;
  onClose: () => void;
  isLoading?: boolean;
  error?: string | null;
}

export function SentrySetupForm({
  onSubmit,
  onClose,
  isLoading = false,
  error,
}: SentrySetupFormProps) {
  const { theme } = useUnistyles();
  const [token, setToken] = useState("");

  const canSubmit = token.trim().length > 0 && !isLoading;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.badge}>Sentry setup</Text>
        <Text style={styles.subtitle}>Connect to Sentry with an auth token.</Text>
      </View>

      <TextInput
        style={styles.input}
        value={token}
        onChangeText={setToken}
        placeholder="Sentry auth token"
        placeholderTextColor={theme.colors.foregroundMuted}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />

      <View style={styles.infoBox}>
        <Info size={14} color={theme.colors.foregroundMuted} />
        <View style={styles.infoContent}>
          <Text style={styles.infoTitle}>How to get a Sentry auth token</Text>
          <Text style={styles.infoText}>1. Go to sentry.io/settings/auth-tokens/</Text>
          <Text style={styles.infoText}>
            2. Create a new auth token with project:read and event:read scopes.
          </Text>
        </View>
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <View style={styles.footer}>
        <Pressable onPress={onClose} style={styles.btn}>
          <Text style={styles.btnText}>Close</Text>
        </Pressable>
        <Pressable
          onPress={() => canSubmit && void onSubmit(token)}
          style={[styles.btn, !canSubmit && styles.btnDisabled]}
        >
          {isLoading ? (
            <ActivityIndicator size="small" color={theme.colors.foreground} />
          ) : (
            <Text style={styles.btnText}>Connect</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[3] },
  header: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], flexWrap: "wrap" },
  badge: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  subtitle: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  infoBox: {
    flexDirection: "row",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    borderStyle: "dashed",
    padding: theme.spacing[3],
  },
  infoContent: { flex: 1, gap: 2 },
  infoTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  infoText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted, lineHeight: 18 },
  errorText: { fontSize: theme.fontSize.xs, color: theme.colors.destructive },
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
  btn: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
  },
  btnDisabled: { opacity: 0.5 },
  btnText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));
