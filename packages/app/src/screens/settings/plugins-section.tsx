import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
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
import { pluginsQueryKey, usePluginRegistry, usePlugins } from "@/plugins/queries";
import {
  runPluginAction,
  type PluginActionKind,
  type PluginActionRequest,
  type PluginActionsPort,
} from "@/plugins/model";
import { pluginFilePreviewConflicts } from "@/components/file-pane-render-mode";

type PluginsView = "installed" | "browse";

export function PluginsSection({ serverId }: { serverId: string | null }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [view, setView] = useState<PluginsView>("installed");
  const [errorByPlugin, setErrorByPlugin] = useState<Record<string, string>>({});
  // Pending is keyed by plugin id so two concurrent installs each keep their own
  // spinner instead of collapsing into one shared mutation's variables.
  const [pendingByPlugin, setPendingByPlugin] = useState<Record<string, PluginActionKind>>({});
  const client = useSessionStore((state) => state.sessions[serverId ?? ""]?.client ?? null);
  const { plugins, support, isLoading, error } = usePlugins(serverId);
  const queryClient = useQueryClient();

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

  const port = useMemo<PluginActionsPort | null>(
    () =>
      client
        ? {
            setEnabled: (input) => client.pluginsSetEnabled(input),
            install: (input) => client.pluginsInstall(input),
            uninstall: (input) => client.pluginsUninstall(input),
          }
        : null,
    [client],
  );

  const successMessages = useMemo<Record<PluginActionKind, string>>(
    () => ({
      enable: t("plugins.toast.enabled"),
      disable: t("plugins.toast.disabled"),
      install: t("plugins.toast.installed"),
      uninstall: t("plugins.toast.uninstalled"),
    }),
    [t],
  );

  const runAction = useCallback(
    (request: PluginActionRequest) => {
      void runPluginAction({
        request,
        port,
        disconnectedMessage: t("workspace.terminal.hostDisconnected"),
        effects: {
          setPending: (pluginId, kind) =>
            setPendingByPlugin((current) => {
              if (kind) {
                return { ...current, [pluginId]: kind };
              }
              const next = { ...current };
              delete next[pluginId];
              return next;
            }),
          setError: (pluginId, message) => {
            if (message === null) {
              clearError(pluginId);
              return;
            }
            setErrorByPlugin((current) => ({ ...current, [pluginId]: message }));
          },
          notifySuccess: (kind) => toast.show(successMessages[kind]),
          // The installed list is a replica refreshed by one `plugins.changed`
          // broadcast; invalidating here is the recovery for a dropped one.
          refresh: () => {
            void queryClient.invalidateQueries({ queryKey: pluginsQueryKey(serverId) });
          },
        },
      });
    },
    [clearError, port, queryClient, serverId, successMessages, t, toast],
  );

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
          runAction({ kind: "uninstall", pluginId: plugin.manifest.id });
        }
      })();
    },
    [runAction, t],
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
    (pluginId: string, enabled: boolean) =>
      runAction({ kind: enabled ? "enable" : "disable", pluginId }),
    [runAction],
  );
  const handleInstall = useCallback(
    (pluginId: string) => runAction({ kind: "install", pluginId }),
    [runAction],
  );

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

  // "No host answered yet" and "this host is too old" are different problems and
  // get different copy; only the second one is about upgrading the daemon.
  if (support !== "supported") {
    return (
      <ScrollView contentContainerStyle={styles.content}>
        <SettingsSection title={t("settings.sections.plugins")}>
          {support === "unknown" ? (
            <Alert
              variant="info"
              title={t("plugins.disconnectedTitle")}
              description={t("plugins.disconnectedMessage")}
              testID="plugins-disconnected"
            />
          ) : (
            <Alert
              variant="info"
              title={t("plugins.unsupportedTitle")}
              description={t("plugins.unsupportedMessage")}
              testID="plugins-unsupported"
            />
          )}
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
            pendingByPlugin={pendingByPlugin}
            onToggleEnabled={handleToggleEnabled}
            onUninstall={handleUninstall}
            onDismissError={clearError}
          />
        ) : (
          <BrowsePluginList
            serverId={serverId}
            installedIds={installedIds}
            errorByPlugin={errorByPlugin}
            pendingByPlugin={pendingByPlugin}
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
  pendingByPlugin,
  onToggleEnabled,
  onUninstall,
  onDismissError,
}: {
  plugins: readonly InstalledPlugin[];
  isLoading: boolean;
  errorByPlugin: Record<string, string>;
  pendingByPlugin: Record<string, PluginActionKind>;
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
          pendingKind={pendingByPlugin[plugin.manifest.id] ?? null}
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
  pendingKind,
  onToggleEnabled,
  onUninstall,
  onDismissError,
}: {
  plugin: InstalledPlugin;
  withBorder: boolean;
  error: string | null;
  pendingKind: PluginActionKind | null;
  onToggleEnabled: (pluginId: string, enabled: boolean) => void;
  onUninstall: (plugin: InstalledPlugin) => void;
  onDismissError: (pluginId: string) => void;
}) {
  const { t } = useTranslation();
  const pluginId = plugin.manifest.id;
  const enablePending = pendingKind === "enable" || pendingKind === "disable";
  const uninstallPending = pendingKind === "uninstall";
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
            // A broken plugin can always be turned off; only turning one back
            // on is blocked, otherwise uninstall is the sole way out.
            disabled={enablePending || (plugin.unavailableReason !== null && !plugin.enabled)}
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
  pendingByPlugin,
  onInstall,
  onDismissError,
}: {
  serverId: string | null;
  installedIds: ReadonlySet<string>;
  errorByPlugin: Record<string, string>;
  pendingByPlugin: Record<string, PluginActionKind>;
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
    <>
      {/*
        The daemon caches the index for five minutes, so without this a plugin
        published a minute ago is invisible with nothing the user can do about
        it. `refetchOnMount` re-asks the daemon and gets the same cached answer.
      */}
      <View style={styles.registryToolbar}>
        <Button
          variant="outline"
          size="sm"
          onPress={registry.refresh}
          loading={registry.isFetching}
          testID="plugins-registry-refresh"
        >
          {t("plugins.refreshRegistry")}
        </Button>
      </View>
      <View style={settingsStyles.card}>
        {registry.entries.map((entry, index) => (
          <RegistryPluginRow
            key={entry.manifest.id}
            entry={entry}
            withBorder={index > 0}
            installed={installedIds.has(entry.manifest.id)}
            pending={pendingByPlugin[entry.manifest.id] === "install"}
            error={errorByPlugin[entry.manifest.id] ?? null}
            onInstall={onInstall}
            onDismissError={onDismissError}
          />
        ))}
      </View>
    </>
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
  registryToolbar: {
    alignItems: "flex-end",
    paddingBottom: theme.spacing[2],
  },
}));
