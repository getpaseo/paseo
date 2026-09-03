import { useCallback, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import {
  buildAcpProviderConfigPatch,
  type AcpProviderCatalogItem,
} from "@/hooks/use-acp-provider-catalog";
import { ProviderCatalogList } from "@/components/provider-catalog-list";
import {
  ProviderAccountSheet,
  type ProviderAccountSaveInput,
} from "@/components/provider-account-sheet";
import {
  canAddProviderAccount,
  groupProviderAccounts,
  resolveProviderAccountBaseId,
} from "@/provider-accounts/provider-account-form-model";
import { getProviderIcon } from "@/components/provider-icons";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SettingsSection } from "@/screens/settings/settings-section";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { ChevronRight, MoreHorizontal, Pencil, Trash2, UserPlus } from "lucide-react-native";

type ProviderDefinition = ReturnType<typeof buildProviderDefinitions>[number];
type ProviderEntry = NonNullable<ReturnType<typeof useProvidersSnapshot>["entries"]>[number];

type StatusTone = "success" | "warning" | "danger" | "muted" | "loading";

interface ProviderStatus {
  tone: StatusTone;
  label: string;
  modelCount: number | null;
}

function getProviderStatus(
  status: string,
  enabled: boolean,
  modelCount: number,
  t: TFunction,
): ProviderStatus {
  if (!enabled)
    return { tone: "muted", label: t("settings.providers.statuses.disabled"), modelCount: null };
  if (status === "loading") {
    return { tone: "loading", label: t("settings.providers.statuses.loading"), modelCount: null };
  }
  if (status === "error") {
    return { tone: "danger", label: t("settings.providers.statuses.error"), modelCount: null };
  }
  if (status === "ready") {
    return {
      tone: "success",
      label: t("settings.providers.statuses.available"),
      modelCount: modelCount > 0 ? modelCount : null,
    };
  }
  return {
    tone: "warning",
    label: t("settings.providers.statuses.notInstalled"),
    modelCount: null,
  };
}

interface ProviderRowProps {
  def: ProviderDefinition;
  entry: ProviderEntry;
  enabled: boolean;
  isToggling: boolean;
  isRemoving: boolean;
  canRemove: boolean;
  canAddAccount: boolean;
  canEditAccount: boolean;
  iconProviderId: string;
  isFirst: boolean;
  onPress: (providerId: string) => void;
  onToggleEnabled: (providerId: string, enabled: boolean) => void;
  onRemove: (providerId: string, providerLabel: string) => void;
  onAddAccount: (providerId: string, providerLabel: string) => void;
  onEditAccount: (providerId: string) => void;
}

function stopPressInPropagation(event: GestureResponderEvent) {
  event.stopPropagation();
}

interface ProviderActionsMenuProps {
  providerId: string;
  providerLabel: string;
  isRemoving: boolean;
  canRemove: boolean;
  canAddAccount: boolean;
  canEditAccount: boolean;
  iconSize: number;
  foregroundColor: string;
  foregroundMutedColor: string;
  dangerColor: string;
  onRemove: (providerId: string, providerLabel: string) => void;
  onAddAccount: (providerId: string, providerLabel: string) => void;
  onEditAccount: (providerId: string) => void;
}

function ProviderActionsMenu({
  providerId,
  providerLabel,
  isRemoving,
  canRemove,
  canAddAccount,
  canEditAccount,
  iconSize,
  foregroundColor,
  foregroundMutedColor,
  dangerColor,
  onRemove,
  onAddAccount,
  onEditAccount,
}: ProviderActionsMenuProps) {
  const { t } = useTranslation();
  const handleRemove = useCallback(() => {
    onRemove(providerId, providerLabel);
  }, [onRemove, providerId, providerLabel]);
  const handleAddAccount = useCallback(() => {
    onAddAccount(providerId, providerLabel);
  }, [onAddAccount, providerId, providerLabel]);
  const handleEditAccount = useCallback(() => {
    onEditAccount(providerId);
  }, [onEditAccount, providerId]);
  const triggerStyle = useCallback(
    ({
      pressed,
      hovered,
      open,
    }: PressableStateCallbackType & { hovered?: boolean; open?: boolean }) => [
      styles.menuButton,
      (hovered || open) && styles.menuButtonHovered,
      pressed && styles.menuButtonPressed,
    ],
    [],
  );
  const trashLeading = useMemo(() => <Trash2 size={16} color={dangerColor} />, [dangerColor]);
  const addAccountLeading = useMemo(
    () => <UserPlus size={16} color={foregroundMutedColor} />,
    [foregroundMutedColor],
  );
  const editAccountLeading = useMemo(
    () => <Pencil size={16} color={foregroundMutedColor} />,
    [foregroundMutedColor],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={isRemoving}
        hitSlop={8}
        onPressIn={stopPressInPropagation}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={t("settings.providers.actions.menu", { name: providerLabel })}
        testID={`provider-actions-${providerId}`}
      >
        {({ hovered, open }) => (
          <MoreHorizontal
            size={iconSize}
            color={hovered || open ? foregroundColor : foregroundMutedColor}
          />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
        {canAddAccount ? (
          <DropdownMenuItem
            leading={addAccountLeading}
            onSelect={handleAddAccount}
            testID={`provider-add-account-${providerId}`}
          >
            {t("settings.providers.actions.addAccount")}
          </DropdownMenuItem>
        ) : null}
        {canEditAccount ? (
          <DropdownMenuItem
            leading={editAccountLeading}
            onSelect={handleEditAccount}
            testID={`provider-edit-account-${providerId}`}
          >
            {t("settings.providers.actions.editAccount")}
          </DropdownMenuItem>
        ) : null}
        {canRemove ? (
          <DropdownMenuItem
            destructive
            leading={trashLeading}
            onSelect={handleRemove}
            status={isRemoving ? "pending" : "idle"}
            pendingLabel={t("settings.providers.actions.removing")}
            testID={`provider-remove-${providerId}`}
          >
            {t("settings.providers.actions.remove")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProviderRow({
  def,
  entry,
  enabled,
  isToggling,
  isRemoving,
  canRemove,
  canAddAccount,
  canEditAccount,
  iconProviderId,
  isFirst,
  onPress,
  onToggleEnabled,
  onRemove,
  onAddAccount,
  onEditAccount,
}: ProviderRowProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const isCompact = useIsCompactFormFactor();
  const ProviderIcon = getProviderIcon(iconProviderId);
  const providerError =
    enabled &&
    entry.status === "error" &&
    typeof entry.error === "string" &&
    entry.error.trim().length > 0
      ? entry.error.trim()
      : null;
  const modelCount = filterSelectableModels(entry.models ?? null)?.length ?? 0;
  const providerStatus = getProviderStatus(entry.status, enabled, modelCount, t);

  const handlePress = useCallback(() => {
    onPress(def.id);
  }, [def.id, onPress]);
  const handleToggleValueChange = useCallback(
    (value: boolean) => {
      onToggleEnabled(def.id, value);
    },
    [def.id, onToggleEnabled],
  );
  const rowStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      settingsStyles.row,
      !isFirst && settingsStyles.rowBorder,
      styles.row,
      hovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isFirst],
  );

  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={t("settings.providers.providerDetails", { name: def.label })}
    >
      {({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => (
        <>
          <View style={styles.rowContent}>
            <ChevronRight
              size={theme.iconSize.sm}
              color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
            />
            <ProviderIcon size={theme.iconSize.md} color={theme.colors.foreground} />
            <View style={styles.textColumn}>
              <View style={styles.titleRow}>
                <Text style={settingsStyles.rowTitle} numberOfLines={1}>
                  {def.label}
                </Text>
                {!isCompact ? <Text style={styles.separator}>·</Text> : null}
                <StatusIndicator status={providerStatus} compact={isCompact} />
              </View>
              {providerError && !isCompact ? (
                <Text style={styles.errorText} numberOfLines={3}>
                  {providerError}
                </Text>
              ) : null}
            </View>
          </View>
          <View style={styles.trailingControls}>
            <Switch
              value={enabled}
              onValueChange={handleToggleValueChange}
              disabled={isToggling || isRemoving}
              accessibilityLabel={t("settings.providers.enableProvider", { name: def.label })}
            />
            <View style={styles.menuSlot}>
              {canRemove || canAddAccount || canEditAccount ? (
                <ProviderActionsMenu
                  providerId={def.id}
                  providerLabel={def.label}
                  isRemoving={isRemoving}
                  canRemove={canRemove}
                  canAddAccount={canAddAccount}
                  canEditAccount={canEditAccount}
                  iconSize={theme.iconSize.sm}
                  foregroundColor={theme.colors.foreground}
                  foregroundMutedColor={theme.colors.foregroundMuted}
                  dangerColor={theme.colors.statusDanger}
                  onRemove={onRemove}
                  onAddAccount={onAddAccount}
                  onEditAccount={onEditAccount}
                />
              ) : null}
            </View>
          </View>
        </>
      )}
    </Pressable>
  );
}

function getDotColor(tone: StatusTone, theme: ReturnType<typeof useUnistyles>["theme"]): string {
  switch (tone) {
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foregroundMuted;
  }
}

function StatusIndicator({ status, compact }: { status: ProviderStatus; compact: boolean }) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const dotStyle = useMemo(
    () => [styles.statusDot, { backgroundColor: getDotColor(status.tone, theme) }],
    [status.tone, theme],
  );

  return (
    <View style={styles.statusRow}>
      {status.tone === "loading" ? (
        <LoadingSpinner size={10} color={theme.colors.foregroundMuted} />
      ) : (
        <View style={dotStyle} />
      )}
      {!compact ? (
        <>
          <Text style={styles.statusLabel}>{status.label}</Text>
          {status.modelCount !== null ? (
            <>
              <Text style={styles.separator}>·</Text>
              <Text style={styles.statusLabel}>
                {status.modelCount === 1
                  ? t("settings.providers.models.one")
                  : t("settings.providers.models.many", { count: status.modelCount })}
              </Text>
            </>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

interface ProviderAccountTarget {
  baseProviderId: string;
  baseProviderLabel: string;
  account?: {
    providerId: string;
    config: NonNullable<ReturnType<typeof useDaemonConfig>["config"]>["providers"][string];
  };
}

export interface ProvidersSectionProps {
  serverId: string;
}

export function ProvidersSection({ serverId }: ProvidersSectionProps) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supportsProviderRemoval = useHostFeature(serverId, "providerRemoval");
  const supportsProviderConfigReplace = useHostFeature(serverId, "providerConfigReplace");
  const supportsProviderConfigRename = useHostFeature(serverId, "providerConfigRename");
  const { entries, isLoading, refresh } = useProvidersSnapshot(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const openProviderSettings = useProviderSettingsStore((state) => state.open);
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const [removingProviderId, setRemovingProviderId] = useState<string | null>(null);
  const removingProviderIdRef = useRef<string | null>(null);
  const [installingProviderId, setInstallingProviderId] = useState<string | null>(null);
  const [accountTarget, setAccountTarget] = useState<ProviderAccountTarget | null>(null);

  const providerDefinitions = useMemo(
    () => groupProviderAccounts(buildProviderDefinitions(entries), config?.providers),
    [config?.providers, entries],
  );
  const existingProviderIds = useMemo(
    () => (entries ?? []).map((entry) => entry.provider),
    [entries],
  );
  const hasServer = serverId.length > 0;

  const handleOpenProviderSettings = useCallback(
    (providerId: string) => {
      openProviderSettings({ serverId, provider: providerId });
    },
    [openProviderSettings, serverId],
  );

  const handleToggleEnabled = useCallback(
    async (providerId: string, enabled: boolean) => {
      setPendingProviderId(providerId);
      try {
        await patchConfig({ providers: { [providerId]: { enabled } } });
      } catch (error) {
        Alert.alert(
          t("settings.providers.updateErrorTitle"),
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setPendingProviderId((current) => (current === providerId ? null : current));
      }
    },
    [patchConfig, t],
  );

  const handleRemoveProvider = useCallback(
    async (providerId: string, providerLabel: string) => {
      if (removingProviderIdRef.current) return;
      removingProviderIdRef.current = providerId;
      setRemovingProviderId(providerId);
      try {
        const confirmed = await confirmDialog({
          title: t("settings.providers.remove.confirmTitle", { name: providerLabel }),
          message: t("settings.providers.remove.confirmMessage"),
          confirmLabel: t("settings.providers.remove.confirm"),
          destructive: true,
        });
        if (!confirmed) {
          return;
        }

        await patchConfig({ removeProviders: [providerId] });
      } catch (error) {
        Alert.alert(
          t("settings.providers.remove.errorTitle"),
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        if (removingProviderIdRef.current === providerId) {
          removingProviderIdRef.current = null;
        }
        setRemovingProviderId((current) => (current === providerId ? null : current));
      }
    },
    [patchConfig, t],
  );

  const handleInstall = useCallback(
    async (entry: AcpProviderCatalogItem) => {
      if (installingProviderId) return;
      setInstallingProviderId(entry.id);
      try {
        await patchConfig(buildAcpProviderConfigPatch(entry));
        await refresh([entry.id]);
      } catch (error) {
        Alert.alert(
          t("settings.providers.addErrorTitle"),
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setInstallingProviderId((current) => (current === entry.id ? null : current));
      }
    },
    [installingProviderId, patchConfig, refresh, t],
  );

  const handleOpenAddAccount = useCallback((providerId: string, providerLabel: string) => {
    setAccountTarget({ baseProviderId: providerId, baseProviderLabel: providerLabel });
  }, []);

  const handleOpenEditAccount = useCallback(
    (providerId: string) => {
      const providerConfig = config?.providers[providerId];
      const baseProviderId = resolveProviderAccountBaseId(providerId, config?.providers);
      if (!providerConfig || !baseProviderId) return;
      const baseProviderLabel =
        entries?.find((entry) => entry.provider === baseProviderId)?.label ?? baseProviderId;
      setAccountTarget({
        baseProviderId,
        baseProviderLabel,
        account: { providerId, config: providerConfig },
      });
    },
    [config?.providers, entries],
  );

  const handleCloseAccount = useCallback(() => {
    setAccountTarget(null);
  }, []);

  const handleSaveAccount = useCallback(
    async ({ providerId, originalProviderId, patch }: ProviderAccountSaveInput) => {
      try {
        await patchConfig(patch);
        await refresh(
          originalProviderId && originalProviderId !== providerId
            ? [originalProviderId, providerId]
            : [providerId],
        );
        return true;
      } catch (error) {
        Alert.alert(
          t("settings.providers.account.errorTitle"),
          error instanceof Error ? error.message : String(error),
        );
        return false;
      }
    },
    [patchConfig, refresh, t],
  );

  return (
    <>
      <SettingsSection
        title={t("settings.providers.title")}
        testID="host-page-providers-card"
        style={styles.sectionSpacing}
      >
        {!hasServer || !isConnected ? (
          <View style={[settingsStyles.card, styles.emptyCard]}>
            <Text style={styles.emptyText}>{t("settings.providers.unavailable")}</Text>
          </View>
        ) : null}
        {hasServer && isConnected && isLoading ? (
          <View style={[settingsStyles.card, styles.emptyCard]}>
            <Text style={styles.emptyText}>{t("settings.providers.loading")}</Text>
          </View>
        ) : null}
        {hasServer && isConnected && !isLoading && providerDefinitions.length > 0 ? (
          <View style={settingsStyles.card}>
            {providerDefinitions.map((def, index) => {
              const entry = entries?.find((candidate) => candidate.provider === def.id);
              if (!entry) return null;
              return (
                <ProviderRow
                  key={def.id}
                  def={def}
                  entry={entry}
                  enabled={entry.enabled ?? true}
                  isToggling={pendingProviderId === def.id}
                  isRemoving={removingProviderId === def.id}
                  canRemove={supportsProviderRemoval && entry.source === "custom"}
                  canAddAccount={canAddProviderAccount({
                    providerId: def.id,
                    source: entry.source,
                  })}
                  canEditAccount={
                    supportsProviderConfigReplace &&
                    entry.source === "custom" &&
                    resolveProviderAccountBaseId(def.id, config?.providers) !== null
                  }
                  iconProviderId={resolveProviderAccountBaseId(def.id, config?.providers) ?? def.id}
                  isFirst={index === 0}
                  onPress={handleOpenProviderSettings}
                  onToggleEnabled={handleToggleEnabled}
                  onRemove={handleRemoveProvider}
                  onAddAccount={handleOpenAddAccount}
                  onEditAccount={handleOpenEditAccount}
                />
              );
            })}
          </View>
        ) : null}
      </SettingsSection>

      {hasServer && isConnected ? (
        <SettingsSection
          title={t("settings.providers.addProvider")}
          testID="host-page-add-provider-card"
          style={styles.addProviderSection}
        >
          <ProviderCatalogList
            serverId={serverId}
            installingProviderId={installingProviderId}
            onInstall={handleInstall}
          />
        </SettingsSection>
      ) : null}

      {accountTarget ? (
        <ProviderAccountSheet
          key={`${accountTarget.account ? "edit" : "add"}:${accountTarget.account?.providerId ?? accountTarget.baseProviderId}`}
          visible
          baseProviderId={accountTarget.baseProviderId}
          baseProviderLabel={accountTarget.baseProviderLabel}
          existingProviderIds={existingProviderIds}
          account={accountTarget.account}
          supportsProviderConfigRename={supportsProviderConfigRename}
          onClose={handleCloseAccount}
          onSave={handleSaveAccount}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  sectionSpacing: {
    marginBottom: theme.spacing[4],
  },
  addProviderSection: {
    marginTop: theme.spacing[4],
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  row: {
    gap: theme.spacing[3],
    minHeight: 56,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  rowContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  textColumn: {
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  separator: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  trailingControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  menuButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  menuSlot: {
    width: 32,
    height: 32,
  },
  menuButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  menuButtonPressed: {
    backgroundColor: theme.colors.surface3,
  },
}));
