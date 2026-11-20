import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
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

const borderedRow = [settingsStyles.row, settingsStyles.rowBorder];

type Directory = Awaited<ReturnType<DaemonClient["manageHostInstructions"]>>;
interface Conversation {
  id: string;
  name: string;
}

export function HostInstructionsSection({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(host.serverId);
  const connected = useHostRuntimeIsConnected(host.serverId);
  const supported = useHostFeature(host.serverId, "hostInstructions");
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
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [directory, setDirectory] = useState<Directory>();
  const [sourceId, setSourceId] = useState<string>();
  const [agentId, setAgentId] = useState<string>();
  const [policy, setPolicy] = useState<"ask" | "unattended">("ask");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    const loadConversations = async () => {
      try {
        const { entries } = await client.fetchAgents({ scope: "active", page: { limit: 200 } });
        if (live)
          setConversations(
            entries.flatMap(({ agent, project }) =>
              agent.workspaceId
                ? [
                    {
                      id: agent.id,
                      name: `${project.workspaceName ?? project.projectName} · ${agent.title ?? agent.provider}`,
                    },
                  ]
                : [],
            ),
          );
      } catch (cause) {
        if (live) setError(String(cause));
      }
    };
    const refresh = async () => {
      try {
        const result = await client.manageHostInstructions({ action: "list" });
        if (live) setDirectory(result);
      } catch (cause) {
        if (live) setError(String(cause));
      }
    };
    void loadConversations();
    void refresh();
    const timer = setInterval(refresh, 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client]);

  const hostLabel = (id: string) => hosts.find((item) => item.serverId === id)?.label ?? id;
  const agentLabel = (id: string) => conversations.find((item) => item.id === id)?.name ?? id;
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
  const allow = useCallback(() => {
    if (!sourceId || !agentId) return;
    void act(async () => {
      const source = getHostRuntimeStore().getClient(sourceId);
      if (!source?.isConnected || !source.getLastServerInfoMessage()?.features?.hostInstructions) {
        throw new Error(t("settings.host.instructions.updateSource"));
      }
      const { registration } = await client.manageHostInstructions({
        action: "grant",
        sourceId,
        agentId,
        policy,
      });
      if (!registration) throw new Error("The receiving host did not return a grant");
      try {
        await source.manageHostInstructions({
          action: "register",
          destinationId: host.serverId,
          agentId,
          offer: registration.offer,
          token: registration.token,
          workspaceId: registration.workspaceId,
        });
      } catch (cause) {
        await client.manageHostInstructions({ action: "revoke", id: registration.id });
        throw cause;
      }
    });
  }, [act, agentId, client, host.serverId, policy, sourceId, t]);

  const conversationOptions = useMemo(
    () =>
      conversations.map((agent) => ({
        id: agent.id,
        value: agent.id,
        label: agent.name,
      })),
    [conversations],
  );
  const policies = useMemo(
    () =>
      (["ask", "unattended"] as const).map((value) => ({
        id: value,
        value,
        label: t(`settings.host.instructions.${value}`),
      })),
    [t],
  );
  const selectedSource = sources.find((entry) => entry.id === sourceId) ?? null;
  const selectedConversation = conversationOptions.find((entry) => entry.id === agentId) ?? null;
  const selectedPolicy = policies.find((entry) => entry.id === policy) ?? null;

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
            label={t("settings.host.instructions.source")}
            placeholder={t("settings.host.instructions.source")}
            emptyText={t("settings.host.instructions.noSources")}
            value={sourceId ?? null}
            selectedDisplay={selectedSource}
            options={sources}
            disabled={busy}
            onChange={setSourceId}
          />
        </View>
      </View>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <SelectField
            label={t("settings.host.instructions.conversation")}
            placeholder={t("settings.host.instructions.conversation")}
            emptyText={t("settings.host.instructions.noConversations")}
            value={agentId ?? null}
            selectedDisplay={selectedConversation}
            options={conversationOptions}
            searchable
            disabled={busy}
            onChange={setAgentId}
          />
        </View>
      </View>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <SelectField
            label={t("settings.host.instructions.policy")}
            placeholder={t("settings.host.instructions.ask")}
            emptyText={t("settings.host.instructions.ask")}
            value={policy}
            selectedDisplay={selectedPolicy}
            options={policies}
            disabled={busy}
            onChange={setPolicy}
          />
        </View>
        <Button disabled={busy || !sourceId || !agentId} onPress={allow}>
          {t("settings.host.instructions.allow")}
        </Button>
      </View>
      {directory?.grants?.map((grant) => (
        <InstructionGrantRow
          key={grant.id}
          grant={grant}
          title={`${hostLabel(grant.sourceId)} → ${host.label}`}
          conversation={agentLabel(grant.agentId)}
          busy={busy}
          onCommand={runCommand}
        />
      ))}
      {directory?.requests?.map((request) => (
        <InstructionRequestRow
          key={`${request.sourceId}/${request.id}`}
          request={request}
          title={`${hostLabel(request.sourceId)} → ${agentLabel(request.agentId)}`}
          busy={busy}
          onCommand={runCommand}
        />
      ))}
    </View>
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
  grant: NonNullable<Directory["grants"]>[number];
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
