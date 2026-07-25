import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { useShallow } from "zustand/react/shallow";
import { AgentStreamView } from "@/agent-stream/view";
import { getProviderIcon } from "@/components/provider-icons";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useSessionStore } from "@/stores/session-store";
import {
  providerSubagentKey,
  providerSubagentLifecycleStatus,
  refreshProviderSubagents,
  useProviderSubagentStore,
} from "@/subagents/provider-store";
import { useTranslation } from "react-i18next";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem } from "@/types/stream";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";

const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();
const EMPTY_STREAM_ITEMS: StreamItem[] = [];

function formatProviderLabel(provider: string): string {
  return provider
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function useProviderSubagentDescriptor(
  target: { kind: "provider_subagent"; parentAgentId: string; subagentId: string },
  context: { serverId: string },
): PanelDescriptor {
  const descriptor = useProviderSubagentStore((state) =>
    state.descriptors.get(
      providerSubagentKey(context.serverId, target.parentAgentId, target.subagentId),
    ),
  );
  const parentProvider = useSessionStore(
    (state) => state.sessions[context.serverId]?.agents.get(target.parentAgentId)?.provider,
  );
  const provider = descriptor?.provider ?? parentProvider ?? "agent";
  const label = descriptor?.title?.trim() || descriptor?.description?.trim() || "Subagent";
  return {
    label,
    subtitle: `${formatProviderLabel(provider)} subagent`,
    tooltip: label,
    titleState: descriptor ? "ready" : "loading",
    icon: getProviderIcon(provider),
    statusBucket: descriptor
      ? deriveSidebarStateBucket({
          status: providerSubagentLifecycleStatus(descriptor.status),
          requiresAttention: descriptor.status === "failed",
        })
      : null,
  };
}

function ProviderSubagentPanel() {
  const { t } = useTranslation();
  const { serverId, target, openFileInWorkspace } = usePaneContext();
  invariant(target.kind === "provider_subagent", "ProviderSubagentPanel requires provider target");
  const key = providerSubagentKey(serverId, target.parentAgentId, target.subagentId);
  const streamId = `provider:${encodeURIComponent(target.parentAgentId)}:${encodeURIComponent(target.subagentId)}`;
  const { descriptor, timeline } = useProviderSubagentStore(
    useShallow((state) => ({
      descriptor: state.descriptors.get(key) ?? null,
      timeline: state.timelines.get(key) ?? null,
    })),
  );
  const parent = useSessionStore(
    (state) =>
      state.sessions[serverId]?.agents.get(target.parentAgentId) ??
      state.sessions[serverId]?.agentDetails.get(target.parentAgentId) ??
      null,
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo ?? null);
  // COMPAT(providerSubagents): added in v0.2.11, remove after 2027-01-12.
  const supported = serverInfo?.features?.providerSubagents === true;
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);

  useEffect(() => {
    if (!client || !supported) return;
    void refreshProviderSubagents(client, serverId, target.parentAgentId).catch(() => undefined);
  }, [client, serverId, supported, target.parentAgentId]);

  useEffect(() => {
    if (!client || !supported) return;
    void client
      .fetchProviderSubagentTimeline(target.parentAgentId, target.subagentId, {
        direction: "tail",
        limit: TIMELINE_FETCH_PAGE_SIZE,
      })
      .then((payload) => {
        useProviderSubagentStore.getState().replaceTimeline(serverId, payload);
        return undefined;
      })
      .catch(() => undefined);
  }, [client, serverId, supported, target.parentAgentId, target.subagentId]);

  const loadOlder = useCallback(() => {
    if (!client || !supported || isLoadingOlder || !timeline?.hasOlder || !timeline.epoch) return;
    const firstSeq = timeline.rows.size ? Math.min(...timeline.rows.keys()) : null;
    if (firstSeq === null) return;
    setIsLoadingOlder(true);
    void client
      .fetchProviderSubagentTimeline(target.parentAgentId, target.subagentId, {
        direction: "before",
        cursor: { epoch: timeline.epoch, seq: firstSeq },
        limit: TIMELINE_FETCH_PAGE_SIZE,
      })
      .then((payload) => {
        useProviderSubagentStore.getState().replaceTimeline(serverId, payload);
        return undefined;
      })
      .catch(() => undefined)
      .finally(() => setIsLoadingOlder(false));
  }, [
    client,
    isLoadingOlder,
    serverId,
    supported,
    target.parentAgentId,
    target.subagentId,
    timeline,
  ]);

  const streamContext = useMemo<AgentScreenAgent>(
    () => ({
      serverId,
      id: streamId,
      provider: descriptor?.provider ?? parent?.provider,
      status: descriptor ? providerSubagentLifecycleStatus(descriptor.status) : "initializing",
      cwd: descriptor?.cwd ?? parent?.cwd ?? "",
      workspaceId: parent?.workspaceId,
      projectPlacement: parent?.projectPlacement,
    }),
    [descriptor, parent, serverId, streamId],
  );
  const historyPagination = useMemo(
    () => ({
      hasOlder: timeline?.hasOlder === true,
      isLoadingOlder,
      onLoadOlder: loadOlder,
    }),
    [isLoadingOlder, loadOlder, timeline?.hasOlder],
  );

  if (serverInfo && !supported) {
    return (
      <View style={styles.unsupported} testID="provider-subagent-panel-unsupported">
        <Text style={styles.unsupportedText}>{t("message.actions.forkUnavailable")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="provider-subagent-panel">
      <AgentStreamView
        agentId={streamId}
        serverId={serverId}
        context={streamContext}
        streamItems={timeline?.tail ?? EMPTY_STREAM_ITEMS}
        streamHead={timeline?.head ?? EMPTY_STREAM_ITEMS}
        pendingPermissions={EMPTY_PERMISSIONS}
        isAuthoritativeHistoryReady
        onOpenWorkspaceFile={openFileInWorkspace}
        readOnly
        historyPagination={historyPagination}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1 },
  unsupported: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  unsupportedText: { color: theme.colors.foregroundMuted, textAlign: "center" },
}));

export const providerSubagentPanelRegistration: PanelRegistration<"provider_subagent"> = {
  kind: "provider_subagent",
  component: ProviderSubagentPanel,
  useDescriptor: useProviderSubagentDescriptor,
};
