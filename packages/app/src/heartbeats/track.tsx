import { useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { HeartPulse, Trash2 } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import {
  ComposerTrackActionButton,
  ComposerTrackRow,
  ComposerTrackSection,
} from "@/composer/tracks";
import type { Theme } from "@/styles/theme";
import type { AgentHeartbeatRow, AgentHeartbeatsTrack } from "./select";

const ThemedHeartPulse = withUnistyles(HeartPulse);
const ThemedTrash2 = withUnistyles(Trash2);

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const ROW_ICON_SIZE = 14;
const ACTION_ICON_SIZE = 14;

// The delete glyph only turns destructive once the pointer is on it: red is a
// color the user has aimed at, never a color the row wears at rest.
function renderDeleteIcon(isActive: boolean): ReactElement {
  return (
    <ThemedTrash2
      size={ACTION_ICON_SIZE}
      uniProps={isActive ? destructiveColorMapping : foregroundMutedColorMapping}
    />
  );
}

function renderHeartbeatIcon(): ReactElement {
  return <ThemedHeartPulse size={ROW_ICON_SIZE} uniProps={foregroundMutedColorMapping} />;
}

export interface HeartbeatsTrackProps {
  /** Never `none`. The composer decides which tracks exist; a track always has content. */
  track: Exclude<AgentHeartbeatsTrack, { kind: "none" }>;
  onOpenHeartbeat: (row: AgentHeartbeatRow) => void;
  onDeleteHeartbeat: (row: AgentHeartbeatRow) => void;
  onUpdateHost: () => void;
}

/**
 * The heartbeats babysitting this agent — or, on a host that does not report
 * their activity, the one row that says so.
 */
export function HeartbeatsTrack({
  track,
  onOpenHeartbeat,
  onDeleteHeartbeat,
  onUpdateHost,
}: HeartbeatsTrackProps): ReactElement {
  if (track.kind === "host-update-required") {
    return <HeartbeatsHostUpdateRow onUpdateHost={onUpdateHost} />;
  }

  return (
    <HeartbeatsTrackSection
      rows={track.rows}
      onOpenHeartbeat={onOpenHeartbeat}
      onDeleteHeartbeat={onDeleteHeartbeat}
    />
  );
}

/**
 * Each row names the heartbeat and how often it fires; opening one goes to it
 * on Schedules, deleting one stops it.
 */
function HeartbeatsTrackSection({
  rows,
  onOpenHeartbeat,
  onDeleteHeartbeat,
}: {
  rows: AgentHeartbeatRow[];
  onOpenHeartbeat: (row: AgentHeartbeatRow) => void;
  onDeleteHeartbeat: (row: AgentHeartbeatRow) => void;
}): ReactElement {
  const { t } = useTranslation();
  const label =
    rows.length === 1
      ? t("heartbeats.trackLabel", { count: rows.length })
      : t("heartbeats.trackLabelPlural", { count: rows.length });

  return (
    <ComposerTrackSection
      label={label}
      testID="heartbeats-track"
      headerTestID="heartbeats-track-header"
    >
      {rows.map((row) => (
        <HeartbeatsTrackRow
          key={row.key}
          row={row}
          onOpenHeartbeat={onOpenHeartbeat}
          onDeleteHeartbeat={onDeleteHeartbeat}
        />
      ))}
    </ComposerTrackSection>
  );
}

function HeartbeatsTrackRow({
  row,
  onOpenHeartbeat,
  onDeleteHeartbeat,
}: {
  row: AgentHeartbeatRow;
  onOpenHeartbeat: (row: AgentHeartbeatRow) => void;
  onDeleteHeartbeat: (row: AgentHeartbeatRow) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onOpenHeartbeat(row), [onOpenHeartbeat, row]);
  const handleDeletePress = useCallback(() => onDeleteHeartbeat(row), [onDeleteHeartbeat, row]);

  const renderActions = useCallback(
    () => (
      <ComposerTrackActionButton
        accessibilityLabel={t("heartbeats.deleteAction", { title: row.title })}
        testID={`heartbeats-track-delete-${row.key}`}
        tooltipLabel={t("heartbeats.deleteTooltip")}
        renderIcon={renderDeleteIcon}
        onPress={handleDeletePress}
      />
    ),
    [handleDeletePress, row.title, row.key, t],
  );

  return (
    <ComposerTrackRow
      // A heartbeat row leaves the agent for Schedules, so it is a link — which
      // also keeps its accessible name out of the delete button's namespace.
      accessibilityRole="link"
      accessibilityLabel={t("heartbeats.openAction", { title: row.title, cadence: row.cadence })}
      testID={`heartbeats-track-row-${row.key}`}
      onPress={handlePress}
      renderLeading={renderHeartbeatIcon}
      label={row.title}
      secondary={row.cadence}
      actions={renderActions}
    />
  );
}

/**
 * Heartbeats are running on this agent, but the host does not report their runs
 * as workspace activity. Listing them here would show rows that never move
 * while the prompts fire, so the lane points at the update that makes the
 * activity visible instead. The heartbeats themselves stay on Schedules.
 */
function HeartbeatsHostUpdateRow({ onUpdateHost }: { onUpdateHost: () => void }): ReactElement {
  const { t } = useTranslation();

  return (
    <ComposerTrackRow
      accessibilityRole="link"
      accessibilityLabel={t("heartbeats.hostUpdate.label")}
      testID="heartbeats-track-host-update"
      onPress={onUpdateHost}
      renderLeading={renderHeartbeatIcon}
      label={t("heartbeats.hostUpdate.label")}
    />
  );
}
