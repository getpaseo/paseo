import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { BoardSection } from "./board-section";
import { InboxSection } from "./inbox-section";
import { deriveLeitstandMood } from "./inbox-model";
import { LeitstandPanda } from "./leitstand-panda";
import { StatusGlyph } from "./status-glyph";
import {
  useLeitstandSchedules,
  useSnoozableInbox,
  type LeitstandSessionsState,
} from "./use-leitstand";

/** Home once a project exists: who runs, who needs you, then everything by status. */
export function LeitstandScreen({ state }: { state: LeitstandSessionsState }) {
  const { t } = useTranslation();
  const schedules = useLeitstandSchedules(state.sessions);
  const inbox = useSnoozableInbox(state.sessions, schedules);
  const mood = deriveLeitstandMood({
    items: inbox.items,
    runningAgentCount: state.runningAgentCount,
  });

  return (
    <View style={styles.container} testID="leitstand">
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <View style={styles.head}>
          <View style={styles.brand} testID={`leitstand-panda-${mood}`}>
            <LeitstandPanda mood={mood} size={32} />
            <Text style={styles.title} accessibilityRole="header">
              {t("leitstand.title")}
            </Text>
          </View>
          <View style={styles.metrics}>
            <View style={styles.metric} testID="leitstand-metric-running">
              <StatusGlyph name="run" />
              <Text style={styles.metricText}>
                {t("leitstand.metrics.running", { count: state.runningAgentCount })}
              </Text>
            </View>
            <View style={styles.metric} testID="leitstand-metric-needs-you">
              <StatusGlyph name="ask" />
              <Text style={styles.metricText}>
                {t("leitstand.metrics.needsYou", { count: inbox.items.length })}
              </Text>
            </View>
          </View>
        </View>
        <InboxSection inbox={inbox} />
        <BoardSection sessions={state.sessions} schedules={schedules} projects={state.projects} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flex: 1,
  },
  content: {
    width: "100%",
    maxWidth: 1440,
    alignSelf: "center",
    paddingHorizontal: { xs: theme.spacing[4], md: theme.spacing[6] },
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[12],
    gap: theme.spacing[6],
  },
  head: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  title: {
    fontFamily: theme.fontFamily.display,
    fontSize: theme.fontSize["4xl"],
    color: theme.colors.foreground,
  },
  metrics: {
    marginLeft: "auto",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[4],
  },
  metric: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  metricText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontVariant: ["tabular-nums"],
  },
}));
