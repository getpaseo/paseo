import React, { memo, useCallback, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { SPACING } from "@/styles/theme";
import type { TurnTiming } from "@/timeline/turn-time";
import type { StreamItem } from "@/types/stream";
import {
  collectAssistantResponseContentForStreamRenderStrategy,
  type StreamStrategy,
} from "./strategy";
import {
  resolveAssistantTurnForkBoundary,
  resolveTurnFooterForkHandler,
  type AssistantTurnForkHandler,
  type InFlightTurnForkHandler,
} from "./turn-boundary";
export type { AssistantTurnForkHandler, InFlightTurnForkHandler } from "./turn-boundary";
import {
  AssistantTurnFooter,
  LiveElapsed,
  STREAM_METADATA_FONT_SIZE,
  type AssistantForkTarget,
} from "@/components/message";
import type { TurnFooterHost } from "./layout";
import { AssistantForkMenu } from "@/components/assistant-fork-menu";
import { MenuTrigger, type MenuTriggerState } from "@/components/ui/menu";
import { ChevronDown, ChevronUp } from "@/components/icons/ui-icons";
import { PandaStatus } from "@/components/panda-status";
import { useRetainedPanelActive } from "@/components/retained-panel";

export const TURN_FOOTER_BOTTOM_SPACING = SPACING[8];

export type TurnContentStrategy = StreamStrategy;
export const TurnFooter = memo(function TurnFooter({
  isRunning,
  workingLabel,
  subagentsControl,
  needsInput = false,
  hasError = false,
  isWaiting = false,
  inFlightTurnStartedAt,
  host,
  strategy,
  supportsTimelineCursor,
  onForkAssistantTurn,
  onForkInFlightTurn,
}: {
  isRunning: boolean;
  workingLabel?: string;
  subagentsControl?: ReactNode;
  needsInput?: boolean;
  hasError?: boolean;
  isWaiting?: boolean;
  inFlightTurnStartedAt: Date | null;
  host: TurnFooterHost | null;
  strategy: TurnContentStrategy;
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  if (isRunning || needsInput || hasError) {
    return (
      <TurnFooterRow>
        <RunningTurnFooter
          workingLabel={workingLabel}
          subagentsControl={subagentsControl}
          needsInput={needsInput}
          hasError={hasError}
          isWaiting={isWaiting}
          inFlightTurnStartedAt={inFlightTurnStartedAt}
          onFork={resolveTurnFooterForkHandler({
            hasError,
            host,
            supportsTimelineCursor,
            onForkAssistantTurn,
            onForkInFlightTurn,
          })}
        />
      </TurnFooterRow>
    );
  }
  if (!host) {
    return null;
  }
  return (
    <CompletedTurnFooterRow
      showStatus
      subagentsControl={subagentsControl}
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
  showStatus = false,
  subagentsControl,
  strategy,
  items,
  timing,
  startIndex,
  supportsTimelineCursor,
  onForkAssistantTurn,
}: {
  showStatus?: boolean;
  subagentsControl?: ReactNode;
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
        showStatus={showStatus}
        subagentsControl={subagentsControl}
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

const WorkingIndicator = memo(function WorkingIndicator({
  workingLabel,
  subagentsControl,
  needsInput,
  hasError,
  isWaiting = false,
  inFlightTurnStartedAt = null,
  onFork,
}: {
  workingLabel?: string;
  subagentsControl?: ReactNode;
  needsInput: boolean;
  hasError: boolean;
  isWaiting?: boolean;
  inFlightTurnStartedAt?: Date | null;
  onFork?: InFlightTurnForkHandler;
}) {
  const active = useRetainedPanelActive();
  const restingMood = isWaiting ? "sleep" : "run";
  const activityMood = hasError ? "err" : restingMood;
  return (
    <View style={stylesheet.turnFooterContent}>
      <View style={stylesheet.activityStatus}>
        <View style={stylesheet.workingLoader}>
          <PandaStatus
            mood={needsInput ? "ask" : activityMood}
            size="small"
            pixelScale={2}
            testID="turn-status-panda"
            animate={active && !isWaiting}
          />
        </View>
        {workingLabel ? (
          <Text
            style={stylesheet.workingLabel}
            numberOfLines={1}
            accessibilityLiveRegion="polite"
            testID="turn-working-label"
          >
            {workingLabel}
          </Text>
        ) : null}
      </View>
      {subagentsControl}
      {onFork ? <AssistantForkMenu onFork={onFork} /> : null}
      {inFlightTurnStartedAt ? (
        <LiveElapsed
          startedAt={inFlightTurnStartedAt}
          active={active}
          style={stylesheet.workingElapsed}
          testID="turn-working-elapsed"
        />
      ) : null}
    </View>
  );
});

function RunningTurnFooter({
  workingLabel,
  subagentsControl,
  needsInput,
  hasError,
  isWaiting = false,
  inFlightTurnStartedAt,
  onFork,
}: {
  workingLabel?: string;
  subagentsControl?: ReactNode;
  needsInput: boolean;
  hasError: boolean;
  isWaiting?: boolean;
  inFlightTurnStartedAt: Date | null;
  onFork?: InFlightTurnForkHandler;
}) {
  return (
    <View style={stylesheet.turnFooterSlot} testID="turn-working-indicator">
      <WorkingIndicator
        workingLabel={workingLabel}
        subagentsControl={subagentsControl}
        needsInput={needsInput}
        hasError={hasError}
        isWaiting={isWaiting}
        inFlightTurnStartedAt={inFlightTurnStartedAt}
        onFork={onFork}
      />
    </View>
  );
}

export function WorkingSubagentsTrigger({ label }: { label: string }) {
  const triggerStyle = useCallback(
    ({ hovered, pressed, open }: MenuTriggerState) => [
      stylesheet.subagentsTrigger,
      (hovered || pressed || open) && stylesheet.subagentsTriggerActive,
    ],
    [],
  );
  return (
    <MenuTrigger
      testID="turn-subagents-trigger"
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={triggerStyle}
    >
      {({ open }) => {
        const Chevron = open ? ChevronUp : ChevronDown;
        return (
          <>
            <Text style={stylesheet.workingLabel} numberOfLines={1}>
              {label}
            </Text>
            <Chevron size={12} color={stylesheet.workingLabel.color} />
          </>
        );
      }}
    </MenuTrigger>
  );
}

function CompletedTurnFooter({
  showStatus,
  subagentsControl,
  strategy,
  items,
  timing,
  startIndex,
  supportsTimelineCursor,
  onForkAssistantTurn,
}: {
  showStatus: boolean;
  subagentsControl?: ReactNode;
  strategy: TurnContentStrategy;
  items: StreamItem[];
  timing?: TurnTiming;
  startIndex: number;
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}) {
  const { t } = useTranslation();
  const getContent = useCallback(
    () =>
      collectAssistantResponseContentForStreamRenderStrategy({
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
    <View style={[stylesheet.turnFooterSlot, stylesheet.completedFooterContent]}>
      {showStatus ? (
        <View style={stylesheet.completedStatus} testID="turn-completed-status">
          <PandaStatus
            mood="sleep"
            accessibilityLabel={t("agentStream.turnFinished")}
            size="small"
            pixelScale={2}
            animate={false}
            testID="turn-status-panda"
          />
          <Text style={stylesheet.workingLabel}>{t("agentStream.turnFinished")}</Text>
        </View>
      ) : null}
      <AssistantTurnFooter
        getContent={getContent}
        completedAt={timing?.completedAt}
        durationMs={timing?.durationMs}
        onFork={boundary && onForkAssistantTurn ? handleFork : undefined}
      />
      {subagentsControl}
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
    marginTop: theme.spacing[2] + 5,
  },
  turnFooterSlot: {
    maxWidth: "100%",
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    minHeight: 24,
    paddingBottom: TURN_FOOTER_BOTTOM_SPACING,
  },
  activityStatus: {
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  turnFooterContent: {
    maxWidth: "100%",
    minHeight: 32,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: theme.spacing[2],
  },
  completedFooterContent: { flexWrap: "wrap", gap: theme.spacing[2] },
  completedStatus: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  subagentsTrigger: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    minWidth: 0,
    gap: theme.spacing[1],
    minHeight: 24,
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  subagentsTriggerActive: { backgroundColor: theme.colors.surface2 },
  workingElapsed: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
    fontVariant: ["tabular-nums"],
  },
  workingLabel: {
    color: theme.colors.foreground,
    fontSize: STREAM_METADATA_FONT_SIZE,
    flexShrink: 1,
  },
  workingLoader: {
    marginLeft: -2,
  },
}));
