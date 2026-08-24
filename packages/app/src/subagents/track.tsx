import { Fragment, useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Archive, ChevronDown, ChevronRight, Play, Square, Unlink } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { getProviderIcon } from "@/components/provider-icons";
import { ComposerTrackActions, ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useAgentQueuePrompts } from "@/agent-queue/use-agent-queue";
import { useSessionStore } from "@/stores/session-store";
import {
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import type { Theme } from "@/styles/theme";
import type { SubagentRow, SubagentTreeNode } from "./select";
import type { ArchiveFinishedStatus } from "./use-archive-finished";
import {
  buildSubagentPillPresentation,
  buildSubagentRowPresentationData,
  countFinishedSubagents,
} from "./track-presentation";

const ThemedArchive = withUnistyles(Archive);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedPlay = withUnistyles(Play);
const ThemedSquare = withUnistyles(Square);
const ThemedUnlink = withUnistyles(Unlink);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export interface SubagentsTrackProps {
  serverId: string;
  rows: SubagentRow[];
  tree?: SubagentTreeNode[];
  onOpenSubagent: (id: string) => void;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  onArchiveSubagent: (id: string) => void;
  onArchiveFinished?: () => void;
  archiveFinishedStatus?: ArchiveFinishedStatus;
  onDetachSubagent?: (id: string) => void;
  onStopSubagent?: (id: string) => void;
  onStopAllActive?: () => void;
}

const IDLE_ARCHIVE_FINISHED_STATUS: ArchiveFinishedStatus = { kind: "idle" };

function toFlatTree(rows: SubagentRow[]): SubagentTreeNode[] {
  return rows.map((row) => ({
    key: row.kind === "paseo" ? `agent:${row.id}` : `provider:${row.parentAgentId}:${row.id}`,
    row,
    depth: 0,
    children: [],
  }));
}

function isFinishedRow(row: SubagentRow): boolean {
  return row.kind === "paseo"
    ? row.status === "idle" || row.status === "closed" || row.status === "error"
    : row.status !== "running";
}

function flattenSubagentTree(
  nodes: SubagentTreeNode[],
  collapsedKeys: ReadonlySet<string>,
  expandedFinishedKeys: ReadonlySet<string>,
): Array<{ node: SubagentTreeNode; expanded: boolean }> {
  const result: Array<{ node: SubagentTreeNode; expanded: boolean }> = [];
  for (const node of nodes) {
    const isFinished = isFinishedRow(node.row) && !node.row.requiresAttention;
    const expanded =
      node.children.length > 0 &&
      !collapsedKeys.has(node.key) &&
      (!isFinished || expandedFinishedKeys.has(node.key));
    result.push({ node, expanded });
    if (expanded) {
      result.push(...flattenSubagentTree(node.children, collapsedKeys, expandedFinishedKeys));
    }
  }
  return result;
}

function collectSubagentRows(nodes: SubagentTreeNode[]): SubagentRow[] {
  return nodes.flatMap((node) => [node.row, ...collectSubagentRows(node.children)]);
}

/** Leading and action glyphs share one size so rows keep a single icon column. */
const ROW_ICON_SIZE = 14;

function buildRowPresentation(row: SubagentRow): WorkspaceTabPresentation {
  const data = buildSubagentRowPresentationData(row);
  return {
    ...data,
    tooltip: data.label,
    modified: false,
    icon: getProviderIcon(row.provider),
  };
}

export function SubagentsTrack({
  serverId,
  rows,
  tree,
  onOpenSubagent,
  onOpenProviderSubagent,
  onArchiveSubagent,
  onArchiveFinished,
  archiveFinishedStatus = IDLE_ARCHIVE_FINISHED_STATUS,
  onDetachSubagent,
  onStopSubagent,
  onStopAllActive,
}: SubagentsTrackProps): ReactElement | null {
  const { t } = useTranslation();
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());
  const [expandedFinishedKeys, setExpandedFinishedKeys] = useState<Set<string>>(new Set());
  const treeNodes = useMemo(() => tree ?? toFlatTree(rows), [rows, tree]);
  const visibleRows = useMemo(
    () => flattenSubagentTree(treeNodes, collapsedKeys, expandedFinishedKeys),
    [collapsedKeys, expandedFinishedKeys, treeNodes],
  );
  const toggleExpanded = useCallback((node: SubagentTreeNode, expanded: boolean) => {
    setCollapsedKeys((current) => {
      const next = new Set(current);
      if (expanded) next.add(node.key);
      else next.delete(node.key);
      return next;
    });
    setExpandedFinishedKeys((current) => {
      const next = new Set(current);
      if (expanded) next.delete(node.key);
      else next.add(node.key);
      return next;
    });
  }, []);

  const isArchivingFinished = archiveFinishedStatus.kind === "archiving";
  const isArchiveFinishedFailed = archiveFinishedStatus.kind === "failed";
  if (visibleRows.length === 0 && !isArchivingFinished && !isArchiveFinishedFailed) {
    return null;
  }

  const flatRows = visibleRows.map(({ node }) => node.row);
  const pill = buildSubagentPillPresentation(t, flatRows);
  const finishedCount = countFinishedSubagents(collectSubagentRows(treeNodes));
  const showArchiveFinished = finishedCount > 0 || isArchivingFinished || isArchiveFinishedFailed;

  return (
    <ComposerTrackPill
      testID="subagents-track-header"
      segments={pill.segments}
      accessibilityLabel={pill.accessibilityLabel}
      panelTitle={t("subagents.title")}
    >
      {onStopAllActive ? (
        <ComposerTrackActions divided={visibleRows.length > 0}>
          <StopAllRow onPress={onStopAllActive} />
        </ComposerTrackActions>
      ) : null}
      {showArchiveFinished && onArchiveFinished ? (
        <ComposerTrackActions divided={visibleRows.length > 0}>
          <ArchiveFinishedRow
            status={archiveFinishedStatus}
            disabled={isArchivingFinished}
            onPress={onArchiveFinished}
          />
        </ComposerTrackActions>
      ) : null}
      {visibleRows.map(({ node, expanded }) => (
        <Fragment key={node.key}>
          <SubagentsTrackRow
            row={node.row}
            node={node}
            depth={node.depth}
            hasChildren={node.children.length > 0}
            expanded={expanded}
            onToggleExpanded={toggleExpanded}
            onOpenSubagent={onOpenSubagent}
            onOpenProviderSubagent={onOpenProviderSubagent}
            onArchiveSubagent={onArchiveSubagent}
            onDetachSubagent={onDetachSubagent}
            onStopSubagent={onStopSubagent}
          />
          {node.row.kind === "paseo" ? (
            <AgentQueueRows serverId={serverId} agentId={node.row.id} depth={node.depth + 1} />
          ) : null}
        </Fragment>
      ))}
    </ComposerTrackPill>
  );
}

/**
 * Bulk archive, as a row above the list rather than an icon next to the count. The pill has no
 * header to hang an icon off, and a destructive-ish action reads better with its name attached.
 */
function ArchiveFinishedRow({
  status,
  disabled,
  onPress,
}: {
  status: ArchiveFinishedStatus;
  disabled: boolean;
  onPress: () => void;
}): ReactElement {
  const { t } = useTranslation();

  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <ThemedArchive
          size={ROW_ICON_SIZE}
          uniProps={active ? foregroundColorMapping : foregroundMutedColorMapping}
        />
        <Text style={styles.rowLabel} numberOfLines={1}>
          {t("subagents.archiveFinishedAction")}
        </Text>
        {status.kind === "archiving" ? (
          <Text style={styles.rowTrailing} testID="subagents-track-archive-progress">
            {status.completedCount}/{status.totalCount}
          </Text>
        ) : null}
        {status.kind === "failed" ? (
          <Text style={styles.rowTrailing} testID="subagents-track-archive-failed">
            {t("subagents.archiveFinishedRetry", {
              failed: status.failedCount,
              total: status.totalCount,
            })}
          </Text>
        ) : null}
      </>
    ),
    [status, t],
  );

  return (
    <ComposerTrackRow
      accessibilityLabel={t("subagents.archiveFinishedAction")}
      testID="subagents-track-archive-finished"
      disabled={disabled}
      // Progress and the retry count land on this row, so the panel is where the result of
      // pressing it shows up. Dismissing would hide the thing the press produces.
      closeOnSelect={false}
      onPress={onPress}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

function StopAllRow({ onPress }: { onPress: () => void }): ReactElement {
  const { t } = useTranslation();
  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <ThemedSquare
          size={ROW_ICON_SIZE}
          uniProps={active ? foregroundColorMapping : foregroundMutedColorMapping}
        />
        <Text style={styles.rowLabel} numberOfLines={1}>
          {t("subagents.stopAllAction")}
        </Text>
      </>
    ),
    [t],
  );
  return (
    <ComposerTrackRow accessibilityLabel={t("subagents.stopAllAction")} onPress={onPress}>
      {renderRow}
    </ComposerTrackRow>
  );
}

function AgentQueueRows({
  serverId,
  agentId,
  depth,
}: {
  serverId: string;
  agentId: string;
  depth: number;
}): ReactElement | null {
  const prompts = useAgentQueuePrompts({ serverId, agentId });
  if (prompts.length === 0) return null;
  return (
    <>
      {prompts.map((prompt) => (
        <QueuedPromptTrackRow
          key={prompt.id}
          serverId={serverId}
          agentId={agentId}
          promptId={prompt.id}
          text={prompt.text}
          depth={depth}
        />
      ))}
    </>
  );
}

function QueuedPromptTrackRow({
  serverId,
  agentId,
  promptId,
  text,
  depth,
}: {
  serverId: string;
  agentId: string;
  promptId: string;
  text: string;
  depth: number;
}): ReactElement {
  const { t } = useTranslation();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const handleSendNow = useCallback(() => {
    if (!client) return;
    void client.sendAgentQueuePromptNow(agentId, promptId).catch(() => undefined);
  }, [agentId, client, promptId]);
  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <View style={[styles.depthRail, { width: depth * 12 }]} />
        <View style={styles.disclosure} />
        <Text style={styles.queuePreview} numberOfLines={1}>
          {text}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("composer.attachments.sendQueuedMessageNow")}
          onPress={handleSendNow}
          hitSlop={6}
          style={active ? styles.queueActionActive : styles.queueAction}
        >
          <ThemedPlay size={ROW_ICON_SIZE} uniProps={foregroundMutedColorMapping} />
        </Pressable>
      </>
    ),
    [depth, handleSendNow, t, text],
  );
  return (
    <ComposerTrackRow
      accessibilityLabel={text}
      testID={`subagents-track-queued-${promptId}`}
      onPress={handleSendNow}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

interface SubagentsTrackRowProps {
  row: SubagentRow;
  node: SubagentTreeNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  onToggleExpanded: (node: SubagentTreeNode, expanded: boolean) => void;
  onOpenSubagent: (id: string) => void;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  onArchiveSubagent: (id: string) => void;
  onDetachSubagent?: (id: string) => void;
  onStopSubagent?: (id: string) => void;
}

function SubagentsTrackRow({
  row,
  node,
  depth,
  hasChildren,
  expanded,
  onToggleExpanded,
  onOpenSubagent,
  onOpenProviderSubagent,
  onArchiveSubagent,
  onDetachSubagent,
  onStopSubagent,
}: SubagentsTrackRowProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const presentation = useMemo(() => buildRowPresentation(row), [row]);
  const displayLabel =
    presentation.titleState === "loading" ? t("common.states.loading") : presentation.label;
  const handlePress = useCallback(() => {
    if (row.kind === "provider") {
      onOpenProviderSubagent(row.parentAgentId, row.id);
    } else {
      onOpenSubagent(row.id);
    }
  }, [onOpenProviderSubagent, onOpenSubagent, row]);
  const handleArchivePress = useCallback(() => {
    onArchiveSubagent(row.id);
  }, [onArchiveSubagent, row.id]);
  const handleDetachPress = useCallback(() => {
    onDetachSubagent?.(row.id);
  }, [onDetachSubagent, row.id]);
  const handleStopPress = useCallback(() => {
    onStopSubagent?.(row.id);
  }, [onStopSubagent, row.id]);
  const handleToggleExpanded = useCallback(
    () => onToggleExpanded(node, expanded),
    [expanded, node, onToggleExpanded],
  );
  const actionsAlwaysVisible = isNative || isCompact;

  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <View style={[styles.depthRail, { width: depth * 12 }]} />
        {hasChildren ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${displayLabel}`}
            testID={`subagents-track-disclosure-${row.id}`}
            onPress={handleToggleExpanded}
            hitSlop={6}
            style={styles.disclosure}
          >
            {expanded ? (
              <ThemedChevronDown size={ROW_ICON_SIZE} uniProps={foregroundMutedColorMapping} />
            ) : (
              <ThemedChevronRight size={ROW_ICON_SIZE} uniProps={foregroundMutedColorMapping} />
            )}
          </Pressable>
        ) : (
          <View style={styles.disclosure} />
        )}
        <WorkspaceTabIcon presentation={presentation} backdrop={active ? "surface2" : "surface1"} />
        <Text style={styles.rowLabel} numberOfLines={1}>
          {displayLabel}
        </Text>
        {presentation.subtitle ? (
          <Text style={styles.rowTrailing} numberOfLines={1}>
            {presentation.subtitle}
          </Text>
        ) : null}
        {row.kind === "paseo" ? (
          <SubagentRowActions
            rowId={row.id}
            displayLabel={displayLabel}
            visible={actionsAlwaysVisible || active}
            onDetachPress={onDetachSubagent ? handleDetachPress : undefined}
            onStopPress={row.status === "running" ? handleStopPress : undefined}
            onArchivePress={handleArchivePress}
          />
        ) : null}
      </>
    ),
    [
      actionsAlwaysVisible,
      displayLabel,
      depth,
      expanded,
      handleArchivePress,
      handleDetachPress,
      hasChildren,
      onDetachSubagent,
      handleStopPress,
      handleToggleExpanded,
      presentation,
      row.kind,
      row.id,
      row.status,
    ],
  );

  return (
    <ComposerTrackRow
      accessibilityLabel={displayLabel}
      testID={`subagents-track-row-${row.id}`}
      onPress={handlePress}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

function SubagentRowActions({
  rowId,
  displayLabel,
  visible,
  onDetachPress,
  onArchivePress,
  onStopPress,
}: {
  rowId: string;
  displayLabel: string;
  visible: boolean;
  onDetachPress?: () => void;
  onArchivePress: () => void;
  onStopPress?: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View
      style={visible ? styles.actionClusterVisible : styles.actionClusterHidden}
      pointerEvents={visible ? "auto" : "none"}
    >
      {onDetachPress ? (
        <SubagentActionButton
          accessibilityLabel={t("subagents.detachAction", { label: displayLabel })}
          testID={`subagents-track-detach-${rowId}`}
          tooltipLabel={t("subagents.detachTooltip")}
          icon="detach"
          visible={visible}
          onPress={onDetachPress}
        />
      ) : null}
      {onStopPress ? (
        <SubagentActionButton
          accessibilityLabel={t("subagents.stopAction", { label: displayLabel })}
          testID={`subagents-track-stop-${rowId}`}
          tooltipLabel={t("subagents.stopAction", { label: displayLabel })}
          icon="stop"
          visible={visible}
          onPress={onStopPress}
        />
      ) : null}
      <SubagentActionButton
        accessibilityLabel={t("subagents.archiveAction", { label: displayLabel })}
        testID={`subagents-track-archive-${rowId}`}
        tooltipLabel={t("subagents.archiveTooltip")}
        icon="archive"
        visible={visible}
        onPress={onArchivePress}
      />
    </View>
  );
}

type SubagentActionIcon = "archive" | "detach" | "stop";

function renderSubagentActionIcon(icon: SubagentActionIcon, isActive: boolean): ReactElement {
  const uniProps = isActive ? foregroundColorMapping : foregroundMutedColorMapping;
  if (icon === "detach") {
    return <ThemedUnlink size={ROW_ICON_SIZE} uniProps={uniProps} />;
  }
  if (icon === "stop") {
    return <ThemedSquare size={ROW_ICON_SIZE} uniProps={uniProps} />;
  }
  return <ThemedArchive size={ROW_ICON_SIZE} uniProps={uniProps} />;
}

function SubagentActionButton({
  accessibilityLabel,
  testID,
  tooltipLabel,
  icon,
  visible,
  onPress,
}: {
  accessibilityLabel: string;
  testID: string;
  tooltipLabel: string;
  icon: SubagentActionIcon;
  visible: boolean;
  onPress: () => void;
}): ReactElement {
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild disabled={!visible}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={testID}
          onPress={onPress}
          style={styles.actionButton}
          hitSlop={8}
        >
          {({ hovered, pressed }) => renderSubagentActionIcon(icon, hovered || pressed)}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  depthRail: {
    flexShrink: 0,
    alignSelf: "stretch",
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    marginLeft: theme.spacing[1],
  },
  disclosure: {
    width: ROW_ICON_SIZE,
    height: ROW_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  queuePreview: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  queueAction: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  queueActionActive: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  // `flexBasis: "auto"` rather than `flex: 1`: a zero-basis label contributes nothing to the row's
  // intrinsic width, so the panel measures itself at its floor and truncates every label at once.
  rowLabel: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  // Trailing metadata — provider context on a subagent row, progress on the archive row. No width
  // cap: the panel's own ceiling bounds it. It shrinks twice as fast as the label, so a wordy
  // provider subtitle gives way first instead of squeezing the thing that names the row.
  rowTrailing: {
    flexShrink: 2,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  actionClusterVisible: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 1,
  },
  actionClusterHidden: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 0,
  },
  actionButton: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
