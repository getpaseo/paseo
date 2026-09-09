import { useCallback, useEffect, useMemo, useState } from "react";
import { Square } from "lucide-react-native";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { useShallow } from "zustand/react/shallow";
import type { AgentCapabilityFlags } from "@getpaseo/protocol/agent-types";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useToast } from "@/contexts/toast-context";
import { AgentStreamView } from "@/agent-stream/view";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getProviderIcon } from "@/components/provider-icons";
import {
  resolveComposerTrackControlClearance,
  resolveComposerTrackTailClearance,
} from "@/composer/pill-styles";
import { ComposerTrackBar } from "@/composer/tracks";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor } from "@/panels/panel-registry";
import { useSessionStore } from "@/stores/session-store";
import { useSubagentsForParent } from "@/subagents/select";
import { SubagentsTrack } from "@/subagents/track";
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
import type { TurnPresentation } from "@/timeline/turn-liveness";

const ThemedSquare = withUnistyles(Square, (theme) => ({
  color: theme.colors.foregroundMuted,
  fill: theme.colors.foregroundMuted,
}));
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();
const EMPTY_STREAM_ITEMS: StreamItem[] = [];
const NOOP_SUBAGENT = () => undefined;

function resolveChildTrackClearance(childCount: number, isCompact: boolean) {
  if (childCount === 0) return { tail: 0, controls: 0 };
  return {
    tail: resolveComposerTrackTailClearance(isCompact),
    controls: resolveComposerTrackControlClearance(isCompact),
  };
}

function ProviderSubagentChildTrack({
  serverId,
  rows,
  onOpenProviderSubagent,
}: {
  serverId: string;
  rows: ReturnType<typeof useSubagentsForParent>;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <ComposerTrackBar>
      <SubagentsTrack
        serverId={serverId}
        rows={rows}
        onOpenSubagent={NOOP_SUBAGENT}
        onOpenProviderSubagent={onOpenProviderSubagent}
        onArchiveSubagent={NOOP_SUBAGENT}
      />
    </ComposerTrackBar>
  );
}

/**
 * Stop one running subagent, leaving the parent turn alone.
 *
 * This control is the consumer half of Claude's `perTaskStopAffordance` bargain: because Paseo
 * renders it, an interrupt on the parent spares its background subagents instead of killing them.
 * Removing it without also dropping the declaration in the Claude provider silently restores the
 * old behavior, where Stop reaped every background child. See docs/agent-lifecycle.md.
 */
/**
 * Whether a per-subagent stop can be offered at all: the daemon must serve the RPC and the
 * parent's provider must implement it. Several providers announce subagents and only some can stop
 * one, so gating on "a subagent is running" alone renders a control that cannot work.
 *
 * COMPAT(providerSubagentStop): added in v0.8.0, remove gate after 2027-03-09.
 */
function canStopProviderSubagent(
  serverInfo: { features?: { providerSubagentStop?: boolean } } | null,
  capabilities: AgentCapabilityFlags | undefined,
): boolean {
  if (serverInfo?.features?.providerSubagentStop !== true) return false;
  return capabilities?.supportsStopProviderSubagent === true;
}

function ProviderSubagentStopControl({
  client,
  parentAgentId,
  subagentId,
}: {
  client: DaemonClient | null;
  parentAgentId: string;
  subagentId: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [isStopping, setIsStopping] = useState(false);
  const handleStop = useCallback(() => {
    if (!client || isStopping) return;
    setIsStopping(true);
    client
      .stopProviderSubagent(parentAgentId, subagentId)
      .then((stopped) => {
        // `false` is not a failure: the provider could not address this child any more, which in
        // practice means it settled between the render and the press. Say that, rather than
        // leaving a spinner that stops for no visible reason.
        if (!stopped) toast.show(t("subagents.stopAlreadyFinished"));
        return undefined;
      })
      .catch((error: unknown) => {
        // A rejection means the provider refused, timed out, or the request never arrived. The
        // subagent is still running, so silence here would be a lie.
        toast.error(
          t("subagents.stopFailed", {
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      })
      .finally(() => setIsStopping(false));
  }, [client, isStopping, parentAgentId, subagentId, t, toast]);
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        onPress={handleStop}
        disabled={!client || isStopping}
        accessibilityLabel={t("subagents.stopAction")}
        accessibilityRole="button"
        style={styles.stopButton}
        testID="provider-subagent-pane-stop"
      >
        {isStopping ? <ThemedLoadingSpinner size="small" /> : <ThemedSquare size={10} />}
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{t("subagents.stopTooltip")}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function ProviderSubagentPaneHeader({
  subtitle,
  status,
  canStop,
  client,
  parentAgentId,
  subagentId,
}: {
  canStop: boolean;
  subtitle: string | undefined;
  status: string | undefined;
  client: DaemonClient | null;
  parentAgentId: string;
  subagentId: string;
}) {
  const isRunning = status === "running" && canStop;
  if (!subtitle && !isRunning) return null;
  return (
    <View style={styles.subtitleHeader}>
      <Text style={styles.subtitleText} numberOfLines={1} testID="provider-subagent-pane-subtitle">
        {subtitle ?? ""}
      </Text>
      {isRunning ? (
        <ProviderSubagentStopControl
          client={client}
          parentAgentId={parentAgentId}
          subagentId={subagentId}
        />
      ) : null}
    </View>
  );
}

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
    icon: getProviderIcon(provider, context.serverId),
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
  const { serverId, target, openFileInWorkspace, openTab } = usePaneContext();
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
  const canStopSubagent = canStopProviderSubagent(serverInfo, parent?.capabilities);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const isCompact = useIsCompactFormFactor();
  const childRows = useSubagentsForParent({
    serverId,
    parentAgentId: target.parentAgentId,
    providerParentSubagentId: target.subagentId,
  });
  const childTrackClearance = resolveChildTrackClearance(childRows.length, isCompact);
  const openProviderChild = useCallback(
    (parentAgentId: string, subagentId: string) => {
      openTab({ kind: "provider_subagent", parentAgentId, subagentId });
    },
    [openTab],
  );

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
      <ProviderSubagentPaneHeader
        subtitle={subtitle}
        status={descriptor?.status}
        canStop={canStopSubagent}
        client={client}
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
        bottomOverlayTailClearance={childTrackClearance.tail}
        bottomOverlayControlClearance={childTrackClearance.controls}
      />
      <ProviderSubagentChildTrack
        serverId={serverId}
        rows={childRows}
        onOpenProviderSubagent={openProviderChild}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  subtitleHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  subtitleText: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  stopButton: {
    alignItems: "center",
    justifyContent: "center",
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  unsupported: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  unsupportedText: { color: theme.colors.foregroundMuted, textAlign: "center" },
}));

export const providerSubagentPanelRegistration = definePanel("provider_subagent", {
  component: ProviderSubagentPanel,
  useDescriptor: useProviderSubagentDescriptor,
});
