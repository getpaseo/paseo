import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import type { PluginListItem, PluginLogEntry } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useFetchQuery } from "@/data/query";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { resolvePluginPageState } from "@/screens/settings/plugins-page-state";
import { pluginRegistry, useInstalledPlugins } from "@/plugins/registry";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";

const pluginQueryKey = (serverId: string) => ["plugins", serverId] as const;
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

function PluginRow({
  plugin,
  clientError,
  pending,
  pendingAction,
  onAction,
  onOpenLogs,
  supportsLogs,
}: {
  plugin: PluginListItem;
  clientError?: string;
  pending: boolean;
  pendingAction?: PluginRowAction;
  onAction(action: PluginRowAction, plugin: PluginListItem): void;
  onOpenLogs(pluginId: string): void;
  supportsLogs: boolean;
}) {
  const { t } = useTranslation();
  const reload = useCallback(() => onAction("reload", plugin), [onAction, plugin]);
  const toggle = useCallback(
    () => onAction(plugin.enabled ? "disable" : "enable", plugin),
    [onAction, plugin],
  );
  const remove = useCallback(() => onAction("remove", plugin), [onAction, plugin]);
  const openLogs = useCallback(() => onOpenLogs(plugin.id), [onOpenLogs, plugin.id]);
  const status = clientError ? "failed" : plugin.status;
  let badgeVariant: "success" | "error" | "muted" = "muted";
  if (status === "running") badgeVariant = "success";
  else if (status === "failed") badgeVariant = "error";
  const statusLabel = t(`settings.plugins.status.${status}`);
  let toggleLabel = t(
    plugin.enabled ? "settings.plugins.actions.disable" : "settings.plugins.actions.enable",
  );
  if (pendingAction === "enable") toggleLabel = t("settings.plugins.actions.enabling");
  else if (pendingAction === "disable") toggleLabel = t("settings.plugins.actions.disabling");
  return (
    <View style={styles.pluginRow} accessibilityLabel={`${plugin.id} ${statusLabel}`}>
      <View style={settingsStyles.rowContent}>
        <View style={styles.pluginTitle}>
          <Text style={settingsStyles.rowTitle}>{plugin.id}</Text>
          <StatusBadge label={statusLabel} variant={badgeVariant} />
        </View>
        <Text style={settingsStyles.rowHint}>{plugin.path}</Text>
        {clientError || plugin.error ? (
          <Text style={styles.error}>{clientError ?? plugin.error}</Text>
        ) : null}
      </View>
      <View style={styles.actions}>
        {supportsLogs ? (
          <Button variant="outline" size="sm" onPress={openLogs} disabled={pending}>
            {t("settings.plugins.logs.action")}
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onPress={reload} disabled={pending || !plugin.enabled}>
          {pendingAction === "reload"
            ? t("settings.plugins.actions.reloading")
            : t("settings.plugins.actions.reload")}
        </Button>
        <Button variant="outline" size="sm" onPress={toggle} disabled={pending}>
          {toggleLabel}
        </Button>
        <Button variant="outline" size="sm" onPress={remove} disabled={pending}>
          {pendingAction === "remove"
            ? t("settings.plugins.actions.removing")
            : t("settings.plugins.actions.remove")}
        </Button>
      </View>
    </View>
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
  // COMPAT(pluginLogs): added in v0.4.0, remove gate after 2027-08-16.
  const logsSupported = useHostFeature(serverId, "pluginLogs");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const refreshQueue = useRef(Promise.resolve());
  useInstalledPlugins();
  const queryKey = useMemo(() => pluginQueryKey(serverId), [serverId]);
  const [directory, setDirectory] = useState("");
  const [pluginId, setPluginId] = useState("");
  const [directoryResetKey, setDirectoryResetKey] = useState(0);
  const [pluginIdResetKey, setPluginIdResetKey] = useState(0);
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
    if (!client) return;
    return client.on("status", (message) => {
      if (message.payload.status === "plugin_catalog_changed") void refresh();
    });
  }, [client, refresh]);
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
    const path = directory.trim();
    if (!client || !path) return;
    setFeedback(null);
    mutation.mutate({
      action: "install",
      run: async () => {
        const installed = await client.installDirectoryPlugin(path, pluginId.trim() || undefined);
        setDirectory("");
        setPluginId("");
        setDirectoryResetKey((key) => key + 1);
        setPluginIdResetKey((key) => key + 1);
        return t("settings.plugins.feedback.installed", { id: installed.id });
      },
    });
  }, [client, directory, mutation, pluginId, t]);
  const prefillManifestId = useCallback(() => {
    const path = directory.trim();
    if (!client || !path || pluginId.trim()) return;
    void client
      .inspectDirectoryPlugin(path)
      .then(({ id }) => {
        setPluginId(id);
        setPluginIdResetKey((key) => key + 1);
        return undefined;
      })
      .catch(() => undefined);
  }, [client, directory, pluginId]);
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
      <View style={settingsStyles.card}>
        {plugins.data?.length ? (
          plugins.data.map((plugin) => {
            const clientError = pluginRegistry.getEvaluationError(serverId, plugin.id);
            const pending = mutation.isPending && mutation.variables?.pluginId === plugin.id;
            return (
              <PluginRow
                key={plugin.id}
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
      </View>
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
        <View style={[settingsStyles.card, styles.install]}>
          <Field label={t("settings.plugins.directoryLabel")}>
            <FormTextInput
              initialValue=""
              resetKey={directoryResetKey}
              onChangeText={setDirectory}
              onBlur={prefillManifestId}
              placeholder={t("settings.plugins.directoryPlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!mutation.isPending}
              accessibilityLabel={t("settings.plugins.directoryLabel")}
            />
          </Field>
          <Field label={t("settings.plugins.idLabel")} hint={t("settings.plugins.idHint")}>
            <FormTextInput
              initialValue={pluginId}
              resetKey={pluginIdResetKey}
              onChangeText={setPluginId}
              placeholder={t("settings.plugins.idPlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!mutation.isPending}
              accessibilityLabel={t("settings.plugins.idLabel")}
            />
          </Field>
          <Button onPress={install} disabled={!directory.trim() || mutation.isPending}>
            {mutation.isPending && mutation.variables?.action === "install"
              ? t("settings.plugins.installing")
              : t("settings.plugins.install")}
          </Button>
        </View>
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
  install: { padding: theme.spacing[4], gap: theme.spacing[3] },
  pluginRow: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  pluginTitle: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
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
