import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  ProviderAccountProfile,
  ProviderAccountProvider,
} from "@getpaseo/protocol/provider-accounts";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldDisplay } from "@/components/ui/select-field";
import { toErrorMessage } from "@/utils/error-messages";
import { providerAccountCopy as copy } from "./copy";

interface AccountEditModalProps {
  visible: boolean;
  account: ProviderAccountProfile | null;
  onClose: () => void;
  onCreate: (provider: ProviderAccountProvider, name: string) => Promise<void>;
  onRename: (accountProfileId: string, name: string) => Promise<void>;
}

const providerOptions = [
  { id: "codex", value: "codex" as const, label: copy.providers.codex },
  { id: "claude", value: "claude" as const, label: copy.providers.claude },
];

export function AccountEditModal({
  visible,
  account,
  onClose,
  onCreate,
  onRename,
}: AccountEditModalProps): ReactElement | null {
  const [provider, setProvider] = useState<ProviderAccountProvider>(account?.provider ?? "codex");
  const [name, setName] = useState(account?.name ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setProvider(account?.provider ?? "codex");
    setName(account?.name ?? "");
    setError(null);
  }, [account, visible]);

  const header = useMemo<SheetHeader>(
    () => ({ title: account ? copy.editTitle : copy.addTitle }),
    [account],
  );
  const selectedProvider = useMemo<SelectFieldDisplay>(
    () => ({ label: copy.providers[provider] }),
    [provider],
  );
  const handleProviderChange = useCallback((value: ProviderAccountProvider) => {
    setProvider(value);
  }, []);
  const submit = useCallback(async () => {
    const normalized = name.replace(/\s+/g, " ").trim();
    if (!normalized || isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    try {
      if (account) await onRename(account.id, normalized);
      else await onCreate(provider, normalized);
      onClose();
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setIsSubmitting(false);
    }
  }, [account, isSubmitting, name, onClose, onCreate, onRename, provider]);
  const handleSubmit = useCallback(() => {
    void submit();
  }, [submit]);
  let submitLabel: string = account ? copy.save : copy.create;
  if (isSubmitting) submitLabel = copy.saving;

  if (!visible) return null;
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={onClose}
      desktopMaxWidth={480}
      testID="provider-account-edit-modal"
    >
      <View style={styles.body}>
        {!account ? (
          <SelectField
            label={copy.provider}
            value={provider}
            selectedDisplay={selectedProvider}
            options={providerOptions}
            onChange={handleProviderChange}
            title={copy.provider}
            placeholder={copy.provider}
            emptyText={copy.provider}
            disabled={isSubmitting}
            testID="provider-account-provider-field"
          />
        ) : null}
        <Field label={copy.name} hint={copy.duplicateHint}>
          <FormTextInput
            initialValue={account?.name ?? ""}
            onChangeText={setName}
            placeholder={copy.namePlaceholder}
            editable={!isSubmitting}
            autoCapitalize="words"
            autoCorrect={false}
            onSubmitEditing={handleSubmit}
            testID="provider-account-name-input"
          />
        </Field>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.actions}>
          <Button variant="ghost" onPress={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onPress={handleSubmit} disabled={!name.trim()} loading={isSubmitting}>
            {submitLabel}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[4] },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
