// JiraSetupForm — adapted from emdash for React Native
import { useState } from "react";
import { View, Text, TextInput, Pressable, ActivityIndicator } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

interface JiraSetupFormProps {
  onSubmit: (credentials: { site: string; email: string; token: string }) => void | Promise<void>;
  onClose: () => void;
  isLoading?: boolean;
  error?: string | null;
}

export function JiraSetupForm({ onSubmit, onClose, isLoading = false, error }: JiraSetupFormProps) {
  const { theme } = useUnistyles();
  const [site, setSite] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");

  const canSubmit =
    site.trim().length > 0 && email.trim().length > 0 && token.trim().length > 0 && !isLoading;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.badge}>Jira setup</Text>
      </View>

      <View style={styles.fields}>
        <TextInput
          style={styles.input}
          value={site}
          onChangeText={setSite}
          placeholder="https://your-domain.atlassian.net"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="Email"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
        />
        <TextInput
          style={styles.input}
          value={token}
          onChangeText={setToken}
          placeholder="API token"
          placeholderTextColor={theme.colors.foregroundMuted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      <Text style={styles.hint}>
        Create an API token at id.atlassian.com/manage-profile/security/api-tokens
      </Text>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <View style={styles.footer}>
        <Pressable onPress={onClose} style={styles.btn}>
          <Text style={styles.btnText}>Close</Text>
        </Pressable>
        <Pressable
          onPress={() => canSubmit && void onSubmit({ site, email, token })}
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
  header: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  badge: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  fields: { gap: theme.spacing[2] },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  hint: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
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
