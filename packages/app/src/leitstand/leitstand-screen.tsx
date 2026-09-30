import type { ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { router } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import { ArrowLeft } from "@/components/icons/ui-icons";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { PandaStatus } from "@/components/panda-status";
import { useAttachedPullRequestRefresh } from "@/git/use-attached-pull-request-refresh";
import { navigateToLastWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { BoardSection } from "./board-section";
import { InboxSection } from "./inbox-section";
import { deriveLeitstandMood, type PandaMood } from "./inbox-model";
import type { LeitstandSession } from "./session-model";
import { StatusGlyph } from "./status-glyph";
import {
  useLeitstandSchedules,
  useSnoozableInbox,
  type LeitstandSessionsState,
} from "./use-leitstand";
import { MONO_FONT_DATASET } from "@/styles/font-dataset";

/** Back to the session you came from; Esc and Cmd/Ctrl+Shift+L do the same. */
export function leaveDashboard(): void {
  if (navigateToLastWorkspace()) return;
  router.replace(buildOpenProjectRoute());
}

/** The same header every screen has, so the dashboard reads as part of the app, with a way out. */
export function DashboardHeader({ mood, right }: { mood: PandaMood | null; right?: ReactNode }) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  return (
    <ScreenHeader
      left={
        <>
          <SidebarMenuToggle />
          <Button
            variant="ghost"
            size="sm"
            leftIcon={ArrowLeft}
            onPress={leaveDashboard}
            accessibilityLabel={t("leitstand.leave")}
            testID="leitstand-leave"
          >
            {isCompact ? undefined : t("leitstand.leave")}
          </Button>
          <View style={styles.divider} />
          {mood ? (
            <View testID={`leitstand-panda-${mood}`}>
              <PandaStatus mood={mood} size="small" pixelScale={1} />
            </View>
          ) : null}
          <ScreenTitle>{t("leitstand.title")}</ScreenTitle>
        </>
      }
      right={right}
    />
  );
}

/** Rereads hand-attached PRs of one session, the way opening its PR set does. */
function AttachedPullRequestRefresh({ session }: { session: LeitstandSession }) {
  useAttachedPullRequestRefresh({
    serverId: session.serverId,
    workspaceId: session.workspaceId,
    workspaceKey: session.key,
    pullRequests: session.attachedPullRequests,
  });
  return null;
}

/** Home once a project exists: who runs, who needs you, then everything by status. */
export function LeitstandScreen({ state }: { state: LeitstandSessionsState }) {
  const { t } = useTranslation();
  const schedules = useLeitstandSchedules(state.sessions);
  const inbox = useSnoozableInbox(state.sessions, schedules);
  const mood = deriveLeitstandMood({
    items: inbox.items,
    runningAgentCount: state.runningAgentCount,
  });
  const isCompact = useIsCompactFormFactor();
  const refreshable = state.sessions.filter((session) =>
    session.attachedPullRequests.some((pr) => pr.state === "open"),
  );

  const metrics = (
    <View style={styles.metrics}>
      <View style={styles.metric} testID="leitstand-metric-running">
        <StatusGlyph name="run" size={8} />
        <Text dataSet={MONO_FONT_DATASET} style={styles.metricText}>
          {t("leitstand.metrics.running", { count: state.runningAgentCount })}
        </Text>
      </View>
      <View style={styles.metric} testID="leitstand-metric-needs-you">
        <StatusGlyph name="ask" size={8} />
        <Text dataSet={MONO_FONT_DATASET} style={styles.metricText}>
          {t("leitstand.metrics.needsYou", { count: inbox.items.length })}
        </Text>
      </View>
    </View>
  );

  return (
    <View style={styles.container} testID="leitstand">
      <DashboardHeader mood={mood} right={isCompact ? null : metrics} />
      {refreshable.map((session) => (
        <AttachedPullRequestRefresh key={session.key} session={session} />
      ))}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {isCompact ? metrics : null}
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
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[12],
    gap: theme.spacing[6],
  },
  divider: {
    width: 1,
    height: theme.spacing[4],
    backgroundColor: theme.colors.border,
  },
  metrics: {
    flexDirection: "row",
    gap: { xs: theme.spacing[3], md: theme.spacing[4] },
    paddingRight: theme.spacing[1],
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
