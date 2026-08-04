import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Archive, Unlink } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { getProviderIcon } from "@/components/provider-icons";
import {
  ComposerTrackActionButton,
  ComposerTrackRow,
  ComposerTrackSection,
} from "@/composer/tracks";
import {
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import type { Theme } from "@/styles/theme";
import type { SubagentRow } from "./select";
import {
  buildSubagentRowPresentationData,
  countFinishedSubagents,
  formatHeaderLabel,
} from "./track-presentation";

const ThemedArchive = withUnistyles(Archive);
const ThemedUnlink = withUnistyles(Unlink);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const ACTION_ICON_SIZE = 14;

function renderArchiveIcon(isActive: boolean): ReactElement {
  return (
    <ThemedArchive
      size={ACTION_ICON_SIZE}
      uniProps={isActive ? foregroundColorMapping : foregroundMutedColorMapping}
    />
  );
}

function renderDetachIcon(isActive: boolean): ReactElement {
  return (
    <ThemedUnlink
      size={ACTION_ICON_SIZE}
      uniProps={isActive ? foregroundColorMapping : foregroundMutedColorMapping}
    />
  );
}

export interface SubagentsTrackProps {
  /** Non-empty. The composer decides which tracks exist; a track always has rows. */
  rows: SubagentRow[];
  onOpenSubagent: (id: string) => void;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  onArchiveSubagent: (id: string) => void;
  onArchiveFinished?: () => void;
  onDetachSubagent?: (id: string) => void;
}

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
  rows,
  onOpenSubagent,
  onOpenProviderSubagent,
  onArchiveSubagent,
  onArchiveFinished,
  onDetachSubagent,
}: SubagentsTrackProps): ReactElement {
  const { t } = useTranslation();
  const canArchiveFinished = countFinishedSubagents(rows) > 0 && onArchiveFinished !== undefined;

  const renderHeaderAction = useCallback(() => {
    if (!onArchiveFinished) {
      return null;
    }
    return (
      <ComposerTrackActionButton
        accessibilityLabel={t("subagents.archiveFinishedAction")}
        testID="subagents-track-archive-finished"
        tooltipLabel={t("subagents.archiveFinishedTooltip")}
        renderIcon={renderArchiveIcon}
        onPress={onArchiveFinished}
      />
    );
  }, [onArchiveFinished, t]);

  return (
    <ComposerTrackSection
      label={formatHeaderLabel(rows)}
      testID="subagents-track"
      headerTestID="subagents-track-header"
      renderHeaderAction={canArchiveFinished ? renderHeaderAction : undefined}
    >
      {rows.map((row) => (
        <SubagentsTrackRow
          key={row.id}
          row={row}
          onOpenSubagent={onOpenSubagent}
          onOpenProviderSubagent={onOpenProviderSubagent}
          onArchiveSubagent={onArchiveSubagent}
          onDetachSubagent={onDetachSubagent}
        />
      ))}
    </ComposerTrackSection>
  );
}

interface SubagentsTrackRowProps {
  row: SubagentRow;
  onOpenSubagent: (id: string) => void;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  onArchiveSubagent: (id: string) => void;
  onDetachSubagent?: (id: string) => void;
}

function SubagentsTrackRow({
  row,
  onOpenSubagent,
  onOpenProviderSubagent,
  onArchiveSubagent,
  onDetachSubagent,
}: SubagentsTrackRowProps): ReactElement {
  const { t } = useTranslation();
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

  const renderLeading = useCallback(
    () => <WorkspaceTabIcon presentation={presentation} />,
    [presentation],
  );

  const renderActions = useCallback(
    () => (
      <>
        {onDetachSubagent ? (
          <ComposerTrackActionButton
            accessibilityLabel={t("subagents.detachAction", { label: displayLabel })}
            testID={`subagents-track-detach-${row.id}`}
            tooltipLabel={t("subagents.detachTooltip")}
            renderIcon={renderDetachIcon}
            onPress={handleDetachPress}
          />
        ) : null}
        <ComposerTrackActionButton
          accessibilityLabel={t("subagents.archiveAction", { label: displayLabel })}
          testID={`subagents-track-archive-${row.id}`}
          tooltipLabel={t("subagents.archiveTooltip")}
          renderIcon={renderArchiveIcon}
          onPress={handleArchivePress}
        />
      </>
    ),
    [displayLabel, handleArchivePress, handleDetachPress, onDetachSubagent, row.id, t],
  );

  return (
    <ComposerTrackRow
      accessibilityRole="button"
      accessibilityLabel={displayLabel}
      testID={`subagents-track-row-${row.id}`}
      onPress={handlePress}
      renderLeading={renderLeading}
      label={displayLabel}
      secondary={presentation.subtitle}
      actions={row.kind === "paseo" ? renderActions : undefined}
    />
  );
}
