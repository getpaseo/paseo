import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Alert, Text, View } from "react-native";
import { CircleUserRound, LogIn, Pencil, Plus, Star, Trash2 } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  ProviderAccountProfile,
  ProviderAccountProvider,
  ProviderAccountLogin,
} from "@getpaseo/protocol/provider-accounts";
import { Alert as InlineAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { getProviderIcon } from "@/components/provider-icons";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { AccountEditModal } from "./account-edit-modal";
import { ProviderAccountLoginModal } from "./login-modal";
import { providerAccountCopy as copy } from "./copy";
import { useProviderAccounts } from "./use-provider-accounts";

const providers: ProviderAccountProvider[] = ["codex", "claude"];

function providerLabel(provider: ProviderAccountProvider): string {
  return copy.providers[provider];
}

function AccountIdentity({ account }: { account: ProviderAccountProfile }): ReactElement {
  const detail = account.identity?.email ?? account.identity?.organization ?? null;
  return (
    <View style={styles.identityLine}>
      <StatusBadge
        label={account.lastAuthenticatedAt ? copy.signedIn : copy.notSignedIn}
        variant={account.lastAuthenticatedAt ? "success" : "warning"}
      />
      {detail ? (
        <Text style={styles.identityText} numberOfLines={1}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

interface AccountRowProps {
  account: ProviderAccountProfile;
  isFirst: boolean;
  isDefault: boolean;
  disabled: boolean;
  onEdit: (account: ProviderAccountProfile) => void;
  onDefault: (account: ProviderAccountProfile) => void;
  onRemove: (account: ProviderAccountProfile) => void;
  onLogin: (account: ProviderAccountProfile) => void;
}

function AccountRow({
  account,
  isFirst,
  isDefault,
  disabled,
  onEdit,
  onDefault,
  onRemove,
  onLogin,
}: AccountRowProps): ReactElement {
  const handleDefault = useCallback(() => onDefault(account), [account, onDefault]);
  const handleEdit = useCallback(() => onEdit(account), [account, onEdit]);
  const handleRemove = useCallback(() => onRemove(account), [account, onRemove]);
  const handleLogin = useCallback(() => onLogin(account), [account, onLogin]);
  return (
    <View
      style={[settingsStyles.row, !isFirst && settingsStyles.rowBorder, styles.accountRow]}
      testID={`provider-account-row-${account.id}`}
    >
      <View style={styles.accountMain}>
        <CircleUserRound size={ICON_SIZE.md} color={styles.accountIcon.color} />
        <View style={settingsStyles.rowContent}>
          <View style={styles.titleLine}>
            <Text style={settingsStyles.rowTitle} numberOfLines={1}>
              {account.name}
            </Text>
            {isDefault ? <StatusBadge label={copy.default} variant="success" /> : null}
          </View>
          <AccountIdentity account={account} />
        </View>
      </View>
      <View style={styles.actions}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={LogIn}
          onPress={handleLogin}
          disabled={disabled}
          accessibilityLabel={`${account.lastAuthenticatedAt ? copy.signInAgain : copy.signIn}: ${account.name}`}
        />
        {!isDefault ? (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Star}
            onPress={handleDefault}
            disabled={disabled}
            accessibilityLabel={`${copy.makeDefault}: ${account.name}`}
          />
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Pencil}
          onPress={handleEdit}
          disabled={disabled}
          accessibilityLabel={`${copy.edit}: ${account.name}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Trash2}
          onPress={handleRemove}
          disabled={disabled}
          accessibilityLabel={`${copy.remove}: ${account.name}`}
        />
      </View>
    </View>
  );
}

function ProviderAccountGroup({
  provider,
  accounts,
  defaultId,
  disabled,
  onEdit,
  onDefault,
  onSystemDefault,
  onRemove,
  onLogin,
}: {
  provider: ProviderAccountProvider;
  accounts: ProviderAccountProfile[];
  defaultId: string | null;
  disabled: boolean;
  onEdit: (account: ProviderAccountProfile) => void;
  onDefault: (account: ProviderAccountProfile) => void;
  onSystemDefault: (provider: ProviderAccountProvider) => void;
  onRemove: (account: ProviderAccountProfile) => void;
  onLogin: (account: ProviderAccountProfile) => void;
}): ReactElement {
  const ProviderIcon = getProviderIcon(provider);
  const systemIsDefault = defaultId === null;
  const handleSystemDefault = useCallback(
    () => onSystemDefault(provider),
    [onSystemDefault, provider],
  );
  return (
    <View style={settingsStyles.card} testID={`provider-account-group-${provider}`}>
      <View style={styles.providerHeader}>
        <ProviderIcon size={ICON_SIZE.md} color={styles.providerIcon.color} />
        <Text style={styles.providerTitle}>{providerLabel(provider)}</Text>
      </View>
      <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.accountRow]}>
        <View style={styles.accountMain}>
          <CircleUserRound size={ICON_SIZE.md} color={styles.accountIcon.color} />
          <View style={settingsStyles.rowContent}>
            <View style={styles.titleLine}>
              <Text style={settingsStyles.rowTitle}>{copy.system}</Text>
              {systemIsDefault ? <StatusBadge label={copy.default} variant="success" /> : null}
            </View>
            <Text style={styles.identityText}>{copy.systemHint}</Text>
          </View>
        </View>
        {!systemIsDefault ? (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Star}
            onPress={handleSystemDefault}
            disabled={disabled}
            accessibilityLabel={`${copy.makeDefault}: ${copy.system}`}
          />
        ) : null}
      </View>
      {accounts.map((account) => (
        <AccountRow
          key={account.id}
          account={account}
          isFirst={false}
          isDefault={account.id === defaultId}
          disabled={disabled}
          onEdit={onEdit}
          onDefault={onDefault}
          onRemove={onRemove}
          onLogin={onLogin}
        />
      ))}
    </View>
  );
}

export function ProviderAccountsSettingsSection({ serverId }: { serverId: string }): ReactElement {
  const { view, accounts, defaults, operations } = useProviderAccounts(serverId);
  const [editAccount, setEditAccount] = useState<ProviderAccountProfile | null | undefined>(
    undefined,
  );
  const [loginAccount, setLoginAccount] = useState<ProviderAccountProfile | null>(null);
  const [login, setLogin] = useState<ProviderAccountLogin | null>(null);
  const openCreate = useCallback(() => setEditAccount(null), []);
  const closeEdit = useCallback(() => setEditAccount(undefined), []);
  const openEdit = useCallback((account: ProviderAccountProfile) => setEditAccount(account), []);

  const setDefault = useCallback(
    async (provider: ProviderAccountProvider, accountProfileId: string | null) => {
      try {
        await operations.setDefault(provider, accountProfileId);
      } catch (error) {
        Alert.alert(copy.errorTitle, toErrorMessage(error));
      }
    },
    [operations],
  );
  const handleDefault = useCallback(
    (account: ProviderAccountProfile) => void setDefault(account.provider, account.id),
    [setDefault],
  );
  const handleSystemDefault = useCallback(
    (provider: ProviderAccountProvider) => void setDefault(provider, null),
    [setDefault],
  );
  const handleRemove = useCallback(
    (account: ProviderAccountProfile) => {
      void confirmDialog({
        title: copy.removeTitle,
        message: copy.removeMessage(account.name),
        confirmLabel: copy.remove,
        cancelLabel: "Cancel",
        destructive: true,
      }).then(async (confirmed) => {
        if (!confirmed) return undefined;
        try {
          await operations.remove(account.id);
        } catch (error) {
          Alert.alert(copy.errorTitle, toErrorMessage(error));
        }
        return undefined;
      });
    },
    [operations],
  );
  const handleLogin = useCallback(
    (account: ProviderAccountProfile) => {
      setLoginAccount(account);
      setLogin(null);
      void operations
        .startLogin(account.id)
        .then(setLogin)
        .catch((error) => {
          Alert.alert(copy.signInFailed, toErrorMessage(error));
          setLoginAccount(null);
        });
    },
    [operations],
  );
  const pollLogin = useCallback(async () => {
    if (!loginAccount) return;
    try {
      setLogin(await operations.getLoginStatus(loginAccount.id));
    } catch (error) {
      Alert.alert(copy.signInFailed, toErrorMessage(error));
      setLoginAccount(null);
    }
  }, [loginAccount, operations]);
  const cancelLogin = useCallback(async () => {
    if (!loginAccount) return;
    try {
      await operations.cancelLogin(loginAccount.id);
    } catch (error) {
      Alert.alert(copy.signInFailed, toErrorMessage(error));
    } finally {
      setLoginAccount(null);
      setLogin(null);
    }
  }, [loginAccount, operations]);
  const closeLogin = useCallback(() => {
    setLoginAccount(null);
    setLogin(null);
  }, []);
  const grouped = useMemo(
    () =>
      Object.fromEntries(
        providers.map((provider) => [
          provider,
          accounts.filter((account) => account.provider === provider),
        ]),
      ) as Record<ProviderAccountProvider, ProviderAccountProfile[]>,
    [accounts],
  );
  const addButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={Plus}
        onPress={openCreate}
        disabled={view.kind !== "ready" || operations.isMutating}
      >
        {copy.add}
      </Button>
    ),
    [openCreate, operations.isMutating, view.kind],
  );
  const handleRefresh = useCallback(() => {
    void operations.refresh();
  }, [operations]);

  return (
    <>
      <SettingsSection title={copy.title} trailing={addButton} testID="provider-accounts-section">
        <Text style={styles.description}>{copy.description}</Text>
        {view.kind === "loading" ? (
          <View style={[settingsStyles.card, styles.stateCard]}>
            <Text style={styles.identityText}>{copy.loading}</Text>
          </View>
        ) : null}
        {view.kind === "unavailable" ? (
          <InlineAlert
            variant="warning"
            title={view.reason === "unsupported" ? copy.upgradeRequired : copy.unavailable}
          />
        ) : null}
        {view.kind === "error" ? (
          <InlineAlert variant="error" title={copy.errorTitle} description={view.message}>
            <Button variant="outline" size="sm" onPress={handleRefresh}>
              {copy.retry}
            </Button>
          </InlineAlert>
        ) : null}
        {view.kind === "ready"
          ? providers.map((provider) => (
              <ProviderAccountGroup
                key={provider}
                provider={provider}
                accounts={grouped[provider]}
                defaultId={defaults[provider] ?? null}
                disabled={operations.isMutating}
                onEdit={openEdit}
                onDefault={handleDefault}
                onSystemDefault={handleSystemDefault}
                onRemove={handleRemove}
                onLogin={handleLogin}
              />
            ))
          : null}
      </SettingsSection>
      <AccountEditModal
        visible={editAccount !== undefined}
        account={editAccount ?? null}
        onClose={closeEdit}
        onCreate={operations.create}
        onRename={operations.rename}
      />
      <ProviderAccountLoginModal
        account={loginAccount}
        login={login}
        onPoll={pollLogin}
        onCancel={cancelLogin}
        onClose={closeLogin}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
    marginHorizontal: theme.spacing[1],
  },
  providerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  providerTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  providerIcon: { color: theme.colors.foreground },
  accountIcon: { color: theme.colors.foregroundMuted },
  accountRow: { minHeight: 62, paddingVertical: theme.spacing[3] },
  accountMain: {
    minWidth: 0,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  titleLine: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  identityLine: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  identityText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", alignItems: "center" },
  stateCard: { padding: theme.spacing[4], alignItems: "center" },
}));
