import { memo, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import type { AgentBackgroundWork } from "@getpaseo/protocol/agent-types";

/**
 * The pane's third ambient tracker: work the session left running, and schedules that will wake
 * it later.
 *
 * Claude Code reports both on its Stop hook, so the contents refresh when a turn ends — which is
 * the moment the distinction matters, because an idle pane with a pending cron is not the same
 * as a finished one.
 */
export const BackgroundWorkTrack = memo(function BackgroundWorkTrack({
  backgroundWork,
}: {
  backgroundWork: AgentBackgroundWork | undefined;
}) {
  const { t } = useTranslation();
  const tasks = backgroundWork?.tasks ?? [];
  const crons = backgroundWork?.crons ?? [];

  const segments = useMemo(() => {
    const parts: string[] = [];
    if (tasks.length > 0) {
      parts.push(t("message.backgroundWork.running", { count: tasks.length }));
    }
    if (crons.length > 0) {
      parts.push(t("message.backgroundWork.scheduled", { count: crons.length }));
    }
    return [{ bucket: null, text: parts.join(" · ") }];
  }, [crons.length, t, tasks.length]);

  if (tasks.length === 0 && crons.length === 0) {
    return null;
  }

  return (
    <ComposerTrackPill
      testID="agent-background-work-header"
      segments={segments}
      panelTitle={t("message.backgroundWork.title")}
    >
      {tasks.map((task) => (
        <ComposerTrackRow key={`task:${task.id}`}>
          <BackgroundWorkRow
            primary={task.agentType ?? task.name ?? task.type}
            secondary={task.command ?? task.description}
            trailing={task.status}
          />
        </ComposerTrackRow>
      ))}
      {crons.map((cron) => (
        <ComposerTrackRow key={`cron:${cron.id}`}>
          <BackgroundWorkRow
            primary={cron.schedule}
            secondary={cron.prompt}
            trailing={cron.recurring ? undefined : t("message.backgroundWork.once")}
          />
        </ComposerTrackRow>
      ))}
    </ComposerTrackPill>
  );
});

function BackgroundWorkRow({
  primary,
  secondary,
  trailing,
}: {
  primary: string;
  secondary?: string;
  trailing?: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.primary} numberOfLines={1}>
        {primary}
      </Text>
      {secondary ? (
        <Text style={styles.secondary} numberOfLines={1}>
          {secondary}
        </Text>
      ) : null}
      {trailing ? <Text style={styles.trailing}>{trailing}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Basis stays `auto` so the text's width reaches the panel's measurement — see tracks.tsx.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
  },
  primary: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 0,
  },
  secondary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
    minWidth: 0,
  },
  trailing: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 0,
  },
}));
