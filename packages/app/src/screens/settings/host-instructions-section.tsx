import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { HostInstructionWorkspaceOverrides } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { useHostFeature } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useHosts,
} from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import type { HostProfile } from "@/types/host-connection";

const styles = StyleSheet.create({
  footer: { justifyContent: "flex-end" },
});
const footerRow = [settingsStyles.row, styles.footer];
const emptyOverrides: HostInstructionWorkspaceOverrides = [];
const borderedRow = [settingsStyles.row, settingsStyles.rowBorder];

type Directory = Awaited<ReturnType<DaemonClient["manageHostInstructions"]>>;
interface Workspace {
  id: string;
  name: string;
}

export function HostInstructionsSection({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(host.serverId);
  const connected = useHostRuntimeIsConnected(host.serverId);
  const supported = useHostFeature(host.serverId, "hostInstructionWorkspacePolicies");
  return (
    <SettingsSection title={t("settings.host.instructions.title")}>
      {client && connected && supported ? (
        <HostInstructionsForm key={host.serverId} host={host} client={client} />
      ) : (
        <Text style={settingsStyles.rowHint}>
          {t(
            connected ? "settings.host.instructions.update" : "settings.host.instructions.offline",
          )}
        </Text>
      )}
    </SettingsSection>
  );
}

function findSourcePolicy(directory: Directory | undefined, sourceId: string | undefined) {
  return directory?.hostPolicies?.find((entry) => entry.sourceId === sourceId);
}

function HostInstructionsForm({ host, client }: { host: HostProfile; client: DaemonClient }) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const sources = useMemo(
    () =>
      hosts
        .filter((item) => item.serverId !== host.serverId)
        .map((item) => ({ id: item.serverId, value: item.serverId, label: item.label })),
    [hosts, host.serverId],
  );
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [directory, setDirectory] = useState<Directory>();
  const [sourceId, setSourceId] = useState<string>();
  const [draftPolicy, setDraftPolicy] = useState<"ask" | "unattended">();
  const [draftOverrides, setDraftOverrides] = useState<HostInstructionWorkspaceOverrides>();
  const saved = findSourcePolicy(directory, sourceId);
  const policy = draftPolicy ?? saved?.policy ?? "ask";
  const workspaceOverrides = draftOverrides ?? saved?.workspaceOverrides ?? emptyOverrides;
  const [busy, setBusy] = useState(false);
  const canEditPolicy = Boolean(directory) && !busy;
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    const loadWorkspaces = async () => {
      const all: Workspace[] = [];
      let cursor: string | undefined;
      do {
        const { entries, pageInfo } = await client.fetchWorkspaces({
          page: { limit: 200, cursor },
        });
        if (!live) return;
        all.push(...entries.map((workspace) => ({ id: workspace.id, name: workspace.name })));
        cursor = pageInfo.nextCursor ?? undefined;
      } while (cursor);
      setWorkspaces(all);
    };
    const refresh = async () => {
      try {
        const result = await client.manageHostInstructions({ action: "list" });
        if (live) setDirectory(result);
      } catch (cause) {
        if (live) setError(String(cause));
      }
    };
    void loadWorkspaces().catch((cause: unknown) => {
      if (live) setError(String(cause));
    });
    void refresh();
    const timer = setInterval(refresh, 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client]);

  const hostLabel = (id: string) => hosts.find((item) => item.serverId === id)?.label ?? id;
  const workspaceLabel = (id: string) => workspaces.find((item) => item.id === id)?.name ?? id;
  const act = useCallback(
    async (operation: () => Promise<unknown>) => {
      setBusy(true);
      setError(undefined);
      try {
        await operation();
        setDirectory(await client.manageHostInstructions({ action: "list" }));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [client],
  );
  const runCommand = useCallback(
    (command: Command) => {
      void act(() => client.manageHostInstructions(command));
    },
    [act, client],
  );
  const selectSource = useCallback((id: string) => {
    setSourceId(id);
    setDraftPolicy(undefined);
    setDraftOverrides(undefined);
  }, []);
  const save = useCallback(() => {
    if (!sourceId || !directory) return;
    void act(async () => {
      const current = findSourcePolicy(
        await client.manageHostInstructions({ action: "list" }),
        sourceId,
      );
      const source = getHostRuntimeStore().getClient(sourceId);
      if (
        !current &&
        (!source?.isConnected ||
          !source.getLastServerInfoMessage()?.features?.hostInstructionWorkspacePolicies)
      ) {
        throw new Error(t("settings.host.instructions.updateSource"));
      }
      const canRecover =
        source?.isConnected &&
        source.getLastServerInfoMessage()?.features?.hostInstructionRegistrationRecovery &&
        client.getLastServerInfoMessage()?.features?.hostInstructionRegistrationRecovery;
      const installed =
        current && canRecover
          ? await source.manageHostInstructions({
              action: "has_registration",
              destinationId: host.serverId,
              id: current.id,
            })
          : undefined;
      const { registration } = await client.manageHostInstructions({
        action: "set_policy",
        sourceId,
        policy,
        workspaceOverrides,
        recoverRegistration: installed?.hasRegistration === false,
      });
      if (registration) {
        if (!source) throw new Error(t("settings.host.instructions.updateSource"));
        await source.manageHostInstructions({
          action: "register",
          destinationId: host.serverId,
          offer: registration.offer,
          token: registration.token,
        });
      }
    });
  }, [act, client, directory, host.serverId, policy, sourceId, t, workspaceOverrides]);

  const policies = useMemo(
    () =>
      (["ask", "unattended"] as const).map((value) => ({
        id: value,
        value,
        label: t(`settings.host.instructions.${value}`),
      })),
    [t],
  );
  const selectedPolicy = policies.find((entry) => entry.id === policy) ?? null;
  const selectedSource = sources.find((entry) => entry.id === sourceId) ?? null;

  return (
    <View style={settingsStyles.card} testID="host-instructions-section">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowHint}>{t("settings.host.instructions.help")}</Text>
          <Text style={settingsStyles.rowHint}>{t("settings.host.instructions.trust")}</Text>
          {error ? <Text style={settingsStyles.rowError}>{error}</Text> : null}
        </View>
      </View>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <SelectField
            triggerTestID="host-instruction-source"
            label={t("settings.host.instructions.source")}
            placeholder={t("settings.host.instructions.source")}
            emptyText={t("settings.host.instructions.noSources")}
            value={sourceId ?? null}
            selectedDisplay={selectedSource}
            options={sources}
            disabled={busy}
            onChange={selectSource}
          />
        </View>
      </View>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <SelectField
            triggerTestID="host-instruction-policy"
            label={t("settings.host.instructions.policy")}
            placeholder={t("settings.host.instructions.ask")}
            emptyText={t("settings.host.instructions.ask")}
            value={policy}
            selectedDisplay={selectedPolicy}
            options={policies}
            disabled={!canEditPolicy}
            onChange={setDraftPolicy}
          />
        </View>
      </View>
      {sourceId ? (
        <WorkspaceOverrideFields
          key={sourceId}
          workspaces={workspaces}
          workspaceOverrides={workspaceOverrides}
          busy={!canEditPolicy}
          onChange={setDraftOverrides}
        />
      ) : null}
      <View style={footerRow}>
        <Button disabled={!canEditPolicy || !sourceId} onPress={save}>
          {t("settings.host.instructions.save")}
        </Button>
      </View>
      {directory?.hostPolicies?.map((grant) => (
        <InstructionGrantRow
          key={grant.id}
          grant={grant}
          title={`${hostLabel(grant.sourceId)} → ${host.label}`}
          conversation={t("settings.host.instructions.allWorkspaces")}
          busy={busy}
          onCommand={runCommand}
        />
      ))}
      {directory?.grants?.map((grant) => (
        <InstructionGrantRow
          key={grant.id}
          grant={grant}
          title={`${hostLabel(grant.sourceId)} → ${host.label}`}
          conversation={`${t("settings.host.instructions.legacyConversation")} · ${grant.agentId}`}
          busy={busy}
          onCommand={runCommand}
        />
      ))}
      {directory?.requests?.map((request) => (
        <InstructionRequestRow
          key={`${request.sourceId}/${request.id}`}
          request={request}
          title={`${hostLabel(request.sourceId)} → ${workspaceLabel(request.workspaceId)}`}
          busy={busy}
          onCommand={runCommand}
        />
      ))}
    </View>
  );
}

function WorkspaceOverrideFields({
  workspaces,
  workspaceOverrides,
  busy,
  onChange,
}: {
  workspaces: Workspace[];
  workspaceOverrides: HostInstructionWorkspaceOverrides;
  busy: boolean;
  onChange: (value: HostInstructionWorkspaceOverrides) => void;
}) {
  const { t } = useTranslation();
  const [workspaceId, setWorkspaceId] = useState<string>();
  const workspaceOptions = useMemo(
    () => workspaces.map((entry) => ({ id: entry.id, value: entry.id, label: entry.name })),
    [workspaces],
  );
  const workspacePolicies = useMemo(
    () =>
      (["inherit", "ask", "unattended", "blocked"] as const).map((value) => ({
        id: value,
        value,
        label: t(`settings.host.instructions.${value}`),
      })),
    [t],
  );
  const selectedWorkspace = workspaceOptions.find((entry) => entry.id === workspaceId) ?? null;
  const workspacePolicy =
    workspaceOverrides.find((rule) => rule.workspaceId === workspaceId)?.policy ?? "inherit";
  const selectedWorkspacePolicy =
    workspacePolicies.find((entry) => entry.value === workspacePolicy) ?? null;
  const setWorkspacePolicy = useCallback(
    (value: (typeof workspacePolicies)[number]["value"]) => {
      if (!workspaceId) return;
      const others = workspaceOverrides.filter((rule) => rule.workspaceId !== workspaceId);
      onChange(value === "inherit" ? others : [...others, { workspaceId, policy: value }]);
    },
    [onChange, workspaceId, workspaceOverrides],
  );

  return (
    <>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <SelectField
            triggerTestID="host-instruction-workspace"
            label={t("settings.host.instructions.workspace")}
            placeholder={t("settings.host.instructions.chooseWorkspace")}
            emptyText={t("settings.host.instructions.noWorkspaces")}
            value={workspaceId ?? null}
            selectedDisplay={selectedWorkspace}
            options={workspaceOptions}
            searchable
            disabled={busy}
            onChange={setWorkspaceId}
          />
        </View>
      </View>
      {workspaceId ? (
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <SelectField
              label={t("settings.host.instructions.workspacePolicy")}
              placeholder={t("settings.host.instructions.inherit")}
              emptyText={t("settings.host.instructions.inherit")}
              value={workspacePolicy}
              selectedDisplay={selectedWorkspacePolicy}
              options={workspacePolicies}
              disabled={busy}
              onChange={setWorkspacePolicy}
            />
          </View>
        </View>
      ) : null}
      {workspaceOverrides.length > 0 ? (
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            {workspaceOverrides.map((rule) => (
              <Text key={rule.workspaceId} style={settingsStyles.rowHint}>
                {workspaceOptions.find((entry) => entry.id === rule.workspaceId)?.label ??
                  rule.workspaceId}{" "}
                · {t(`settings.host.instructions.${rule.policy}`)}
              </Text>
            ))}
          </View>
        </View>
      ) : null}
    </>
  );
}

type Command = Parameters<DaemonClient["manageHostInstructions"]>[0];
type RunCommand = (command: Command) => void;
function InstructionGrantRow({
  grant,
  title,
  conversation,
  busy,
  onCommand,
}: {
  grant: Pick<NonNullable<Directory["grants"]>[number], "id" | "policy">;
  title: string;
  conversation: string;
  busy: boolean;
  onCommand: RunCommand;
}) {
  const { t } = useTranslation();
  const revoke = useCallback(
    () => onCommand({ action: "revoke", id: grant.id }),
    [grant.id, onCommand],
  );
  return (
    <View style={borderedRow}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>
          {conversation} · {t(`settings.host.instructions.${grant.policy}`)}
        </Text>
      </View>
      <Button variant="destructive" disabled={busy} onPress={revoke}>
        {t("settings.host.instructions.revoke")}
      </Button>
    </View>
  );
}
function InstructionRequestRow({
  request,
  title,
  busy,
  onCommand,
}: {
  request: NonNullable<Directory["requests"]>[number];
  title: string;
  busy: boolean;
  onCommand: RunCommand;
}) {
  const { t } = useTranslation();
  const { id, sourceId } = request;
  const approve = useCallback(
    () => onCommand({ action: "decide", id, sourceId, approve: true }),
    [id, onCommand, sourceId],
  );
  const deny = useCallback(
    () => onCommand({ action: "decide", id, sourceId, approve: false }),
    [id, onCommand, sourceId],
  );
  return (
    <View style={borderedRow}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.host.instructions.pending")}</Text>
        <Text style={settingsStyles.rowHint}>{title}</Text>
        <Text selectable style={settingsStyles.rowTitle}>
          {request.prompt}
        </Text>
      </View>
      <Button variant="secondary" disabled={busy} onPress={deny}>
        {t("settings.host.instructions.deny")}
      </Button>
      <Button disabled={busy} onPress={approve}>
        {t("settings.host.instructions.approve")}
      </Button>
    </View>
  );
}
