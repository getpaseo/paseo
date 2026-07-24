import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Terminal } from "lucide-react-native";
import { AdaptiveModalSheet, AdaptiveTextInput, type SheetHeader } from "./adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useHostMutations } from "@/runtime/host-runtime";
import { useIsCompactFormFactor } from "@/constants/layout";

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
    width: 90,
  },
  row: {
    flexDirection: "row",
    gap: theme.spacing[3],
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
  const isMobile = useIsCompactFormFactor();

  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");

  const header = useMemo<SheetHeader>(() => ({ title: "SSH Connection" }), []);
  const icon = useMemo(() => <Terminal size={16} />, []);

  const clearInput = useCallback(() => {
    setHost("");
    setPort("22");
    setUser("");
    setErrorMessage("");
  }, []);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    clearInput();
    onClose();
  }, [isSaving, clearInput, onClose]);

  const handleCancel = useCallback(() => {
    if (isSaving) return;
    clearInput();
    (onCancel ?? onClose)();
  }, [isSaving, onCancel, onClose, clearInput]);

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    const trimmedHost = host.trim();
    const trimmedUser = user.trim();
    if (!trimmedHost) {
      setErrorMessage("Host is required.");
      return;
    }

    try {
      setIsSaving(true);
      setErrorMessage("");
      const { serverId, hostname } = await probeAndUpsertSshConnection({
        host: trimmedHost,
        port: port.trim() ? Number(port) : undefined,
        ...(trimmedUser ? { user: trimmedUser } : {}),
      });
      onSaved?.({ serverId, hostname });
      handleClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message);
      if (!isMobile) {
        Alert.alert("SSH connection failed", message);
      }
    } finally {
      setIsSaving(false);
    }
  }, [host, user, port, isSaving, isMobile, onSaved, handleClose, probeAndUpsertSshConnection]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleClose}
      testID="add-ssh-host-modal"
    >
      <Text style={styles.helper}>
        Connect to a remote Paseo daemon over SSH. Paseo will install and launch the daemon on the
        remote host if needed.
      </Text>

      <View style={styles.row}>
        <View style={[styles.field, styles.hostField]}>
          <Text style={styles.label}>Host</Text>
          <AdaptiveTextInput
            testID="ssh-host-input"
            accessibilityLabel="Host"
            value={host}
            onChangeText={setHost}
            placeholder="server.example.com"
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!isSaving}
            returnKeyType="next"
          />
        </View>
        <View style={[styles.field, styles.portField]}>
          <Text style={styles.label}>Port</Text>
          <AdaptiveTextInput
            testID="ssh-port-input"
            accessibilityLabel="Port"
            value={port}
            onChangeText={setPort}
            placeholder="22"
            style={styles.input}
            keyboardType="number-pad"
            editable={!isSaving}
            returnKeyType="next"
          />
        </View>
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>User (optional)</Text>
        <AdaptiveTextInput
          testID="ssh-user-input"
          accessibilityLabel="User"
          value={user}
          onChangeText={setUser}
          placeholder="username"
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSaving}
          returnKeyType="next"
        />
      </View>

      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

      <View style={styles.buttonRow}>
        <Button variant="ghost" onPress={handleCancel} disabled={isSaving}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          onPress={handleSave}
          disabled={isSaving}
          leftIcon={icon}
          testID="add-ssh-host-connect"
        >
          {isSaving ? "Connecting…" : "Connect"}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}
