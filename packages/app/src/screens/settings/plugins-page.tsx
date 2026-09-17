import { formatPluginInstallation } from "@getpaseo/protocol/plugin-source-reference";
import { PluginSettingsMenuItems } from "@/plugins/settings";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import type { PluginListItem, PluginLogEntry } from "@getpaseo/protocol/messages";
import { MoreHorizontal, Trash2 } from "lucide-react-native";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFetchQuery } from "@/data/query";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { resolvePluginPageState } from "@/screens/settings/plugins-page-state";
import { openPluginInstallForm } from "@/screens/settings/plugin-install-form-model";
import { pluginRegistry, useInstalledPlugins } from "@/plugins/registry";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";

const pluginQueryKey = (serverId: string) => ["plugins", serverId] as const;
const PLUGIN_SOURCE_DOCS_URL = "https://paseo.sh/docs/plugins/reference#plugin-sources";
type PluginRowAction = "reload" | "enable" | "disable" | "remove";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pluginRowAction(action: string | undefined): PluginRowAction | undefined {
  if (action === "reload" || action === "enable" || action === "disable" || action === "remove") {
    return action;
  }
  return undefined;
}

function PluginActionsMenu({
  plugin,
  serverId,
  pending,
  pendingAction,
  onAction,
  onOpenLogs,
  supportsLogs,
}: {
  plugin: PluginListItem;
  serverId: string;
  pending: boolean;
  pendingAction?: PluginRowAction;
  onAction(action: PluginRowAction, plugin: PluginListItem): void;
  onOpenLogs(pluginId: string): void;
  supportsLogs: boolean;
}) {
  const { t } = useTranslation();
  const reload = useCallback(() => onAction("reload", plugin), [onAction, plugin]);
  const remove = useCallback(() => onAction("remove", plugin), [onAction, plugin]);
  const openLogs = useCallback(() => onOpenLogs(plugin.id), [onOpenLogs, plugin.id]);
  const removeIcon = useMemo(() => <Trash2 size={16} color={styles.dangerIcon.color} />, []);
  const menuLabel = t("settings.plugins.actions.menu", { id: plugin.id });

  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        accessibilityRole="button"
        accessibilityLabel={menuLabel}
        disabled={pending}
        hitSlop={8}
        style={styles.menuButton}
      >
        <MoreHorizontal size={18} color={styles.menuIcon.color} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220} sheetTitle={menuLabel}>
        <PluginSettingsMenuItems serverId={serverId} pluginId={plugin.id} disabled={pending} />
        {supportsLogs ? (
          <DropdownMenuItem onSelect={openLogs} disabled={pending}>
            {t("settings.plugins.logs.action")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={reload}
          disabled={pending || !plugin.enabled}
          status={pendingAction === "reload" ? "pending" : "idle"}
          pendingLabel={t("settings.plugins.actions.reloading")}
        >
          {t("settings.plugins.actions.reload")}
        </DropdownMenuItem>
        <DropdownMenuItem
          destructive
          leading={removeIcon}
          onSelect={remove}
          disabled={pending}
          status={pendingAction === "remove" ? "pending" : "idle"}
          pendingLabel={t("settings.plugins.actions.removing")}
        >
          {t("settings.plugins.actions.remove")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PluginRow({
  plugin,
  serverId,
  clientError,
  pending,
  pendingAction,
  onAction,
  onOpenLogs,
  supportsLogs,
}: {
  plugin: PluginListItem;
  serverId: string;
  clientError?: string;
  pending: boolean;
  pendingAction?: PluginRowAction;
  onAction(action: PluginRowAction, plugin: PluginListItem): void;
  onOpenLogs(pluginId: string): void;
  supportsLogs: boolean;
}) {
  const { t } = useTranslation();
  const toggle = useCallback(
    (enabled: boolean) => onAction(enabled ? "enable" : "disable", plugin),
    [onAction, plugin],
  );
  const status = clientError ? "failed" : plugin.status;
  let badgeVariant: "success" | "error" | "muted" = "muted";
  if (status === "running") badgeVariant = "success";
  else if (status === "failed") badgeVariant = "error";
  const statusLabel = t(`settings.plugins.status.${status}`);
  const statusBadge = useMemo(
    () => <StatusBadge label={statusLabel} variant={badgeVariant} />,
    [badgeVariant, statusLabel],
  );
  const hint = useMemo(
    () =>
      plugin.description || plugin.installation ? (
        <View>
          {plugin.description ? (
            <Text style={styles.pluginDescription}>{plugin.description}</Text>
          ) : null}
          {plugin.installation ? (
            <Text style={styles.pluginSource}>{formatPluginInstallation(plugin.installation)}</Text>
          ) : null}
        </View>
      ) : undefined,
    [plugin.description, plugin.installation],
  );
  const toggleLabel = `${plugin.id}: ${t(
    plugin.enabled ? "settings.plugins.actions.disable" : "settings.plugins.actions.enable",
  )}`;
  return (
    <SettingsRow
      label={plugin.id}
      labelAccessory={statusBadge}
      hint={hint}
      error={clientError ?? plugin.error}
      testID={`plugin-row-${plugin.id}`}
    >
      <View style={styles.pluginControls} accessibilityLabel={`${plugin.id} ${statusLabel}`}>
        <Switch
          value={plugin.enabled}
          onValueChange={toggle}
          disabled={pending}
          accessibilityLabel={toggleLabel}
        />
        <PluginActionsMenu
          plugin={plugin}
          serverId={serverId}
          pending={pending}
          pendingAction={pendingAction}
          onAction={onAction}
          onOpenLogs={onOpenLogs}
          supportsLogs={supportsLogs}
        />
      </View>
    </SettingsRow>
  );
}

function PluginLogsSheet({
  client,
  pluginId,
  serverId,
  onClose,
}: {
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
  pluginId: string;
  serverId: string;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const logs = useFetchQuery({
    queryKey: ["plugin-logs", serverId, pluginId],
    queryFn: () => client.getPluginLogs(pluginId),
    dataShape: "list",
    staleTimeMs: 0,
  });
  const refresh = useCallback(() => {
    void logs.refetch();
  }, [logs]);
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("settings.plugins.logs.title", { id: pluginId }),
      actions: (
        <Button variant="outline" size="sm" onPress={refresh} disabled={logs.isFetching}>
          {logs.isFetching
            ? t("settings.plugins.logs.refreshing")
            : t("settings.plugins.logs.refresh")}
        </Button>
      ),
    }),
    [logs.isFetching, pluginId, refresh, t],
  );

  let content = <Text style={styles.logsState}>{t("settings.plugins.logs.loading")}</Text>;
  if (logs.isError) {
    content = (
      <Alert
        variant="error"
        title={t("settings.plugins.logs.errorTitle")}
        description={errorMessage(logs.error)}
      >
        <Button variant="outline" size="sm" onPress={refresh}>
          {t("settings.plugins.logs.refresh")}
        </Button>
      </Alert>
    );
  } else if (!logs.isLoading) {
    content = logs.data?.length ? (
      <View style={styles.logList}>
        {logs.data.map((entry: PluginLogEntry) => (
          <View key={entry.sequence} style={styles.logEntry}>
            <Text style={entry.stream === "stderr" ? styles.logStderr : styles.logStdout}>
              {entry.timestamp} {entry.stream}
            </Text>
            <Text style={styles.logMessage}>{entry.message}</Text>
          </View>
        ))}
      </View>
    ) : (
      <Text style={styles.logsState}>{t("settings.plugins.logs.empty")}</Text>
    );
  }

  return (
    <AdaptiveModalSheet header={header} visible onClose={onClose} testID="plugin-logs-sheet">
      {content}
    </AdaptiveModalSheet>
  );
}

export function HostPluginsPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "pluginManagement");
  // COMPAT(pluginSourceInstallation): added in v0.8.0; remove gate after 2027-03-16 once daemon floor supports source identifiers.
  const sourceInstallSupported = useHostFeature(serverId, "pluginSourceInstallation");
  // COMPAT(pluginLogs): added in v0.4.0, remove gate after 2027-08-16.
  const logsSupported = useHostFeature(serverId, "pluginLogs");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const refreshQueue = useRef(Promise.resolve());
  useInstalledPlugins();
  const queryKey = useMemo(() => pluginQueryKey(serverId), [serverId]);
  const [installForm] = useState(openPluginInstallForm);
  const installState = useSyncExternalStore(
    installForm.subscribe,
    installForm.getState,
    installForm.getState,
  );
  const sourceDocsLink = useMemo(
    () => (
      <ExternalLink
        href={PLUGIN_SOURCE_DOCS_URL}
        label={t("settings.plugins.docs")}
        testID="plugin-source-docs-link"
      />
    ),
    [t],
  );
  const [logsPluginId, setLogsPluginId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(
    null,
  );
  const plugins = useFetchQuery({
    queryKey,
    queryFn: async () => {
      if (!client) throw new Error("Plugin host is offline");
      return client.listPlugins();
    },
    enabled: Boolean(client && connected && supported),
    dataShape: "list",
    staleTimeMs: 1_000,
  });
  const refetchPlugins = plugins.refetch;
  const refresh = useCallback(async () => {
    if (!client) return;
    const refetch = async () => {
      await refetchPlugins();
    };
    refreshQueue.current = refreshQueue.current.then(refetch, refetch);
    await refreshQueue.current;
  }, [client, refetchPlugins]);
  useEffect(() => {
    return () => installForm.close();
  }, [installForm]);
  useEffect(() => {
    if (!client || !connected || !supported) return;
    const observation = client.observeEvents(["status.plugin_catalog_changed"]);
    observation.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "status" && message.payload.status === "plugin_catalog_changed")
          void refresh();
      },
    });
    return () => {
      void observation
        .release()
        .catch((error) => console.warn("[Plugins] Failed to release settings feed", error));
    };
  }, [client, connected, supported, refresh]);
  const mutation = useMutation({
    mutationFn: async (operation: {
      action: string;
      pluginId?: string;
      run: () => Promise<string>;
    }) => operation.run(),
    onSuccess: async (message) => {
      setFeedback({ kind: "success", message });
      await refresh();
    },
    onError: (error) => setFeedback({ kind: "error", message: errorMessage(error) }),
  });
  const install = useCallback(() => {
    if (!client || !sourceInstallSupported || !installState.canSubmit) return;
    const input = installForm.getSubmission();
    setFeedback(null);
    mutation.mutate({
      action: "install",
      run: async () => {
        const installed = await client.installPluginSource(input);
        installForm.reset();
        return t("settings.plugins.feedback.installed", { id: installed.id });
      },
    });
  }, [client, installForm, installState.canSubmit, mutation, sourceInstallSupported, t]);
  const action = useCallback(
    (name: PluginRowAction, plugin: PluginListItem) => {
      if (!client) return;
      const run = async () => {
        if (name === "remove") {
          const confirmed = await confirmDialog({
            title: t("settings.plugins.removeConfirmTitle", { id: plugin.id }),
            message: t("settings.plugins.removeConfirmMessage"),
            confirmLabel: t("settings.plugins.actions.remove"),
            destructive: true,
          });
          if (!confirmed) return t("settings.plugins.feedback.kept", { id: plugin.id });
          await client.removePlugin(plugin.id);
        } else {
          await client[`${name}Plugin`](plugin.id);
        }
        return t(`settings.plugins.feedback.${name}`, { id: plugin.id });
      };
      setFeedback(null);
      mutation.mutate({ action: name, pluginId: plugin.id, run });
    },
    [client, mutation, t],
  );
  const toggleGlobal = useCallback(
    (enabled: boolean) => {
      setFeedback(null);
      mutation.mutate({
        action: enabled ? "global-enable" : "global-disable",
        run: async () => {
          await patchConfig({ pluginsEnabled: enabled });
          return enabled
            ? t("settings.plugins.feedback.globalEnabled")
            : t("settings.plugins.feedback.globalDisabled");
        },
      });
    },
    [mutation, patchConfig, t],
  );
  const pageState = resolvePluginPageState({
    connected,
    supported,
    loading: plugins.isLoading,
    error: plugins.isError,
    pluginCount: plugins.data?.length ?? 0,
  });
  const retry = useCallback(() => {
    void refetchPlugins();
  }, [refetchPlugins]);
  const closeLogs = useCallback(() => setLogsPluginId(null), []);

  if (pageState === "offline") {
    return (
      <Alert
        variant="warning"
        title={t("settings.plugins.states.offlineTitle")}
        description={t("settings.plugins.states.offlineDescription")}
      />
    );
  }
  if (pageState === "unsupported") {
    return <Alert variant="warning" title={t("settings.plugins.states.updateTitle")} />;
  }

  let catalogContent = <Alert title={t("settings.plugins.states.loading")} />;
  if (pageState === "error") {
    catalogContent = (
      <Alert
        variant="error"
        title={t("settings.plugins.states.errorTitle")}
        description={errorMessage(plugins.error)}
      >
        <Button variant="outline" size="sm" onPress={retry}>
          {t("settings.plugins.states.retry")}
        </Button>
      </Alert>
    );
  } else if (pageState !== "loading") {
    catalogContent = (
      <SettingsCard>
        {plugins.data?.length ? (
          plugins.data.map((plugin) => {
            const clientError = pluginRegistry.getEvaluationError(serverId, plugin.id);
            const pending = mutation.isPending && mutation.variables?.pluginId === plugin.id;
            return (
              <PluginRow
                key={plugin.id}
                serverId={serverId}
                plugin={plugin}
                clientError={clientError}
                pending={mutation.isPending}
                pendingAction={pending ? pluginRowAction(mutation.variables?.action) : undefined}
                onAction={action}
                onOpenLogs={setLogsPluginId}
                supportsLogs={logsSupported}
              />
            );
          })
        ) : (
          <View style={styles.empty}>
            <Text style={settingsStyles.rowHint}>{t("settings.plugins.states.empty")}</Text>
          </View>
        )}
      </SettingsCard>
    );
  }

  return (
    <View>
      <SettingsSection title={t("settings.plugins.title")}>
        <Alert
          variant="warning"
          title={t("settings.plugins.trustedTitle")}
          description={t("settings.plugins.trustedDescription")}
        />
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.plugins.globalTitle")}</Text>
              <Text style={settingsStyles.rowHint}>{t("settings.plugins.globalHint")}</Text>
            </View>
            <Switch
              value={config?.pluginsEnabled === true}
              onValueChange={toggleGlobal}
              disabled={mutation.isPending}
              accessibilityLabel={t("settings.plugins.globalTitle")}
            />
          </View>
        </View>
        {sourceInstallSupported ? (
          <View style={[settingsStyles.card, styles.install]}>
            <Field label={t("settings.plugins.sourceLabel")} trailing={sourceDocsLink}>
              <FormTextInput
                initialValue=""
                resetKey={installState.resetKey}
                onChangeText={installForm.setSource}
                placeholder={t("settings.plugins.sourcePlaceholder")}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!mutation.isPending}
                accessibilityLabel={t("settings.plugins.sourceLabel")}
              />
            </Field>
            <Button onPress={install} disabled={!installState.canSubmit || mutation.isPending}>
              {mutation.isPending && mutation.variables?.action === "install"
                ? t("settings.plugins.installing")
                : t("settings.plugins.install")}
            </Button>
          </View>
        ) : (
          <Alert variant="warning" title={t("settings.plugins.states.sourceUpdateTitle")} />
        )}
        {feedback ? (
          <Alert
            variant={feedback.kind}
            title={feedback.message}
            testID="plugin-management-feedback"
          />
        ) : null}
        {catalogContent}
      </SettingsSection>
      {client && logsPluginId ? (
        <PluginLogsSheet
          client={client}
          pluginId={logsPluginId}
          serverId={serverId}
          onClose={closeLogs}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pluginDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    marginTop: theme.spacing[1],
  },
  pluginSource: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  install: { padding: theme.spacing[4], gap: theme.spacing[3] },
  pluginControls: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  menuButton: { padding: theme.spacing[1], borderRadius: theme.borderRadius.sm },
  menuIcon: { color: theme.colors.foregroundMuted },
  dangerIcon: { color: theme.colors.statusDanger },
  empty: { padding: theme.spacing[4], alignItems: "center" },
  logsState: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
    paddingVertical: theme.spacing[6],
  },
  logList: { gap: theme.spacing[2] },
  logEntry: {
    padding: theme.spacing[3],
    gap: theme.spacing[1],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
  },
  logStdout: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  logStderr: {
    color: theme.colors.statusDanger,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  logMessage: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.base,
  },
}));
