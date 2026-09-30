import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildSchedulesRoute } from "@/utils/host-routes";
import { formatCadence, formatNextRun, resolveScheduleTitle } from "@/utils/schedule-format";
import {
  arrangeBoardColumns,
  buildLeitstandBoard,
  summarizeStack,
  type BoardColumnId,
  type LeitstandBoardEntry,
  type LeitstandAgent,
  type LeitstandSchedule,
  type LeitstandSession,
} from "./session-model";
import { StatusGlyph, glyphForBucket } from "./status-glyph";
import { AgeText, JiraTags, ProjectTag, StackBar } from "./tags";
import type { LeitstandProject } from "./use-leitstand";
import { DISPLAY_FONT_DATASET, MONO_FONT_DATASET } from "@/styles/font-dataset";

const COLUMN_LABEL_KEY = {
  running: "leitstand.board.running",
  planned: "leitstand.board.planned",
  done: "leitstand.board.done",
} as const satisfies Record<BoardColumnId, string>;

const COLUMN_EMPTY_KEY = {
  running: "leitstand.board.emptyRunning",
  planned: "leitstand.board.emptyPlanned",
  done: "leitstand.board.emptyDone",
} as const satisfies Record<BoardColumnId, string>;

const COLUMNS: readonly BoardColumnId[] = ["running", "planned", "done"];

export function BoardSection({
  sessions,
  schedules,
  projects,
}: {
  sessions: readonly LeitstandSession[];
  schedules: readonly LeitstandSchedule[];
  projects: readonly LeitstandProject[];
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [projectViewKey, setProjectViewKey] = useState<string | null>(null);
  const [compactColumn, setCompactColumn] = useState<BoardColumnId>("running");
  const selectedProject = projects.some((project) => project.viewKey === projectViewKey)
    ? projectViewKey
    : null;
  const board = useMemo(
    () => buildLeitstandBoard({ sessions, schedules, projectViewKey: selectedProject }),
    [schedules, selectedProject, sessions],
  );
  const columnOptions = useMemo(
    () =>
      COLUMNS.map((column) => ({
        value: column,
        label: `${t(COLUMN_LABEL_KEY[column])} ${board[column].length}`,
        testID: `leitstand-board-tab-${column}`,
      })),
    [board, t],
  );
  const visibleColumns = isCompact ? [compactColumn] : COLUMNS;

  return (
    <View style={styles.board} testID="leitstand-board">
      {projects.length > 1 ? (
        // On a phone the chips scroll sideways instead of stacking into half a screen.
        <ScrollView
          horizontal={isCompact}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={isCompact ? styles.filtersScroll : styles.filters}
        >
          <FilterChip
            label={t("leitstand.board.allProjects")}
            value={null}
            selected={selectedProject === null}
            onSelect={setProjectViewKey}
            testID="leitstand-filter-all"
          />
          {projects.map((project) => (
            <FilterChip
              key={project.viewKey}
              label={project.name}
              value={project.viewKey}
              selected={selectedProject === project.viewKey}
              onSelect={setProjectViewKey}
              testID={`leitstand-filter-${project.viewKey}`}
            />
          ))}
        </ScrollView>
      ) : null}
      {isCompact ? (
        <SegmentedControl
          options={columnOptions}
          value={compactColumn}
          onValueChange={setCompactColumn}
          size="md"
          testID="leitstand-board-tabs"
        />
      ) : null}
      <View style={styles.columns}>
        {visibleColumns.map((column) => (
          <View key={column} style={styles.column} testID={`leitstand-column-${column}`}>
            {isCompact ? null : (
              <View style={styles.columnHeader}>
                <Text style={styles.columnLabel}>{t(COLUMN_LABEL_KEY[column])}</Text>
                <Text dataSet={MONO_FONT_DATASET} style={styles.mono}>
                  {board[column].length}
                </Text>
              </View>
            )}
            <ColumnCards column={column} board={board} />
          </View>
        ))}
      </View>
    </View>
  );
}

function ColumnCards({
  column,
  board,
}: {
  column: BoardColumnId;
  board: ReturnType<typeof buildLeitstandBoard>;
}) {
  const { t } = useTranslation();
  const empty = <Text style={styles.columnEmpty}>{t(COLUMN_EMPTY_KEY[column])}</Text>;
  if (column === "planned") {
    if (board.planned.length === 0) return empty;
    return board.planned.map((schedule) => <ScheduleCard key={schedule.key} entry={schedule} />);
  }
  // A topic sits in the column of its most urgent child, so a column's own sessions can all
  // have moved into a topic card elsewhere.
  const entries = arrangeBoardColumns(board)[column];
  if (entries.length === 0) return empty;
  return entries.map((entry) =>
    entry.kind === "session" ? (
      <SessionCard key={entry.session.key} session={entry.session} />
    ) : (
      <TopicCard key={entry.key} entry={entry} />
    ),
  );
}

function FilterChip({
  label,
  value,
  selected,
  onSelect,
  testID,
}: {
  label: string;
  value: string | null;
  selected: boolean;
  onSelect: (value: string | null) => void;
  testID: string;
}) {
  const press = useCallback(() => onSelect(value), [onSelect, value]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <Button
      variant={selected ? "secondary" : "ghost"}
      size="xs"
      onPress={press}
      accessibilityState={accessibilityState}
      testID={testID}
    >
      {label}
    </Button>
  );
}

function cardStyle({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.card, (hovered || pressed) && styles.cardActive];
}

function TopicCard({ entry }: { entry: Extract<LeitstandBoardEntry, { kind: "topic" }> }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const first = entry.children[0];
  const testID = `leitstand-topic-${entry.key}`;
  return (
    <View style={styles.card} testID={testID}>
      <View style={styles.cardHead}>
        {first ? <ProjectTag name={first.projectName} /> : null}
        <Text dataSet={DISPLAY_FONT_DATASET} style={styles.cardTitle} numberOfLines={2}>
          {entry.topic.title}
        </Text>
        <StatusGlyph name={glyphForBucket(entry.bucket)} size={14} />
      </View>
      <Pressable onPress={toggle} accessibilityRole="button" testID={`${testID}-toggle`}>
        <Text style={styles.context}>
          {`${expanded ? "▾" : "▸"} ${t("leitstand.board.topicSessions", { count: entry.children.length })}`}
        </Text>
      </Pressable>
      {expanded ? (
        <View style={styles.topicChildren}>
          {entry.children.map((child) => (
            <TopicChildRow key={child.key} session={child} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function TopicChildRow({ session }: { session: LeitstandSession }) {
  const open = useCallback(() => {
    navigateToWorkspace({ serverId: session.serverId, workspaceId: session.workspaceId });
  }, [session.serverId, session.workspaceId]);
  const stack = summarizeStack(session.pullRequests);
  return (
    <Pressable
      onPress={open}
      style={styles.topicChild}
      accessibilityRole="button"
      testID={`leitstand-card-${session.key}`}
    >
      <StatusGlyph name={glyphForBucket(session.bucket)} size={12} />
      <Text style={styles.topicChildName} numberOfLines={1}>
        {session.name}
      </Text>
      {stack.total > 1 ? <StackBar pullRequests={session.pullRequests} /> : null}
      <AgeText date={session.since} />
    </Pressable>
  );
}

// The card is a glance, not the agent list; the session itself has every tab.
const MAX_AGENT_CHIPS = 3;

function SessionCard({ session }: { session: LeitstandSession }) {
  const { t } = useTranslation();
  const open = useCallback(() => {
    navigateToWorkspace({ serverId: session.serverId, workspaceId: session.workspaceId });
  }, [session.serverId, session.workspaceId]);
  const stack = summarizeStack(session.pullRequests);
  const linkedPr =
    session.pullRequests.find((pr) => pr.state === "open") ?? session.pullRequests.at(-1);
  const testID = `leitstand-card-${session.key}`;

  return (
    <Pressable onPress={open} style={cardStyle} accessibilityRole="button" testID={testID}>
      <View style={styles.cardHead}>
        <ProjectTag name={session.projectName} />
        <Text dataSet={DISPLAY_FONT_DATASET} style={styles.cardTitle} numberOfLines={2}>
          {session.name}
        </Text>
        {session.bucket === "attention" ? (
          <Text dataSet={MONO_FONT_DATASET} style={styles.mono}>
            {t("leitstand.board.unread")}
          </Text>
        ) : null}
        <StatusGlyph name={glyphForBucket(session.bucket)} size={14} />
      </View>
      {session.context ? (
        <Text style={styles.context} numberOfLines={1}>
          {session.context}
        </Text>
      ) : null}
      <View style={styles.meta}>
        {stack.total > 1 ? (
          <View style={styles.metaItem}>
            <StackBar pullRequests={session.pullRequests} />
            <Text dataSet={MONO_FONT_DATASET} style={styles.mono}>
              {t("leitstand.board.stack", { merged: stack.merged, total: stack.total })}
            </Text>
          </View>
        ) : null}
        {linkedPr ? (
          <ExternalLink href={linkedPr.url} label={`#${linkedPr.number}`} testID={`${testID}-pr`} />
        ) : null}
        <AgeText date={session.since} />
      </View>
      {session.jiraKeys.length > 0 ? (
        <View style={styles.jira}>
          <JiraTags keys={session.jiraKeys} testID={testID} />
        </View>
      ) : null}
      {session.agents.length > 0 ? (
        <View style={styles.agents}>
          {session.agents.slice(0, MAX_AGENT_CHIPS).map((agent) => (
            <AgentChip key={agent.id} agent={agent} />
          ))}
          {session.agents.length > MAX_AGENT_CHIPS ? (
            <Text dataSet={MONO_FONT_DATASET} style={styles.mono}>
              {t("leitstand.board.moreAgents", { count: session.agents.length - MAX_AGENT_CHIPS })}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

function AgentChip({ agent }: { agent: LeitstandAgent }) {
  return (
    <View style={styles.agentChip}>
      <StatusGlyph name={glyphForBucket(agent.bucket)} size={10} />
      <Text style={styles.agentLabel} numberOfLines={1}>
        {agent.title ?? agent.provider}
      </Text>
      {agent.model ? (
        <Text style={styles.agentModel} numberOfLines={1}>
          {agent.model}
        </Text>
      ) : null}
    </View>
  );
}

function ScheduleCard({ entry }: { entry: LeitstandSchedule }) {
  const { t } = useTranslation();
  const router = useRouter();
  const open = useCallback(() => router.push(buildSchedulesRoute()), [router]);
  const { schedule } = entry;
  return (
    <Pressable
      onPress={open}
      style={cardStyle}
      accessibilityRole="button"
      testID={`leitstand-card-${entry.key}`}
    >
      <View style={styles.cardHead}>
        {entry.projectName ? <ProjectTag name={entry.projectName} /> : null}
        <Text dataSet={DISPLAY_FONT_DATASET} style={styles.cardTitle} numberOfLines={2}>
          {resolveScheduleTitle(schedule)}
        </Text>
        <StatusGlyph name="plan" size={14} />
      </View>
      <View style={styles.meta}>
        <Text dataSet={MONO_FONT_DATASET} style={styles.mono}>
          {formatCadence(schedule.cadence)}
        </Text>
        <Text dataSet={MONO_FONT_DATASET} style={styles.mono}>
          {t("leitstand.board.nextRun", { when: formatNextRun(schedule.nextRunAt) })}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  board: {
    gap: theme.spacing[3],
  },
  filters: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  filtersScroll: {
    flexDirection: "row",
    gap: theme.spacing[1.5],
  },
  columns: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[8],
  },
  column: {
    flexGrow: 1,
    flexBasis: 260,
    minWidth: 0,
  },
  columnHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[1.5],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.foreground,
  },
  columnLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
    letterSpacing: 0.7,
    color: theme.colors.foregroundMuted,
  },
  columnEmpty: {
    paddingVertical: theme.spacing[3],
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  mono: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  card: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[0.5],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  cardActive: {
    backgroundColor: theme.colors.surface1,
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  cardTitle: {
    flex: 1,
    fontFamily: theme.fontFamily.display,
    fontSize: theme.fontSize["2xl"],
    color: theme.colors.foreground,
  },
  context: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  meta: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
    marginTop: theme.spacing[1],
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  jira: {
    marginTop: theme.spacing[1],
  },
  topicChildren: {
    marginTop: theme.spacing[1.5],
    marginLeft: theme.spacing[1.5],
    paddingLeft: theme.spacing[3],
    borderLeftWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.colors.surface4,
    gap: theme.spacing[1.5],
  },
  topicChild: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  topicChildName: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  agents: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
    marginTop: theme.spacing[1],
  },
  agentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[0.5],
    maxWidth: "100%",
  },
  agentLabel: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  agentModel: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
