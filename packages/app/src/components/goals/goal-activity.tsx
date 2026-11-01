import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { Goal, GoalEvent } from "@getpaseo/protocol/goal/types";
import { SettingsCard, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { goalEventSubject } from "@/goals/goal-derivation";
import { buildGoalEventFeed, type GoalFeedEntry } from "@/goals/goal-event-feed";
import { reasonPreview } from "@/goals/goal-recovery";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import { settingsStyles } from "@/styles/settings";

const COLLAPSED_ENTRIES = 15;

/** The goal's history as sentences, with a toggle to the raw events behind them. */
export function GoalActivity({ goal, events }: { goal: Goal; events: GoalEvent[] }): ReactElement {
  const { t } = useTranslation();
  const [showRaw, setShowRaw] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const feed = useMemo(() => buildGoalEventFeed(events, goal), [events, goal]);
  const rawNewestFirst = useMemo(() => events.toReversed(), [events]);
  const toggleRaw = useCallback(() => setShowRaw((value) => !value), []);
  const expand = useCallback(() => setShowAll(true), []);
  const total = showRaw ? rawNewestFirst.length : feed.length;
  const limit = showAll ? total : COLLAPSED_ENTRIES;

  const trailing = useMemo(
    () => (
      <Button variant="ghost" size="xs" onPress={toggleRaw} testID="goal-activity-raw-toggle">
        {showRaw ? t("goals.detail.hideRaw") : t("goals.detail.showRaw")}
      </Button>
    ),
    [showRaw, t, toggleRaw],
  );

  let rows: ReactElement[];
  if (total === 0) {
    rows = [
      <View key="empty" style={settingsStyles.row}>
        <Text style={styles.muted}>{t("goals.detail.noEvents")}</Text>
      </View>,
    ];
  } else if (showRaw) {
    rows = rawNewestFirst
      .slice(0, limit)
      .map((event) => <RawEventRow key={event.id} event={event} />);
  } else {
    rows = feed.slice(0, limit).map((entry) => <FeedRow key={entry.id} entry={entry} />);
  }

  return (
    <SettingsSection title={t("goals.detail.history")} trailing={trailing}>
      <SettingsCard testID="goal-activity">{rows}</SettingsCard>
      {total > limit ? (
        <View style={styles.more}>
          <Button variant="ghost" size="sm" onPress={expand} testID="goal-activity-show-all">
            {t("goals.detail.showAllActivity")}
          </Button>
        </View>
      ) : null}
    </SettingsSection>
  );
}

/**
 * One sentence, and its detail cut to its first sentence. A detail with more to it, such as a
 * Lead's reason or a failure, opens in place when you tap the row. The text is not selectable
 * there, so a tap always reaches the row.
 */
function FeedRow({ entry }: { entry: GoalFeedEntry }): ReactElement {
  const { t } = useTranslation();
  const time = useCompactTimeAgo(useMemo(() => new Date(entry.at), [entry.at]));
  const sentence = t(`goals.events.${entry.key}`, {
    subject: entry.subjects.join(", "),
    ...(entry.round !== null ? { round: entry.round } : {}),
  });
  const preview = useMemo(
    () => (entry.detail ? reasonPreview(entry.detail) : null),
    [entry.detail],
  );
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const expandedState = useMemo(() => ({ expanded }), [expanded]);
  const content = (
    <>
      <View style={settingsStyles.rowContent}>
        <Text style={[settingsStyles.rowTitle, toneStyle(entry.tone)]}>
          {sentence}
          {entry.count > 1 ? (
            <Text style={styles.muted}> {t("goals.events.repeated", { n: entry.count })}</Text>
          ) : null}
        </Text>
        {preview ? (
          <Text
            style={settingsStyles.rowHint}
            numberOfLines={preview.canExpand && !expanded ? 2 : undefined}
          >
            {expanded ? preview.full : preview.summary}
          </Text>
        ) : null}
      </View>
      <Text style={styles.muted}>{time}</Text>
    </>
  );
  if (!preview?.canExpand) {
    return <View style={settingsStyles.row}>{content}</View>;
  }
  return (
    <PressHighlight
      style={feedRowStyle}
      onPress={toggle}
      accessibilityRole="button"
      accessibilityState={expandedState}
      accessibilityHint={t("goals.events.expandHint")}
      testID={`goal-activity-entry-${entry.id}`}
    >
      {content}
    </PressHighlight>
  );
}

function feedRowStyle({ pressed }: PressableStateCallbackType) {
  return [settingsStyles.row, pressed && styles.rowPressed];
}

function toneStyle(tone: GoalFeedEntry["tone"]) {
  if (tone === "error") {
    return styles.toneError;
  }
  if (tone === "warning") {
    return styles.toneWarning;
  }
  return null;
}

function RawEventRow({ event }: { event: GoalEvent }): ReactElement {
  const subject = goalEventSubject(event);
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={styles.code}>{event.type}</Text>
        {subject ? (
          <Text style={settingsStyles.rowHint} numberOfLines={4}>
            {subject}
          </Text>
        ) : null}
      </View>
      <Text style={styles.muted}>{new Date(event.at).toLocaleString()}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  code: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  toneError: {
    color: theme.colors.statusDanger,
  },
  toneWarning: {
    color: theme.colors.statusWarning,
  },
  more: {
    alignItems: "flex-start",
    marginTop: theme.spacing[2],
  },
}));
