import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { Plus, Trash2 } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  buildClaudeAccountPatch,
  isAbsoluteHostPath,
  listClaudeAccountProfiles,
  type ClaudeAccountProfile,
} from "./claude-account-profiles";

const copy = {
  title: "Claude accounts",
  add: "Add account",
  defaultName: "Default Claude account",
  defaultHint: "Uses the host's normal Claude Code login",
  empty: "No additional Claude accounts configured.",
  modalTitle: "Add Claude account",
  name: "Account name",
  namePlaceholder: "Work",
  directory: "Claude config directory",
  directoryPlaceholder: "/Users/me/.claude-work",
  directoryHint: "Use an absolute path on this host.",
  required: "Required",
  absolutePath: "Enter an absolute path on the host.",
  cancel: "Cancel",
  save: "Add account",
  saving: "Adding...",
  removeTitle: "Remove Claude account?",
  removeMessage: "Remove {{name}} from Paseo? Its Claude config directory is not deleted.",
  remove: "Remove",
  loginHint:
    "Authenticate that directory with Claude Code using CLAUDE_CONFIG_DIR and claude auth login.",
} as const;

export function ClaudeAccountsSettingsSection({
  serverId,
  onAccountsChanged,
}: {
  serverId: string;
  onAccountsChanged: () => Promise<void>;
}) {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const accounts = useMemo(() => listClaudeAccountProfiles(config), [config]);
  const [modalOpen, setModalOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const handleOpenModal = useCallback(() => setModalOpen(true), []);
  const handleCloseModal = useCallback(() => setModalOpen(false), []);

  const addButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={Plus}
        onPress={handleOpenModal}
        disabled={!config}
        testID="claude-account-add"
      >
        {copy.add}
      </Button>
    ),
    [config, handleOpenModal],
  );

  const handleAdd = useCallback(
    async (label: string, configDir: string) => {
      if (!config) throw new Error("Host configuration is unavailable.");
      setOperationError(null);
      const result = await patchConfig(
        buildClaudeAccountPatch({
          label,
          configDir,
          existingProviderIds: Object.keys(config.providers),
        }),
      );
      if (!result) throw new Error("Host connection is unavailable.");
      await onAccountsChanged().catch(() => undefined);
    },
    [config, onAccountsChanged, patchConfig],
  );

  const handleRemove = useCallback(
    async (account: ClaudeAccountProfile) => {
      const confirmed = await confirmDialog({
        title: copy.removeTitle,
        message: copy.removeMessage.replace("{{name}}", account.label),
        confirmLabel: copy.remove,
        cancelLabel: copy.cancel,
        destructive: true,
      });
      if (!confirmed) return;
      setOperationError(null);
      setRemovingId(account.providerId);
      try {
        const result = await patchConfig({ removeProviders: [account.providerId] });
        if (!result) throw new Error("Host connection is unavailable.");
        await onAccountsChanged().catch(() => undefined);
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : String(error));
      } finally {
        setRemovingId(null);
      }
    },
    [onAccountsChanged, patchConfig],
  );

  return (
    <>
      <SettingsSection title={copy.title} trailing={addButton} testID="claude-accounts-section">
        <View style={settingsStyles.card}>
          <AccountRow name={copy.defaultName} hint={copy.defaultHint} />
          {accounts.map((account) => (
            <ClaudeAccountRow
              key={account.providerId}
              account={account}
              onRemove={handleRemove}
              removing={removingId === account.providerId}
            />
          ))}
        </View>
        {operationError ? (
          <Alert
            variant="error"
            title="Unable to update Claude accounts"
            description={operationError}
            testID="claude-account-operation-error"
          />
        ) : null}
        <Text style={styles.helpText}>
          {accounts.length === 0 ? `${copy.empty} ${copy.loginHint}` : copy.loginHint}
        </Text>
      </SettingsSection>
      <ClaudeAccountModal visible={modalOpen} onClose={handleCloseModal} onSave={handleAdd} />
    </>
  );
}

function ClaudeAccountRow({
  account,
  onRemove,
  removing,
}: {
  account: ClaudeAccountProfile;
  onRemove: (account: ClaudeAccountProfile) => Promise<void>;
  removing: boolean;
}) {
  const handleRemove = useCallback(() => {
    void onRemove(account);
  }, [account, onRemove]);
  return (
    <AccountRow
      name={account.label}
      hint={account.configDir}
      bordered
      onRemove={handleRemove}
      removing={removing}
    />
  );
}

function AccountRow({
  name,
  hint,
  onRemove,
  removing = false,
  bordered = false,
}: {
  name: string;
  hint: string;
  onRemove?: () => void;
  removing?: boolean;
  bordered?: boolean;
}) {
  return (
    <View style={[settingsStyles.row, bordered && settingsStyles.rowBorder, styles.row]}>
      <View style={styles.rowText}>
        <Text style={settingsStyles.rowTitle}>{name}</Text>
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {hint}
        </Text>
      </View>
      {onRemove ? (
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Trash2}
          loading={removing}
          disabled={removing}
          onPress={onRemove}
          accessibilityLabel={`${copy.remove} ${name}`}
        />
      ) : null}
    </View>
  );
}

function ClaudeAccountModal({
  visible,
  onClose,
  onSave,
}: {
  visible: boolean;
  onClose: () => void;
  onSave: (label: string, configDir: string) => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [configDir, setConfigDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const header = useMemo<SheetHeader>(() => ({ title: copy.modalTitle }), []);

  const close = useCallback(() => {
    if (pending) return;
    setLabel("");
    setConfigDir("");
    setError(null);
    onClose();
  }, [onClose, pending]);

  const submit = useCallback(async () => {
    if (pending) return;
    if (!label.trim() || !configDir.trim()) {
      setError(copy.required);
      return;
    }
    if (!isAbsoluteHostPath(configDir)) {
      setError(copy.absolutePath);
      return;
    }
    setError(null);
    setPending(true);
    try {
      await onSave(label, configDir);
      setLabel("");
      setConfigDir("");
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setPending(false);
    }
  }, [configDir, label, onClose, onSave, pending]);
  const handleSubmit = useCallback(() => {
    void submit();
  }, [submit]);

  return (
    <AdaptiveModalSheet
      visible={visible}
      header={header}
      onClose={close}
      desktopMaxWidth={480}
      testID="claude-account-modal"
    >
      <View style={styles.modalBody}>
        <Field label={copy.name}>
          <FormTextInput
            initialValue=""
            resetKey={visible ? "open" : "closed"}
            onChangeText={setLabel}
            placeholder={copy.namePlaceholder}
            editable={!pending}
            autoCorrect={false}
            accessibilityLabel={copy.name}
            testID="claude-account-name"
          />
        </Field>
        <Field label={copy.directory} hint={copy.directoryHint}>
          <FormTextInput
            initialValue=""
            resetKey={visible ? "open" : "closed"}
            onChangeText={setConfigDir}
            placeholder={copy.directoryPlaceholder}
            editable={!pending}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={copy.directory}
            testID="claude-account-config-dir"
          />
        </Field>
        {error ? (
          <Text style={styles.errorText} testID="claude-account-error">
            {error}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button variant="secondary" onPress={close} disabled={pending}>
            {copy.cancel}
          </Button>
          <Button variant="default" onPress={handleSubmit} disabled={pending}>
            {pending ? copy.saving : copy.save}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  helpText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[2],
  },
  modalBody: {
    gap: theme.spacing[4],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
