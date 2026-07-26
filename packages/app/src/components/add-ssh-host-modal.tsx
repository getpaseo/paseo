import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Terminal } from "lucide-react-native";
import { AdaptiveModalSheet, AdaptiveTextInput, type SheetHeader } from "./adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useHostMutations } from "@/runtime/host-runtime";

const styles = StyleSheet.create((theme) => ({
  helper: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[4],
  },
  field: {
    marginBottom: theme.spacing[3],
  },
  hostField: {
    flex: 1,
  },
  portField: {
    // Wide enough for "Port (Optional)" on one line; the input itself only
    // needs room for five digits.
    width: 130,
  },
  row: {
    flexDirection: "row",
    gap: theme.spacing[3],
    // Keep the inputs level even when a longer translation wraps the port
    // label onto a second line.
    alignItems: "flex-end",
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    marginBottom: 4,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  error: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
    marginTop: theme.spacing[2],
  },
  progress: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginTop: theme.spacing[1],
  },
  buttonRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
}));

export interface AddSshHostModalProps {
  visible: boolean;
  onClose: () => void;
  onCancel?: () => void;
  onSaved?: (result: { serverId: string; hostname: string | null }) => void;
}

export function AddSshHostModal({ visible, onClose, onCancel, onSaved }: AddSshHostModalProps) {
  const { t } = useTranslation();
  const { probeAndUpsertSshConnection } = useHostMutations();

  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [progressMessage, setProgressMessage] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [user, setUser] = useState("");
  // Bumped on cancel so a connect that is already in flight stops reporting
  // into a modal the user has walked away from.
  const attemptRef = useRef(0);

  const header = useMemo<SheetHeader>(() => ({ title: t("pairing.ssh.title") }), [t]);
  const icon = useMemo(() => <Terminal size={16} />, []);

  const clearInput = useCallback(() => {
    setHost("");
    setPort("");
    setUser("");
    setErrorMessage("");
    setProgressMessage("");
  }, []);

  const abandonAttempt = useCallback(() => {
    attemptRef.current += 1;
    setIsSaving(false);
    setProgressMessage("");
  }, []);

  const handleClose = useCallback(() => {
    abandonAttempt();
    clearInput();
    onClose();
  }, [abandonAttempt, clearInput, onClose]);

  const handleCancel = useCallback(() => {
    abandonAttempt();
    clearInput();
    (onCancel ?? onClose)();
  }, [abandonAttempt, clearInput, onCancel, onClose]);

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    const trimmedHost = host.trim();
    const trimmedUser = user.trim();
    const trimmedPort = port.trim();
    if (!trimmedHost) {
      setErrorMessage(t("pairing.ssh.errors.hostRequired"));
      return;
    }
    // Left blank on purpose means "whatever ~/.ssh/config says", so only a
    // non-empty value is validated.
    let parsedPort: number | undefined;
    if (trimmedPort) {
      parsedPort = Number(trimmedPort);
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        setErrorMessage(t("pairing.ssh.errors.invalidPort"));
        return;
      }
    }

    const attempt = attemptRef.current;
    const isCurrent = () => attemptRef.current === attempt;

    setIsSaving(true);
    setErrorMessage("");
    setProgressMessage("");
    try {
      const { serverId, hostname } = await probeAndUpsertSshConnection({
        host: trimmedHost,
        ...(parsedPort !== undefined ? { port: parsedPort } : {}),
        ...(trimmedUser ? { user: trimmedUser } : {}),
        onProgress: (message) => {
          if (isCurrent()) setProgressMessage(message);
        },
      });
      if (!isCurrent()) return;
      onSaved?.({ serverId, hostname });
      handleClose();
    } catch (error) {
      if (!isCurrent()) return;
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrent()) setIsSaving(false);
    }
  }, [host, user, port, isSaving, onSaved, handleClose, probeAndUpsertSshConnection, t]);

  // Enter connects from any field rather than advancing focus: every field
  // except the host is optional, so there is usually nothing left to fill in.
  // `handleSave` is async, so it has to be voided rather than handed straight
  // to a sync handler.
  const handleSubmitEditing = useCallback(() => {
    void handleSave();
  }, [handleSave]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleClose}
      testID="add-ssh-host-modal"
    >
      <Text style={styles.helper}>{t("pairing.ssh.helper")}</Text>

      <View style={styles.row}>
        <View style={[styles.field, styles.hostField]}>
          <Text style={styles.label}>{t("pairing.ssh.fields.host")}</Text>
          <AdaptiveTextInput
            testID="ssh-host-input"
            accessibilityLabel={t("pairing.ssh.fields.host")}
            value={host}
            onChangeText={setHost}
            placeholder={t("pairing.ssh.placeholders.host")}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!isSaving}
            returnKeyType="done"
            onSubmitEditing={handleSubmitEditing}
          />
        </View>
        <View style={[styles.field, styles.portField]}>
          <Text style={styles.label}>
            {t("pairing.ssh.fields.port")} ({t("pairing.ssh.fields.optional")})
          </Text>
          <AdaptiveTextInput
            testID="ssh-port-input"
            accessibilityLabel={t("pairing.ssh.fields.port")}
            value={port}
            onChangeText={setPort}
            placeholder={t("pairing.ssh.placeholders.port")}
            style={styles.input}
            keyboardType="number-pad"
            editable={!isSaving}
            returnKeyType="done"
            onSubmitEditing={handleSubmitEditing}
          />
        </View>
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>
          {t("pairing.ssh.fields.user")} ({t("pairing.ssh.fields.optional")})
        </Text>
        <AdaptiveTextInput
          testID="ssh-user-input"
          accessibilityLabel={t("pairing.ssh.fields.user")}
          value={user}
          onChangeText={setUser}
          placeholder={t("pairing.ssh.placeholders.user")}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSaving}
          returnKeyType="done"
          onSubmitEditing={handleSubmitEditing}
        />
      </View>

      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
      {isSaving && progressMessage ? <Text style={styles.progress}>{progressMessage}</Text> : null}

      <View style={styles.buttonRow}>
        {/* Deliberately enabled while connecting: an ensure that installs Paseo
            can run for minutes, and the user needs a way out. */}
        <Button variant="ghost" onPress={handleCancel}>
          {t("pairing.ssh.actions.cancel")}
        </Button>
        <Button
          variant="default"
          onPress={handleSave}
          disabled={isSaving}
          leftIcon={icon}
          testID="add-ssh-host-connect"
        >
          {isSaving ? t("pairing.ssh.actions.connecting") : t("pairing.ssh.actions.connect")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}
