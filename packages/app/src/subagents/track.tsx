import { useCallback, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Archive, Unlink } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useProviderIcon } from "@/components/provider-icons";
import { ComposerTrackActions, ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import {
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import type { Theme } from "@/styles/theme";
import { useAgentFactsLine } from "@/panels/agent-facts-line";
import { getPanelManifest } from "@/panels/panel-manifest";
import type { SubagentRow } from "./select";
import type { ArchiveFinishedStatus } from "./use-archive-finished";
import {
  buildSubagentPillPresentation,
  buildSubagentRowPresentationData,
  countFinishedSubagents,
} from "./track-presentation";

const ThemedArchive = withUnistyles(Archive);
const ThemedUnlink = withUnistyles(Unlink);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export interface SubagentsTrackProps {
  serverId: string;
  rows: SubagentRow[];
  onOpenSubagent: (id: string) => void;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  /**
   * Whether opening this row shows it in a sheet. A sheet stacks over the list and uncovers it on
   * close, so the list stays open; a tab replaces the list's pane, so choosing it ends the list.
   */
  opensInSheet: (row: SubagentRow) => boolean;
  onArchiveSubagent: (id: string) => void;
  onArchiveFinished?: () => void;
  archiveFinishedStatus?: ArchiveFinishedStatus;
  onDetachSubagent?: (id: string) => void;
}

const IDLE_ARCHIVE_FINISHED_STATUS: ArchiveFinishedStatus = { kind: "idle" };

/** Leading and action glyphs share one size so rows keep a single icon column. */
const ROW_ICON_SIZE = 14;

function useRowPresentation(row: SubagentRow, serverId: string): WorkspaceTabPresentation {
  const icon = useProviderIcon(row.provider, serverId);
  const data = buildSubagentRowPresentationData(row);
  return {
    ...data,
    tooltip: data.label,
    modified: false,
    showCloseButton: getPanelManifest(data.kind).showCloseButton,
    icon,
  };
}

export function SubagentsTrack({
  serverId,
  rows,
  onOpenSubagent,
  onOpenProviderSubagent,
  opensInSheet,
  onArchiveSubagent,
  onArchiveFinished,
  archiveFinishedStatus = IDLE_ARCHIVE_FINISHED_STATUS,
  onDetachSubagent,
}: SubagentsTrackProps): ReactElement | null {
  const { t } = useTranslation();

  const isArchivingFinished = archiveFinishedStatus.kind === "archiving";
  const isArchiveFinishedFailed = archiveFinishedStatus.kind === "failed";
  if (rows.length === 0 && !isArchivingFinished && !isArchiveFinishedFailed) {
    return null;
  }

  const pill = buildSubagentPillPresentation(t, rows);
  const finishedCount = countFinishedSubagents(rows);
  const showArchiveFinished = finishedCount > 0 || isArchivingFinished || isArchiveFinishedFailed;

  return (
    <ComposerTrackPill
      testID="subagents-track-header"
      segments={pill.segments}
      accessibilityLabel={pill.accessibilityLabel}
      panelTitle={t("subagents.title")}
    >
      {showArchiveFinished && onArchiveFinished ? (
        <ComposerTrackActions divided={rows.length > 0}>
          <ArchiveFinishedRow
            status={archiveFinishedStatus}
            disabled={isArchivingFinished}
            onPress={onArchiveFinished}
          />
        </ComposerTrackActions>
      ) : null}
      {rows.map((row) => (
        <SubagentsTrackRow
          key={row.id}
          row={row}
          serverId={serverId}
          onOpenSubagent={onOpenSubagent}
          onOpenProviderSubagent={onOpenProviderSubagent}
          opensInSheet={opensInSheet(row)}
          onArchiveSubagent={onArchiveSubagent}
          onDetachSubagent={onDetachSubagent}
        />
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

interface SubagentsTrackRowProps {
  serverId: string;
  row: SubagentRow;
  onOpenSubagent: (id: string) => void;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  opensInSheet: boolean;
  onArchiveSubagent: (id: string) => void;
  onDetachSubagent?: (id: string) => void;
}

function SubagentsTrackRow({
  serverId,
  row,
  onOpenSubagent,
  onOpenProviderSubagent,
  opensInSheet,
  onArchiveSubagent,
  onDetachSubagent,
}: SubagentsTrackRowProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const presentation = useRowPresentation(row, serverId);
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
  const actionsAlwaysVisible = isNative || isCompact;

  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <WorkspaceTabIcon presentation={presentation} backdrop={active ? "surface2" : "surface1"} />
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {displayLabel}
          </Text>
          {row.kind === "paseo" ? (
            <PaseoSubagentFacts serverId={serverId} agentId={row.id} />
          ) : (
            <SubagentFacts rowId={row.id} text={presentation.subtitle} />
          )}
        </View>
        {row.kind === "paseo" ? (
          <SubagentRowActions
            rowId={row.id}
            displayLabel={displayLabel}
            visible={actionsAlwaysVisible || active}
            onDetachPress={onDetachSubagent ? handleDetachPress : undefined}
            onArchivePress={handleArchivePress}
          />
        ) : null}
      </>
    ),
    [
      actionsAlwaysVisible,
      displayLabel,
      handleArchivePress,
      handleDetachPress,
      onDetachSubagent,
      presentation,
      row.kind,
      row.id,
      serverId,
    ],
  );

  return (
    <ComposerTrackRow
      accessibilityLabel={displayLabel}
      testID={`subagents-track-row-${row.id}`}
      closeOnSelect={!opensInSheet}
      onPress={handlePress}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

/** The same facts line the agent's sheet shows when it opens without its composer. */
function PaseoSubagentFacts({ serverId, agentId }: { serverId: string; agentId: string }) {
  const text = useAgentFactsLine(serverId, agentId);
  return <SubagentFacts rowId={agentId} text={text} />;
}

function SubagentFacts({ rowId, text }: { rowId: string; text: string | null }) {
  if (!text) return null;
  return (
    <Text style={styles.rowFacts} numberOfLines={1} testID={`subagents-track-row-facts-${rowId}`}>
      {text}
    </Text>
  );
}

function SubagentRowActions({
  rowId,
  displayLabel,
  visible,
  onDetachPress,
  onArchivePress,
}: {
  rowId: string;
  displayLabel: string;
  visible: boolean;
  onDetachPress?: () => void;
  onArchivePress: () => void;
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

type SubagentActionIcon = "archive" | "detach";

function renderSubagentActionIcon(icon: SubagentActionIcon, isActive: boolean): ReactElement {
  const uniProps = isActive ? foregroundColorMapping : foregroundMutedColorMapping;
  if (icon === "detach") {
    return <ThemedUnlink size={ROW_ICON_SIZE} uniProps={uniProps} />;
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
  // Title over facts. The facts sit under the title rather than beside it, so a long task name
  // keeps the row's full width and neither line truncates the other.
  rowText: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
  },
  rowTitle: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  rowFacts: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  // Progress on the archive row. It shrinks twice as fast as the label, so a long retry count
  // gives way first instead of squeezing the thing that names the row.
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
