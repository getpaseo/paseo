import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { createPaseoApi, type HostSummary, type HostDirectory } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  SettingsCard,
  SettingsRow,
  SettingsInput,
  SettingsSwitch,
  SettingsSection,
} from "@/components/settings";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { ConnectedHostsModel, type Editor } from "./model";

export function ConnectedHostsSection({ serverId }: { serverId: string }) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  return (
    <SettingsSection title="Hosts connected to this daemon">
      {client ? (
        <ConnectedHosts key={serverId} client={client} connected={connected} />
      ) : (
        <SettingsCard>
          <SettingsRow label="Connect to this daemon to manage its hosts" />
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
function useModel(client: DaemonClient, connected: boolean) {
  const [model] = useState(() => new ConnectedHostsModel(createPaseoApi(client)));
  useEffect(() => {
    model.setConnected(connected);
  }, [model, connected]);
  useEffect(() => model.close, [model]);
  return model;
}
function ConnectedHosts({ client, connected }: { client: DaemonClient; connected: boolean }) {
  const model = useModel(client, connected);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const info = client.getLastServerInfoMessage();
  const canManage = info?.permissions?.includes("tunnel.manage") === true;
  const directory = state.load.status === "loaded" ? state.load.directory : null;
  const editor = state.editor;
  return (
    <View style={styles.section}>
      {state.load.status === "loading" ? (
        <SettingsCard>
          <SettingsRow label="Loading connected hosts…" />
        </SettingsCard>
      ) : null}
      {state.load.status === "error" ? (
        <SettingsCard>
          <SettingsRow label="Could not load connected hosts" error={state.load.error}>
            <Button variant="outline" size="sm" onPress={model.start}>
              Retry
            </Button>
          </SettingsRow>
        </SettingsCard>
      ) : null}
      {directory ? (
        <HostList
          directory={directory}
          model={model}
          canManage={canManage}
          pending={state.pending !== null}
        />
      ) : null}
      {directory && canManage && !editor ? (
        <Button variant="outline" size="sm" disabled={state.pending !== null} onPress={model.add}>
          Add host
        </Button>
      ) : null}
      {editor ? (
        <HostEditor
          key={editor.key}
          editor={editor}
          directory={directory}
          model={model}
          canManage={canManage}
          manageSources={info?.permissions?.includes("access.manage") === true}
          sourceId={info?.sourceId}
          pending={state.pending !== null}
        />
      ) : null}
      {state.error ? (
        <SettingsCard>
          <SettingsRow label="Host change failed" error={state.error}>
            <Button variant="ghost" size="sm" onPress={model.dismissError}>
              Dismiss
            </Button>
          </SettingsRow>
        </SettingsCard>
      ) : null}
      {state.pending ? (
        <Text accessibilityLiveRegion="polite" style={settingsStyles.rowHint}>
          Saving host change…
        </Text>
      ) : null}
    </View>
  );
}
function HostList({
  directory,
  model,
  canManage,
  pending,
}: {
  directory: HostDirectory;
  model: ConnectedHostsModel;
  canManage: boolean;
  pending: boolean;
}) {
  return (
    <SettingsCard>
      {directory.hosts.length === 0 ? (
        <SettingsRow label="No hosts connected to this daemon" />
      ) : (
        directory.hosts.map((host) => (
          <HostRow
            key={host.registrationId}
            host={host}
            model={model}
            canManage={canManage}
            pending={pending}
          />
        ))
      )}
    </SettingsCard>
  );
}
function HostRow({
  host,
  model,
  canManage,
  pending,
}: {
  host: HostSummary;
  model: ConnectedHostsModel;
  canManage: boolean;
  pending: boolean;
}) {
  const edit = useCallback(() => model.edit(host), [host, model]);
  const toggle = useCallback(() => void model.setEnabled(host), [host, model]);
  return (
    <SettingsRow
      label={host.label ?? host.serverId ?? host.registrationId}
      hint={`${host.status} · ${host.enabled ? "Enabled" : "Disabled"} · ${sourceLabel(host.source.id)}`}
    >
      <View style={styles.actions}>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onPress={edit}
          accessibilityLabel={`Details for ${host.label ?? host.registrationId}`}
        >
          Details
        </Button>
        {canManage ? (
          <Button variant="outline" size="sm" disabled={pending} onPress={toggle}>
            {host.enabled ? "Disable" : "Enable"}
          </Button>
        ) : null}
      </View>
    </SettingsRow>
  );
}
function HostDetails({ host }: { host: HostSummary }) {
  return (
    <SettingsCard>
      <SettingsRow label="Registration" hint={host.registrationId} />
      <SettingsRow label="Server ID" hint={host.serverId ?? "Not discovered"} />
      <SettingsRow label="Connection" hint={host.targetDescription} />
      <SettingsRow label="Metadata" hint={JSON.stringify(host.metadata)} />
      <SettingsRow label="Status" hint={host.status} />
      <SettingsRow label="Source" hint={sourceLabel(host.source.id)} />
      <SettingsRow label="Source identity" hint={host.source.id} />
      <SettingsRow label="Source key" hint={host.source.key} />
      <SettingsRow label="Last online" hint={host.lastOnlineAt ?? "Never"} />
      <SettingsRow label="Next retry" hint={host.nextRetryAt ?? "None scheduled"} />
      {host.error ? <SettingsRow label={host.error.code} error={host.error.message} /> : null}
    </SettingsCard>
  );
}
function HostEditor({
  editor,
  directory,
  model,
  canManage,
  manageSources,
  sourceId,
  pending,
}: {
  editor: Editor;
  directory: HostDirectory | null;
  model: ConnectedHostsModel;
  canManage: boolean;
  manageSources: boolean;
  sourceId: string | undefined;
  pending: boolean;
}) {
  const compact = useIsCompactFormFactor();
  const detail =
    directory?.hosts.find((host) => host.registrationId === editor.host?.registrationId) ??
    editor.host;
  const editSource = !detail || manageSources || detail.source.id === sourceId;
  const remove = useCallback(async () => {
    if (!detail) return;
    const confirmed = await confirmDialog({
      title: "Remove connected host?",
      message:
        detail.source.id === "owner"
          ? "This removes the saved connection. The host's agents and workspaces keep running."
          : `Managed by ${detail.source.id}. Its source can add it again. Disable the host to keep access off.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (confirmed) await model.remove(detail);
  }, [detail, model]);
  return (
    <View style={styles.section}>
      <Text style={settingsStyles.rowTitle}>{detail ? "Connected host details" : "Add host"}</Text>
      {detail ? <HostDetails host={detail} /> : null}
      {canManage ? (
        <SettingsCard>
          <SettingsInput
            label="Host name"
            initialValue={editor.label}
            onChangeText={model.setLabel}
            disabled={pending}
          />
          {editSource ? (
            <SettingsInput
              label={detail ? "Replacement connection" : "Connection string"}
              initialValue={editor.connection}
              onChangeText={model.setConnection}
              secureTextEntry
              disabled={pending}
            />
          ) : null}
          {detail && editSource ? (
            <SettingsSwitch
              label="Replace destination identity"
              value={editor.replaceIdentity}
              onValueChange={model.setReplaceIdentity}
              disabled={pending}
            />
          ) : null}
        </SettingsCard>
      ) : null}
      {canManage && editSource ? (
        <Field label="Metadata">
          <FormTextInput
            accessibilityLabel="Metadata"
            initialValue={editor.metadata}
            onChangeText={model.setMetadata}
            multiline
            editable={!pending}
            size={compact ? "md" : "sm"}
          />
        </Field>
      ) : null}
      <View style={styles.actions}>
        {canManage ? (
          <Button
            variant="default"
            size="sm"
            loading={pending}
            disabled={pending}
            onPress={model.save}
          >
            Save host
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" disabled={pending} onPress={model.cancel}>
          Cancel
        </Button>
        {canManage && detail && editSource ? (
          <Button variant="outline" size="sm" disabled={pending} onPress={remove}>
            Remove host
          </Button>
        ) : null}
      </View>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing[3] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
}));

function sourceLabel(sourceId: string): string {
  if (sourceId === "owner") return "User";
  if (sourceId.startsWith("plugin:")) return `Plugin: ${sourceId.slice("plugin:".length)}`;
  if (sourceId.startsWith("route:")) {
    const components = sourceId.split(":");
    let producer: string;
    try {
      producer = decodeURIComponent(components[3] ?? "");
    } catch {
      return "User (via host)";
    }
    return producer.startsWith("plugin:")
      ? `Plugin: ${producer.slice("plugin:".length)} (via host)`
      : "User (via host)";
  }
  return "User";
}
