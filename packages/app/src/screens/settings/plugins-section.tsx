import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { InstalledPlugin, PluginRegistryEntry } from "@getpaseo/protocol/plugin/types";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { useToast } from "@/contexts/toast-context";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useSessionStore } from "@/stores/session-store";
import { usePluginRegistry, usePlugins } from "@/plugins/queries";
import { pluginFilePreviewConflicts } from "@/components/file-pane-render-mode";

type PluginsView = "installed" | "browse";

export function PluginsSection({ serverId }: { serverId: string | null }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [view, setView] = useState<PluginsView>("installed");
  const [errorByPlugin, setErrorByPlugin] = useState<Record<string, string>>({});
  const client = useSessionStore((state) => state.sessions[serverId ?? ""]?.client ?? null);
  const { plugins, supported, isLoading, error } = usePlugins(serverId);

  const clearError = useCallback((pluginId: string) => {
    setErrorByPlugin((current) => {
      if (!(pluginId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[pluginId];
      return next;
    });
  }, []);

  const recordError = useCallback((pluginId: string, cause: unknown) => {
    setErrorByPlugin((current) => ({
      ...current,
      [pluginId]: cause instanceof Error ? cause.message : String(cause),
    }));
  }, []);

  const setEnabled = useMutation({
    mutationFn: async (input: { pluginId: string; enabled: boolean }) => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      const payload = await client.pluginsSetEnabled(input);
      if (payload.error) throw new Error(payload.error);
      return payload;
    },
    onMutate: (input) => clearError(input.pluginId),
    onError: (cause, input) => recordError(input.pluginId, cause),
  });

  const uninstall = useMutation({
    mutationFn: async (pluginId: string) => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      const payload = await client.pluginsUninstall({ pluginId });
      if (payload.error) throw new Error(payload.error);
      return payload;
    },
    onMutate: (pluginId) => clearError(pluginId),
    onSuccess: () => toast.show(t("plugins.toast.uninstalled")),
    onError: (cause, pluginId) => recordError(pluginId, cause),
  });

  const install = useMutation({
    mutationFn: async (pluginId: string) => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      const payload = await client.pluginsInstall({ pluginId });
      if (payload.error) throw new Error(payload.error);
      return payload;
    },
    onMutate: (pluginId) => clearError(pluginId),
    onSuccess: () => toast.show(t("plugins.toast.installed")),
    onError: (cause, pluginId) => recordError(pluginId, cause),
  });

  const handleUninstall = useCallback(
    (plugin: InstalledPlugin) => {
      void (async () => {
        const confirmed = await confirmDialog({
          title: t("plugins.uninstallTitle"),
          message: t("plugins.uninstallMessage", { name: plugin.manifest.name }),
          confirmLabel: t("plugins.actions.uninstall"),
          destructive: true,
        });
        if (confirmed) {
          uninstall.mutate(plugin.manifest.id);
        }
      })();
    },
    [t, uninstall],
  );

  const installedIds = useMemo(
    () => new Set(plugins.map((plugin) => plugin.manifest.id)),
    [plugins],
  );
  const conflicts = useMemo(() => pluginFilePreviewConflicts(plugins), [plugins]);

  const viewOptions = useMemo(
    () => [
      { value: "installed" as const, label: t("plugins.views.installed") },
      { value: "browse" as const, label: t("plugins.views.browse") },
    ],
    [t],
  );

  const handleToggleEnabled = useCallback(
    (pluginId: string, enabled: boolean) => setEnabled.mutate({ pluginId, enabled }),
    [setEnabled],
  );
  const handleInstall = useCallback((pluginId: string) => install.mutate(pluginId), [install]);

  const viewControl = useMemo(
    () => (
      <SegmentedControl
        size="xs"
        value={view}
        onValueChange={setView}
        options={viewOptions}
        testID="plugins-view"
      />
    ),
    [view, viewOptions],
  );

  if (!supported) {
    return (
      <ScrollView contentContainerStyle={styles.content}>
        <SettingsSection title={t("settings.sections.plugins")}>
          <Alert
            variant="info"
            title={t("plugins.unsupportedTitle")}
            description={t("plugins.unsupportedMessage")}
            testID="plugins-unsupported"
          />
        </SettingsSection>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content} testID="settings-plugins">
      <SettingsSection title={t("settings.sections.plugins")} trailing={viewControl}>
        {error ? (
          <Alert
            variant="error"
            title={t("plugins.errors.listFailed")}
            description={error.message}
            testID="plugins-list-error"
          />
        ) : null}

        {view === "installed" ? (
          <InstalledPluginList
            plugins={plugins}
            isLoading={isLoading}
            errorByPlugin={errorByPlugin}
            pendingEnableId={setEnabled.isPending ? (setEnabled.variables?.pluginId ?? null) : null}
            pendingUninstallId={uninstall.isPending ? (uninstall.variables ?? null) : null}
            onToggleEnabled={handleToggleEnabled}
            onUninstall={handleUninstall}
            onDismissError={clearError}
          />
        ) : (
          <BrowsePluginList
            serverId={serverId}
            installedIds={installedIds}
            errorByPlugin={errorByPlugin}
            pendingInstallId={install.isPending ? (install.variables ?? null) : null}
            onInstall={handleInstall}
            onDismissError={clearError}
          />
        )}

        {conflicts.length > 0 ? (
          <Alert
            variant="warning"
            title={t("plugins.conflictsTitle")}
            description={conflicts
              .map((conflict) =>
                t("plugins.conflictLine", {
                  extension: conflict.extension,
                  winner: conflict.winnerPluginId,
                  losers: conflict.losingPluginIds.join(", "),
                }),
              )
              .join("\n")}
            testID="plugins-conflicts"
          />
        ) : null}
      </SettingsSection>
    </ScrollView>
  );
}

function InstalledPluginList({
  plugins,
  isLoading,
  errorByPlugin,
  pendingEnableId,
  pendingUninstallId,
  onToggleEnabled,
  onUninstall,
  onDismissError,
}: {
  plugins: readonly InstalledPlugin[];
  isLoading: boolean;
  errorByPlugin: Record<string, string>;
  pendingEnableId: string | null;
  pendingUninstallId: string | null;
  onToggleEnabled: (pluginId: string, enabled: boolean) => void;
  onUninstall: (plugin: InstalledPlugin) => void;
  onDismissError: (pluginId: string) => void;
}) {
  const { t } = useTranslation();

  if (isLoading) {
    return <Text style={styles.stateText}>{t("plugins.loading")}</Text>;
  }
  if (plugins.length === 0) {
    return <Text style={styles.stateText}>{t("plugins.emptyInstalled")}</Text>;
  }

  return (
    <View style={settingsStyles.card}>
      {plugins.map((plugin, index) => (
        <InstalledPluginRow
          key={plugin.manifest.id}
          plugin={plugin}
          withBorder={index > 0}
          error={errorByPlugin[plugin.manifest.id] ?? null}
          enablePending={pendingEnableId === plugin.manifest.id}
          uninstallPending={pendingUninstallId === plugin.manifest.id}
          onToggleEnabled={onToggleEnabled}
          onUninstall={onUninstall}
          onDismissError={onDismissError}
        />
      ))}
    </View>
  );
}

function InstalledPluginRow({
  plugin,
  withBorder,
  error,
  enablePending,
  uninstallPending,
  onToggleEnabled,
  onUninstall,
  onDismissError,
}: {
  plugin: InstalledPlugin;
  withBorder: boolean;
  error: string | null;
  enablePending: boolean;
  uninstallPending: boolean;
  onToggleEnabled: (pluginId: string, enabled: boolean) => void;
  onUninstall: (plugin: InstalledPlugin) => void;
  onDismissError: (pluginId: string) => void;
}) {
  const { t } = useTranslation();
  const pluginId = plugin.manifest.id;
  const handleToggle = useCallback(
    (value: boolean) => onToggleEnabled(pluginId, value),
    [onToggleEnabled, pluginId],
  );
  const handleUninstall = useCallback(() => onUninstall(plugin), [onUninstall, plugin]);
  const handleDismiss = useCallback(() => onDismissError(pluginId), [onDismissError, pluginId]);

  return (
    <View style={withBorder ? styles.rowWithBorder : styles.row} testID={`plugin-row-${pluginId}`}>
      <View style={styles.rowHeader}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{plugin.manifest.name}</Text>
          <Text style={settingsStyles.rowHint}>
            {t("plugins.versionLine", {
              version: plugin.manifest.version,
              author: plugin.manifest.author ?? t("plugins.unknownAuthor"),
            })}
          </Text>
          {plugin.manifest.description ? (
            <Text style={settingsStyles.rowHint}>{plugin.manifest.description}</Text>
          ) : null}
        </View>
        <View style={styles.rowActions}>
          <Switch
            value={plugin.enabled}
            onValueChange={handleToggle}
            disabled={enablePending || plugin.unavailableReason !== null}
            accessibilityLabel={t("plugins.actions.toggle", { name: plugin.manifest.name })}
            testID={`plugin-toggle-${pluginId}`}
          />
          <Button
            variant="outline"
            size="sm"
            onPress={handleUninstall}
            loading={uninstallPending}
            testID={`plugin-uninstall-${pluginId}`}
          >
            {t("plugins.actions.uninstall")}
          </Button>
        </View>
      </View>

      {enablePending ? (
        <Text style={settingsStyles.rowHint}>{t("plugins.pending.updating")}</Text>
      ) : null}

      {plugin.unavailableReason ? (
        <Alert
          variant="warning"
          title={t("plugins.unavailableTitle")}
          description={plugin.unavailableReason}
          testID={`plugin-unavailable-${pluginId}`}
        />
      ) : null}

      {error ? (
        <Alert
          variant="error"
          title={t("plugins.errors.actionFailed")}
          description={error}
          testID={`plugin-error-${pluginId}`}
        >
          <Button variant="ghost" size="sm" onPress={handleDismiss}>
            {t("common.actions.dismiss")}
          </Button>
        </Alert>
      ) : null}
    </View>
  );
}

function BrowsePluginList({
  serverId,
  installedIds,
  errorByPlugin,
  pendingInstallId,
  onInstall,
  onDismissError,
}: {
  serverId: string | null;
  installedIds: ReadonlySet<string>;
  errorByPlugin: Record<string, string>;
  pendingInstallId: string | null;
  onInstall: (pluginId: string) => void;
  onDismissError: (pluginId: string) => void;
}) {
  const { t } = useTranslation();
  const registry = usePluginRegistry(serverId);

  if (registry.isLoading) {
    return <Text style={styles.stateText}>{t("plugins.loadingRegistry")}</Text>;
  }
  if (registry.error) {
    return (
      <Alert
        variant="error"
        title={t("plugins.errors.registryFailed")}
        description={registry.error.message}
        testID="plugins-registry-error"
      >
        <Button
          variant="outline"
          size="sm"
          onPress={registry.refresh}
          loading={registry.isFetching}
        >
          {t("common.actions.retry")}
        </Button>
      </Alert>
    );
  }
  if (registry.entries.length === 0) {
    return <Text style={styles.stateText}>{t("plugins.emptyRegistry")}</Text>;
  }

  return (
    <View style={settingsStyles.card}>
      {registry.entries.map((entry, index) => (
        <RegistryPluginRow
          key={entry.manifest.id}
          entry={entry}
          withBorder={index > 0}
          installed={installedIds.has(entry.manifest.id)}
          pending={pendingInstallId === entry.manifest.id}
          error={errorByPlugin[entry.manifest.id] ?? null}
          onInstall={onInstall}
          onDismissError={onDismissError}
        />
      ))}
    </View>
  );
}

function RegistryPluginRow({
  entry,
  withBorder,
  installed,
  pending,
  error,
  onInstall,
  onDismissError,
}: {
  entry: PluginRegistryEntry;
  withBorder: boolean;
  installed: boolean;
  pending: boolean;
  error: string | null;
  onInstall: (pluginId: string) => void;
  onDismissError: (pluginId: string) => void;
}) {
  const { t } = useTranslation();
  const pluginId = entry.manifest.id;
  const handleInstall = useCallback(() => onInstall(pluginId), [onInstall, pluginId]);
  const handleDismiss = useCallback(() => onDismissError(pluginId), [onDismissError, pluginId]);

  return (
    <View
      style={withBorder ? styles.rowWithBorder : styles.row}
      testID={`plugin-registry-row-${pluginId}`}
    >
      <View style={styles.rowHeader}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{entry.manifest.name}</Text>
          <Text style={settingsStyles.rowHint}>
            {t("plugins.versionLine", {
              version: entry.manifest.version,
              author: entry.manifest.author ?? t("plugins.unknownAuthor"),
            })}
          </Text>
          {entry.manifest.description ? (
            <Text style={settingsStyles.rowHint}>{entry.manifest.description}</Text>
          ) : null}
        </View>
        <View style={styles.rowActions}>
          <Button
            variant={installed ? "ghost" : "outline"}
            size="sm"
            disabled={installed}
            loading={pending}
            onPress={handleInstall}
            testID={`plugin-install-${pluginId}`}
          >
            {installed ? t("plugins.actions.installed") : t("plugins.actions.install")}
          </Button>
        </View>
      </View>

      {pending ? (
        <Text style={settingsStyles.rowHint}>{t("plugins.pending.installing")}</Text>
      ) : null}

      {error ? (
        <Alert
          variant="error"
          title={t("plugins.errors.installFailed")}
          description={error}
          testID={`plugin-registry-error-${pluginId}`}
        >
          <Button variant="ghost" size="sm" onPress={handleInstall} loading={pending}>
            {t("common.actions.retry")}
          </Button>
          <Button variant="ghost" size="sm" onPress={handleDismiss}>
            {t("common.actions.dismiss")}
          </Button>
        </Alert>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: {
    padding: theme.spacing[4],
  },
  row: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  rowWithBorder: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  rowActions: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  stateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
  },
}));
