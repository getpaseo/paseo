import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  ManagedMcpService,
  PluginListItem,
  PluginMcpServiceSummary,
} from "@getpaseo/protocol/messages";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { McpServiceForm } from "./mcp-service-form";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Plus, Pencil, Trash2 } from "lucide-react-native";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useToast } from "@/contexts/toast-api-context";
import { confirmDialog } from "@/utils/confirm-dialog";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { StatusBadge } from "@/components/ui/status-badge";
import { useFetchQuery } from "@/data/query";
import { useInstalledPlugin } from "@/plugins/registry";
import { buildPluginSettingsRoute } from "@/plugins/settings/routes";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeSnapshot, useHosts } from "@/runtime/host-runtime";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedPlus = withUnistyles(Plus);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash = withUnistyles(Trash2);
const plusColor = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const TRANSPORT_LABELS = { stdio: "stdio", http: "HTTP", sse: "SSE" } as const;

function McpServiceRow({
  serverId,
  plugin,
  service,
}: {
  serverId: string;
  plugin: PluginListItem;
  service: PluginMcpServiceSummary;
}) {
  const { t } = useTranslation();
  const installation = useInstalledPlugin(serverId, plugin.id);
  const screen = installation?.settingsScreens.find((item) => item.id === service.settingsScreenId);
  const configure = useCallback(() => {
    if (screen) router.push(buildPluginSettingsRoute(serverId, plugin.id, screen.id));
  }, [plugin.id, screen, serverId]);
  const badge = useMemo(
    () => (
      <StatusBadge
        label={t(service.configured ? "mcp.registered" : "mcp.unconfigured")}
        variant={service.configured ? "success" : "muted"}
      />
    ),
    [service.configured, t],
  );
  return (
    <SettingsRow
      label={service.label}
      labelAccessory={badge}
      hint={`${plugin.name ?? plugin.id}${service.transport ? ` · ${TRANSPORT_LABELS[service.transport]}` : ""}`}
      testID={`mcp-service-${plugin.id}`}
    >
      {screen ? (
        <Button variant="outline" size="sm" onPress={configure}>
          {t("mcp.configure")}
        </Button>
      ) : null}
    </SettingsRow>
  );
}

function McpServices({
  serverId,
  client,
  connectionEpoch,
  clientGeneration,
}: {
  serverId: string;
  client: DaemonClient;
  connectionEpoch: number;
  clientGeneration: number;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<{ id: string; service?: ManagedMcpService } | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const hostLabel = useHosts().find((host) => host.serverId === serverId)?.label ?? serverId;
  const queryKey = useMemo(
    () => ["plugin-mcp-services", serverId, clientGeneration, connectionEpoch] as const,
    [serverId, clientGeneration, connectionEpoch],
  );
  const services = useFetchQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const [plugins, config] = await Promise.all([client.listPlugins(), client.getDaemonConfig()]);
      signal.throwIfAborted();
      return { plugins, manual: config.config.mcpServers ?? {} };
    },
    dataShape: "value",
    staleTimeMs: 0,
  });
  const refresh = useCallback(async () => {
    // Cancel even the initial fetch before asking for the current worker's definition.
    await queryClient.cancelQueries({ queryKey, exact: true });
    await queryClient.invalidateQueries({ queryKey, exact: true });
  }, [queryClient, queryKey]);
  useEffect(() => {
    const observation = client.observeEvents([
      "status.plugin_catalog_changed",
      "status.daemon_config_changed",
    ]);
    observation.subscribe({
      snapshot: () => {
        void refresh();
      },
      update: () => {
        void refresh();
      },
    });
    return () => {
      void observation
        .release()
        .catch((error) => console.warn("[MCP] Failed to release service feed", error));
    };
  }, [client, queryClient, queryKey, refresh]);
  const retry = useCallback(() => {
    void refresh();
  }, [refresh]);
  const add = useCallback(() => {
    setEditing({ id: `m${randomUUID()}` });
  }, []);
  const cancel = useCallback(() => setEditing(null), []);
  const edit = useCallback((id: string, service: ManagedMcpService) => {
    setEditing({ id, service });
  }, []);
  const save = useCallback(
    async (service: ManagedMcpService) => {
      if (!editing) return;
      await client.patchDaemonConfig({ mcpServers: { [editing.id]: service } });
      setEditing(null);
      toast.show(t("mcp.saved"), { variant: "success" });
      await refresh();
    },
    [client, editing, refresh, t, toast],
  );
  const mutation = useMutation({
    mutationFn: async ({ id, service, action }: ManualMcpAction) => {
      if (action === "delete") {
        const confirmed = await confirmDialog({
          title: t("mcp.deleteTitle", { name: service.name }),
          message: t("mcp.deleteHint"),
          confirmLabel: t("mcp.delete"),
          cancelLabel: t("common.actions.cancel"),
          destructive: true,
        });
        if (!confirmed || !active.current) return null;
      }
      const replacement = action === "delete" ? null : { ...service, enabled: !service.enabled };
      await client.patchDaemonConfig({ mcpServers: { [id]: replacement } });
      if (action === "delete") return t("mcp.deleted");
      return t(service.enabled ? "mcp.serviceDisabled" : "mcp.serviceEnabled");
    },
    onSuccess: async (message) => {
      if (!active.current || message === null) return;
      toast.show(message, { variant: "success" });
      await refresh();
    },
    onError: () => {
      if (active.current) toast.error(t("mcp.updateError"));
    },
  });
  const change = useCallback(
    (operation: ManualMcpAction) => {
      if (mutation.isPending) return;
      mutation.mutate(operation);
    },
    [mutation],
  );
  const actionsDisabled = editing !== null || mutation.isPending;
  const addButton = useMemo(
    () => (
      <ToolbarButton label={t("mcp.add")} testID="mcp-add" onPress={add} disabled={actionsDisabled}>
        <ThemedPlus size={ICON_SIZE.sm} uniProps={plusColor} />
      </ToolbarButton>
    ),
    [actionsDisabled, add, t],
  );
  if (services.isError && !services.data)
    return (
      <Alert variant="error" title={t("mcp.loadError")}>
        <Button variant="outline" size="sm" onPress={retry}>
          {t("common.actions.retry")}
        </Button>
      </Alert>
    );
  if (services.isPending && !services.data) return <Alert title={t("mcp.loading")} />;
  const plugins = services.data?.plugins.filter((plugin) => plugin.mcpServer) ?? [];
  const manual = Object.entries(services.data?.manual ?? {});
  return (
    <SettingsSection
      title={hostLabel}
      info={t("mcp.runtimeHint")}
      testID="mcp-services-section"
      trailing={addButton}
    >
      {editing ? (
        <McpServiceForm key={editing.id} service={editing.service} save={save} cancel={cancel} />
      ) : null}
      {services.isError ? <Alert variant="error" title={t("mcp.loadError")} /> : null}
      <SettingsCard>
        {manual.map(([id, service]) => (
          <ManualMcpRow
            key={id}
            id={id}
            service={service}
            edit={edit}
            change={change}
            disabled={actionsDisabled}
          />
        ))}
        {plugins.length
          ? plugins.map((plugin) =>
              plugin.mcpServer ? (
                <McpServiceRow
                  key={plugin.id}
                  serverId={serverId}
                  plugin={plugin}
                  service={plugin.mcpServer}
                />
              ) : null,
            )
          : null}
        {!plugins.length && !manual.length ? <SettingsRow label={t("mcp.empty")} /> : null}
      </SettingsCard>
    </SettingsSection>
  );
}

export function HostMcpPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const host = useHostRuntimeSnapshot(serverId);
  const supported = useHostFeature(serverId, "mcpServiceManagement");
  if (host?.connectionStatus !== "online" || !host.client)
    return <Alert variant="warning" title={t("mcp.offline")} />;
  if (!supported) return <Alert variant="warning" title={t("mcp.updateHost")} />;
  return (
    <View testID="mcp-services-page">
      <McpServices
        key={`${serverId}:${host.clientGeneration}:${host.connectionEpoch}`}
        serverId={serverId}
        client={host.client}
        clientGeneration={host.clientGeneration}
        connectionEpoch={host.connectionEpoch}
      />
    </View>
  );
}

function ManualMcpRow({
  id,
  service,
  edit,
  change,
  disabled,
}: {
  id: string;
  service: ManagedMcpService;
  edit: (id: string, service: ManagedMcpService) => void;
  change: (operation: ManualMcpAction) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const onEdit = useCallback(() => edit(id, service), [edit, id, service]);
  const toggle = useCallback(
    () => change({ id, service, action: "toggle" }),
    [change, id, service],
  );
  const remove = useCallback(
    () => change({ id, service, action: "delete" }),
    [change, id, service],
  );
  const badge = useMemo(
    () =>
      !service.enabled ? <StatusBadge label={t("mcp.disabled")} variant="muted" /> : undefined,
    [service.enabled, t],
  );
  return (
    <SettingsRow
      label={service.name}
      hint={`${t("mcp.manual")} · ${TRANSPORT_LABELS[service.config.type]}`}
      testID={`mcp-manual-${id}`}
      labelAccessory={badge}
    >
      <View style={styles.actions}>
        <ToolbarButton label={t("mcp.edit")} disabled={disabled} onPress={onEdit}>
          <ThemedPencil size={ICON_SIZE.sm} uniProps={plusColor} />
        </ToolbarButton>
        <Switch
          value={service.enabled}
          onValueChange={toggle}
          disabled={disabled}
          accessibilityLabel={service.name}
          testID="mcp-service-enabled"
        />
        <ToolbarButton label={t("mcp.delete")} disabled={disabled} onPress={remove}>
          <ThemedTrash size={ICON_SIZE.sm} uniProps={plusColor} />
        </ToolbarButton>
      </View>
    </SettingsRow>
  );
}

interface ManualMcpAction {
  id: string;
  service: ManagedMcpService;
  action: "toggle" | "delete";
}

const styles = StyleSheet.create((theme) => ({
  actions: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
}));
