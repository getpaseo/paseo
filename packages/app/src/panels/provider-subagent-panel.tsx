import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import { StyleSheet } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { useShallow } from "zustand/react/shallow";
import { AgentStreamView } from "@/agent-stream/view";
import { getProviderIcon } from "@/components/provider-icons";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor } from "@/panels/panel-registry";
import { useSessionStore } from "@/stores/session-store";
import {
  providerSubagentKey,
  providerSubagentLifecycleStatus,
  refreshProviderSubagents,
  useProviderSubagentStore,
} from "@/subagents/provider-store";
import { useTranslation } from "react-i18next";
import type { PendingPermission } from "@/types/shared";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { StreamItem } from "@/types/stream";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import type { TurnPresentation } from "@/timeline/turn-liveness";

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
  // The task names the tab; the subagent type is supporting detail beside the provider.
  const subagentType = descriptor?.title?.trim();
  const label = descriptor?.description?.trim() || subagentType || "Subagent";
  const providerLabel = `${formatProviderLabel(provider)} subagent`;
  return {
    label,
    subtitle:
      subagentType && subagentType !== label ? `${subagentType} · ${providerLabel}` : providerLabel,
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

interface ProviderSubagentControlsProps {
  client: DaemonClient;
  parentAgentId: string;
  subagentId: string;
  status: "running" | "completed" | "failed" | "canceled";
}

function ProviderSubagentControls(props: ProviderSubagentControlsProps) {
  const [message, setMessage] = useState("");
  const [inputKey, setInputKey] = useState(0);
  const [pending, setPending] = useState<"stop" | "steer" | "resume" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runControl = useCallback(
    async (action: "stop" | "steer" | "resume") => {
      if (pending) return;
      const trimmed = message.trim();
      if ((action === "steer" || action === "resume") && !trimmed) {
        setError("Enter a message first");
        return;
      }
      setPending(action);
      setError(null);
      try {
        await props.client.controlProviderSubagent({
          parentAgentId: props.parentAgentId,
          subagentId: props.subagentId,
          action,
          ...(trimmed ? { message: trimmed } : {}),
        });
        if (action !== "stop") {
          setMessage("");
          setInputKey((value) => value + 1);
        }
      } catch (controlError) {
        setError(controlError instanceof Error ? controlError.message : String(controlError));
      } finally {
        setPending(null);
      }
    },
    [message, pending, props.client, props.parentAgentId, props.subagentId],
  );
  const handleSteer = useCallback(() => void runControl("steer"), [runControl]);
  const handleStop = useCallback(() => void runControl("stop"), [runControl]);
  const handleResume = useCallback(() => void runControl("resume"), [runControl]);

  return (
    <>
      <View style={styles.controls} testID="provider-subagent-controls">
        <EditingTextInput
          key={inputKey}
          style={styles.controlInput}
          initialValue={message}
          onChangeText={setMessage}
          placeholder={
            props.status === "running" ? "Steer this subagent" : "Message to resume this subagent"
          }
          placeholderTextColor={styles.placeholderColor.color}
          editable={pending === null}
          accessibilityLabel="Pi Subagent control message"
        />
        {props.status === "running" ? (
          <>
            <Button
              size="xs"
              variant="default"
              loading={pending === "steer"}
              disabled={pending !== null}
              onPress={handleSteer}
            >
              Steer
            </Button>
            <Button
              size="xs"
              variant="outline"
              loading={pending === "stop"}
              disabled={pending !== null}
              onPress={handleStop}
            >
              Stop
            </Button>
          </>
        ) : (
          <Button
            size="xs"
            variant="default"
            loading={pending === "resume"}
            disabled={pending !== null}
            onPress={handleResume}
          >
            Resume
          </Button>
        )}
      </View>
      {error ? <Text style={styles.controlError}>{error}</Text> : null}
    </>
  );
}

interface ProviderSubagentHeaderProps {
  subtitle: string | undefined;
  controlsSupported: boolean;
  client: DaemonClient | null;
  descriptor: {
    status: "running" | "completed" | "failed" | "canceled";
  } | null;
  parentAgentId: string;
  subagentId: string;
}

function ProviderSubagentHeader(props: ProviderSubagentHeaderProps) {
  if (!props.subtitle && !props.controlsSupported) return null;
  return (
    <View style={styles.controlHeader}>
      {props.subtitle ? (
        <Text
          style={styles.subtitleText}
          numberOfLines={1}
          testID="provider-subagent-pane-subtitle"
        >
          {props.subtitle}
        </Text>
      ) : null}
      {props.controlsSupported && props.client && props.descriptor ? (
        <ProviderSubagentControls
          client={props.client}
          parentAgentId={props.parentAgentId}
          subagentId={props.subagentId}
          status={props.descriptor.status}
        />
      ) : null}
    </View>
  );
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
  // COMPAT(providerSubagentControl): added in v0.5.1-pie.1, remove after 2027-02-24.
  const controlsSupported = serverInfo?.features?.providerSubagentControl === true;

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

  const loadOlder = useCallback((): boolean => {
    if (!client || !supported || isLoadingOlder || !timeline?.hasOlder || !timeline.epoch) {
      return false;
    }
    const firstSeq = timeline.rows.size ? Math.min(...timeline.rows.keys()) : null;
    if (firstSeq === null) return false;
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
    return true;
  }, [
    client,
    isLoadingOlder,
    serverId,
    supported,
    target.parentAgentId,
    target.subagentId,
    timeline,
  ]);
  const firstTimelineSeq = timeline?.rows.size ? Math.min(...timeline.rows.keys()) : null;
  const progressKey =
    timeline?.epoch && firstTimelineSeq !== null ? `${timeline.epoch}:${firstTimelineSeq}` : null;
  const subtitle = descriptor?.subtitle?.trim();

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
      progressKey,
      onLoadOlder: loadOlder,
    }),
    [isLoadingOlder, loadOlder, progressKey, timeline?.hasOlder],
  );
  const turnPresentation = useMemo<TurnPresentation>(
    () => ({
      isActive: descriptor?.status === "running",
      isCancelling: false,
      startedAt: null,
      turnId: null,
    }),
    [descriptor?.status],
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
      <ProviderSubagentHeader
        subtitle={subtitle}
        controlsSupported={controlsSupported}
        client={client}
        descriptor={descriptor}
        parentAgentId={target.parentAgentId}
        subagentId={target.subagentId}
      />
      <AgentStreamView
        agentId={streamId}
        serverId={serverId}
        context={streamContext}
        streamItems={timeline?.tail ?? EMPTY_STREAM_ITEMS}
        streamHead={timeline?.head ?? EMPTY_STREAM_ITEMS}
        turnPresentation={turnPresentation}
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
  container: { flex: 1, minHeight: 0 },
  controlHeader: {
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  subtitleText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  controlInput: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.sm,
  },
  placeholderColor: {
    color: theme.colors.foregroundMuted,
  },
  controlError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  unsupported: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  unsupportedText: { color: theme.colors.foregroundMuted, textAlign: "center" },
}));

export const providerSubagentPanelRegistration = definePanel("provider_subagent", {
  component: ProviderSubagentPanel,
  useDescriptor: useProviderSubagentDescriptor,
});
