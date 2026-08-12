import React, { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import {
  useHostRuntimeIsConnected,
  useHostRuntimeIsDirectoryLoading,
} from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { readAgentStreamActivityAt } from "@/runtime/activity/stream-activity";
import { useSessionStore } from "@/stores/session-store";
import {
  formatStallDuration,
  resolveIdleMs,
  resolveWorkingIndicatorActivity,
} from "./working-indicator-state";
import type { Theme } from "@/styles/theme";
import type { TurnTiming } from "@/timeline/turn-time";
import type { StreamItem } from "@/types/stream";
import {
  collectAssistantTurnContentForStreamRenderStrategy,
  type StreamStrategy,
} from "./strategy";
import { resolveAssistantTurnForkBoundary, type AssistantTurnForkBoundary } from "./turn-boundary";
import {
  AssistantTurnFooter,
  LiveElapsed,
  STREAM_METADATA_FONT_SIZE,
  type AssistantForkTarget,
} from "@/components/message";
import type { TurnFooterHost } from "./layout";
import { AssistantForkMenu } from "@/components/assistant-fork-menu";
import { SyncedLoader } from "@/components/synced-loader";
import { useRetainedPanelActive } from "@/components/retained-panel";

const ThemedSyncedLoader = withUnistyles(SyncedLoader);
const WORKING_ACTIVITY_TICK_MS = 15_000;
const workingIndicatorColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

export type TurnContentStrategy = StreamStrategy;
export type AssistantTurnForkHandler = (input: {
  target: AssistantForkTarget;
  boundary: AssistantTurnForkBoundary;
}) => Promise<void> | void;
/**
 * Fork handler for the turn that is still streaming. It deliberately takes no
 * boundary: `selectForkContextRows` projects the entire timeline when neither
 * boundary field is given, which is what captures the partially streamed text
 * the user is watching. Pinning a boundary here would silently drop the live
 * response — the opposite of what a fork button next to the loader promises.
 *
 * Kept separate from `AssistantTurnForkHandler` (whose `boundary` stays
 * required) so the compiler keeps enforcing that completed turns always pin one.
 */
export type InFlightTurnForkHandler = (target: AssistantForkTarget) => Promise<void> | void;

export const TurnFooter = memo(function TurnFooter({
  serverId,
  agentId,
  isRunning,
  inFlightTurnStartedAt,
  host,
  strategy,
  supportsTimelineCursor,
  onForkAssistantTurn,
  onForkInFlightTurn,
}: {
  serverId: string;
  agentId: string;
  isRunning: boolean;
  inFlightTurnStartedAt: Date | null;
  host: TurnFooterHost | null;
  strategy: TurnContentStrategy;
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  if (isRunning) {
    return (
      <TurnFooterRow>
        <RunningTurnFooter
          serverId={serverId}
          agentId={agentId}
          inFlightTurnStartedAt={inFlightTurnStartedAt}
          onForkInFlightTurn={onForkInFlightTurn}
        />
      </TurnFooterRow>
    );
  }
  if (!host) {
    return null;
  }
  return (
    <CompletedTurnFooterRow
      strategy={strategy}
      items={host.items}
      timing={host.timing}
      startIndex={host.startIndex}
      supportsTimelineCursor={supportsTimelineCursor}
      onForkAssistantTurn={onForkAssistantTurn}
    />
  );
});

export const CompletedTurnFooterRow = memo(function CompletedTurnFooterRow({
  strategy,
  items,
  timing,
  startIndex,
  supportsTimelineCursor,
  onForkAssistantTurn,
}: {
  strategy: TurnContentStrategy;
  items: StreamItem[];
  timing?: TurnTiming;
  startIndex: number;
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}) {
  return (
    <TurnFooterRow>
      <CompletedTurnFooter
        strategy={strategy}
        items={items}
        timing={timing}
        startIndex={startIndex}
        supportsTimelineCursor={supportsTimelineCursor}
        onForkAssistantTurn={onForkAssistantTurn}
      />
    </TurnFooterRow>
  );
});

/**
 * The token count / stall notice beside the elapsed timer.
 *
 * A separate memo leaf for the same reason `LiveElapsed` is one: it owns a tick, and the tick
 * must not re-render the indicator around it. The cadence is 15s rather than 1s because the
 * stall label is minute-granular — a 1s tick would re-render this 60 times per visible change,
 * and the resulting worst case is a label appearing 15s late against a 120s threshold.
 */
const WorkingActivity = memo(function WorkingActivity({
  serverId,
  agentId,
  active,
  showSeparator,
}: {
  serverId: string;
  agentId: string;
  active: boolean;
  /** False when there is no elapsed timer to separate from, so the row never opens with a "·". */
  showSeparator: boolean;
}) {
  // `reactCompiler` is on (`app.config.js`), and this render reads two sources the compiler
  // cannot track: `Date.now()` and the module-scope activity map. Left memoized it caches the
  // whole derivation against `serverId`/`agentId`, which never change — so the label renders
  // once and then freezes on a dead turn, exactly the silence this component exists to report.
  "use no memo";
  const { t } = useTranslation();
  const activeTurnOutputTokens = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.activeTurnOutputTokens,
  );
  const activeTurnIdleMs = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.activeTurnIdleMs,
  );
  const activeTurnIdleReceivedAt = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.activeTurnIdleReceivedAt,
  );
  const hasPendingPermission = useSessionStore(
    (state) => (state.sessions[serverId]?.agents.get(agentId)?.pendingPermissions.length ?? 0) > 0,
  );
  const hasHydratedAgents = useSessionStore(
    (state) => state.sessions[serverId]?.hasHydratedAgents === true,
  );
  // `hasHydratedAgents` latches true on the first load and never resets, so on its own it only
  // covers cold start. The loading signal is what covers every refetch after that — it reports
  // `revalidating` while a reconnect re-fetches the directory, which is the same stale-replica
  // window under a different name.
  const isDirectoryLoading = useHostRuntimeIsDirectoryLoading(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  // COMPAT(agentTurnIdle): added in v0.3.0, remove gate after 2027-01-31 once daemon floor >= v0.3.0.
  // The one capability check for the stall half. A daemon without it does not measure idleness,
  // and the client has no sound way to measure it alone: `agent_stream` is withheld for agents
  // whose timeline is not being viewed, so an empty activity map means "not subscribed" just as
  // often as it means "silent". Everything downstream reads a plain `idleMs`.
  const supportsTurnIdle = useHostFeature(serverId, "agentTurnIdle");

  // The clock lives in state rather than as a discarded tick counter so the value the label is
  // derived from is itself reactive — same shape as `LiveElapsed`. Re-seeded on activation so a
  // panel that was inactive across a long silence does not render a stale instant for one tick.
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Stream delivery follows what is on screen, so activation is when this client starts hearing
  // from the agent — and therefore when silence becomes something it observes rather than infers.
  const [observationStartedAtMs, setObservationStartedAtMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const startedAtMs = Date.now();
    setNowMs(startedAtMs);
    setObservationStartedAtMs(startedAtMs);
    const handle = setInterval(() => setNowMs(Date.now()), WORKING_ACTIVITY_TICK_MS);
    return () => clearInterval(handle);
  }, [active, serverId, agentId]);

  // Reading a mutable map during render, deliberately. The value is monotonic and only ever
  // feeds a minute-granularity label that the tick above re-derives anyway, so no frame can
  // tear into a wrong value. `useSyncExternalStore` over the map would instead re-render this
  // leaf on every single `agent_stream` message.
  const idleMs = supportsTurnIdle
    ? resolveIdleMs({
        activeTurnIdleMs,
        activeTurnIdleReceivedAt,
        lastStreamActivityAtMs: readAgentStreamActivityAt(serverId, agentId),
        observationStartedAtMs,
        nowMs,
      })
    : undefined;

  const activity = resolveWorkingIndicatorActivity({
    idleMs,
    activeTurnOutputTokens,
    hasPendingPermission,
    isConnected,
    isDirectoryFresh: hasHydratedAgents && !isDirectoryLoading,
  });

  const { outputTokens, stalledIdleMs } = activity;
  if (outputTokens === undefined && stalledIdleMs === undefined) {
    return null;
  }
  // A separator precedes every slot that has something to its left — the elapsed timer for the
  // first one, the token count for the stall notice — so the row reads `3m 59s · 1.2k tokens ·
  // no output for 2m` and never opens or doubles up on a "·".
  return (
    <>
      {outputTokens !== undefined ? (
        <>
          {showSeparator ? <WorkingSeparator /> : null}
          <Text style={stylesheet.workingElapsed} testID="turn-working-tokens">
            {t("agentStream.working.tokens", { tokens: formatTokenCount(outputTokens) })}
          </Text>
        </>
      ) : null}
      {stalledIdleMs !== undefined ? (
        <>
          {showSeparator || outputTokens !== undefined ? <WorkingSeparator /> : null}
          <Text style={stylesheet.workingElapsed} testID="turn-working-stalled">
            {t("agentStream.working.noOutput", { duration: formatStallDuration(stalledIdleMs) })}
          </Text>
        </>
      ) : null}
    </>
  );
});

function WorkingSeparator() {
  return <Text style={stylesheet.workingSeparator}>·</Text>;
}

const WorkingIndicator = memo(function WorkingIndicator({
  serverId,
  agentId,
  inFlightTurnStartedAt = null,
  onForkInFlightTurn,
}: {
  serverId: string;
  agentId: string;
  inFlightTurnStartedAt?: Date | null;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  const active = useRetainedPanelActive();
  return (
    <View style={stylesheet.turnFooterContent}>
      <View style={stylesheet.workingLoader}>
        <ThemedSyncedLoader size={14} uniProps={workingIndicatorColorMapping} />
      </View>
      {/* Match the completed-turn footer: actions precede timing metadata. */}
      {onForkInFlightTurn ? <AssistantForkMenu onFork={onForkInFlightTurn} /> : null}
      {/* Metadata sits in its own row so the middot keeps the sidebar's tight rhythm (4px each
          side) rather than inheriting the outer 12px gap the loader needs. */}
      <View style={stylesheet.workingMeta}>
        {inFlightTurnStartedAt ? (
          <LiveElapsed
            startedAt={inFlightTurnStartedAt}
            active={active}
            style={stylesheet.workingElapsed}
            testID="turn-working-elapsed"
          />
        ) : null}
        <WorkingActivity
          serverId={serverId}
          agentId={agentId}
          active={active}
          showSeparator={inFlightTurnStartedAt !== null}
        />
      </View>
    </View>
  );
});

function RunningTurnFooter({
  serverId,
  agentId,
  inFlightTurnStartedAt,
  onForkInFlightTurn,
}: {
  serverId: string;
  agentId: string;
  inFlightTurnStartedAt: Date | null;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  return (
    <View style={stylesheet.turnFooterSlot} testID="turn-working-indicator">
      <WorkingIndicator
        serverId={serverId}
        agentId={agentId}
        inFlightTurnStartedAt={inFlightTurnStartedAt}
        onForkInFlightTurn={onForkInFlightTurn}
      />
    </View>
  );
}

function CompletedTurnFooter({
  strategy,
  items,
  timing,
  startIndex,
  supportsTimelineCursor,
  onForkAssistantTurn,
}: {
  strategy: TurnContentStrategy;
  items: StreamItem[];
  timing?: TurnTiming;
  startIndex: number;
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}) {
  const getContent = useCallback(
    () =>
      collectAssistantTurnContentForStreamRenderStrategy({
        strategy,
        items,
        startIndex,
      }),
    [strategy, items, startIndex],
  );
  const boundary = resolveAssistantTurnForkBoundary({
    items,
    startIndex,
    supportsTimelineCursor,
  });
  const handleFork = useCallback(
    (target: AssistantForkTarget) => {
      if (!boundary) {
        return;
      }
      return onForkAssistantTurn?.({ target, boundary });
    },
    [boundary, onForkAssistantTurn],
  );
  return (
    <View style={stylesheet.turnFooterSlot}>
      <AssistantTurnFooter
        getContent={getContent}
        completedAt={timing?.completedAt}
        durationMs={timing?.durationMs}
        onFork={boundary && onForkAssistantTurn ? handleFork : undefined}
      />
    </View>
  );
}

function TurnFooterRow({ children }: { children: ReactNode }) {
  const rowStyle = useMemo(() => [stylesheet.streamItemWrapper, stylesheet.turnFooterRow], []);
  return <View style={rowStyle}>{children}</View>;
}

const stylesheet = StyleSheet.create((theme) => ({
  streamItemWrapper: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
  },
  turnFooterRow: {
    marginTop: theme.spacing[4],
  },
  turnFooterSlot: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    minHeight: 24,
    paddingBottom: theme.spacing[6],
  },
  turnFooterContent: {
    height: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: theme.spacing[3],
  },
  workingMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  workingElapsed: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
    fontVariant: ["tabular-nums"],
  },
  // Mirrors the sidebar's meta separator (`agent-list.tsx`): same muted colour, knocked back
  // so the dot reads as punctuation rather than as another value.
  workingSeparator: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
    opacity: 0.7,
  },
  workingLoader: {
    marginLeft: -2,
  },
}));
