import { useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { Goal } from "@getpaseo/protocol/goal/types";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import { SettingsCard, SettingsCollapsibleRow, SettingsSection } from "@/components/settings";
import { useSettingsRowLayout } from "@/components/settings/row-density";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isGoalTerminal } from "@/goals/goal-derivation";
import { burnRatePerHour, formatUsd, goalElapsedMs } from "@/goals/goal-progress";
import {
  agentUsageLines,
  amountValue,
  coverageLabel,
  formatTokenCount,
  goalUsageBudgets,
  roleUsageLines,
  tokenSplitLabel,
  usageBudgetLabel,
  type UsageBudget,
  type UsageLine,
} from "@/goals/goal-usage";
import { useHostFeature } from "@/runtime/host-features";
import { settingsStyles } from "@/styles/settings";
import { useRelativeTimeTick } from "@/usage/use-relative-time-tick";
import { GoalBar } from "./goal-bar";
import { fractionTone, MetricRow } from "./goal-progress-panel";

const formatThinking = (id: string) => formatThinkingOptionLabel({ id });

function nonNull(lines: readonly (string | null)[]): string[] {
  return lines.filter((line): line is string => line !== null);
}

/**
 * Tokens and cost for the whole goal against its caps, then per role and per agent. A total
 * that only some turns reported is shown as a lower bound with how many turns it covers.
 */
export function GoalUsageSection({ serverId, goal }: { serverId: string; goal: Goal }) {
  const { t } = useTranslation();
  const hasBreakdown = useHostFeature(serverId, "goalUsageBreakdown");
  const now = useRelativeTimeTick({ enabled: !isGoalTerminal(goal.status) });
  const { tokens, cost } = goalUsageBudgets(goal);
  const tokenValue = amountValue(tokens.amount);
  const rate = tokenValue === null ? null : burnRatePerHour(tokenValue, goalElapsedMs(goal, now));
  const roles = useMemo(() => roleUsageLines(t, goal), [t, goal]);
  const agents = useMemo(() => agentUsageLines(t, goal, formatThinking), [t, goal]);
  const truncated = goal.usageBreakdownTruncated ?? 0;

  const tokenHint = nonNull([
    goal.usage ? tokenSplitLabel(t, goal.usage) : null,
    coverageLabel(t, tokens.amount, "tokens"),
    rate === null ? null : t("goals.usage.burnRate", { rate: formatTokenCount(rate) }),
  ]);
  const costHint = nonNull([coverageLabel(t, cost.amount, "cost")]);

  let breakdown: ReactElement[];
  if (!hasBreakdown) {
    breakdown = [
      <View key="update" style={settingsStyles.row} testID="goal-usage-update-host">
        <Text style={styles.muted}>{t("goals.usage.updateHost")}</Text>
      </View>,
    ];
  } else {
    breakdown = [
      <SettingsCollapsibleRow
        key="roles"
        label={t("goals.usage.byRole")}
        summary={roles.length > 0 ? roles.map((line) => line.title).join(", ") : undefined}
        testID="goal-usage-roles"
      >
        {roles.length > 0 ? <UsageHeader key="header" /> : null}
        {roles.length > 0 ? (
          roles.map((line) => (
            <UsageLineRow key={line.key} line={line} testID={`goal-usage-role-${line.key}`} />
          ))
        ) : (
          <EmptyLine key="empty" text={t("goals.usage.noTurns")} />
        )}
      </SettingsCollapsibleRow>,
      <SettingsCollapsibleRow
        key="agents"
        label={t("goals.usage.byAgent")}
        summary={String(agents.length + truncated)}
        testID="goal-usage-agents"
      >
        {agents.length > 0 ? <UsageHeader key="header" /> : null}
        {agents.length > 0 ? (
          agents.map((line) => (
            <UsageLineRow key={line.key} line={line} testID={`goal-usage-agent-${line.key}`} />
          ))
        ) : (
          <EmptyLine key="empty" text={t("goals.usage.noTurns")} />
        )}
        {truncated > 0 ? (
          <EmptyLine key="truncated" text={t("goals.usage.truncated", { n: truncated })} />
        ) : null}
      </SettingsCollapsibleRow>,
    ];
  }

  return (
    <SettingsSection
      title={t("goals.usage.title")}
      info={t("goals.usage.info")}
      testID="goal-usage"
    >
      <SettingsCard testID="goal-usage-card">
        <BudgetMetric
          label={t("goals.usage.tokens")}
          usage={tokens}
          value={usageBudgetLabel(t, tokens, formatTokenCount)}
          hint={tokenHint}
          testID="goal-usage-tokens"
        />
        <BudgetMetric
          label={t("goals.usage.cost")}
          usage={cost}
          value={usageBudgetLabel(t, cost, formatUsd)}
          hint={costHint}
          testID="goal-usage-cost"
        />
        <MetricRow
          label={t("goals.usage.turns")}
          value={String(goal.usage?.totalTurns ?? 0)}
          testID="goal-usage-turns"
        />
        {breakdown}
      </SettingsCard>
    </SettingsSection>
  );
}

function BudgetMetric({
  label,
  usage,
  value,
  hint,
  testID,
}: {
  label: string;
  usage: UsageBudget;
  value: string;
  hint: string[];
  testID: string;
}): ReactElement {
  const budget = usage.budget;
  return (
    <MetricRow label={label} value={value} hint={hint} testID={testID}>
      {budget.kind === "limited" ? (
        <GoalBar fraction={budget.fraction} tone={fractionTone(budget.fraction, budget.isOver)} />
      ) : null}
    </MetricRow>
  );
}

function EmptyLine({ text }: { text: string }): ReactElement {
  const layout = useSettingsRowLayout();
  return (
    <View style={layout.row}>
      <Text style={layout.hint}>{text}</Text>
    </View>
  );
}

/** Column labels over the rows on a wide layout, on the same rails as the cells below. */
function UsageHeader(): ReactElement | null {
  const { t } = useTranslation();
  const layout = useSettingsRowLayout();
  const compact = useIsCompactFormFactor();
  if (compact) {
    return null;
  }
  return (
    <View style={layout.row}>
      <View style={styles.lineContent} />
      <View style={styles.cells}>
        <Text style={[styles.cell, styles.turnsCell, styles.headerCell]}>
          {t("goals.usage.columns.turns")}
        </Text>
        <Text style={[styles.cell, styles.headerCell]}>{t("goals.usage.columns.input")}</Text>
        <Text style={[styles.cell, styles.headerCell]}>{t("goals.usage.columns.cached")}</Text>
        <Text style={[styles.cell, styles.headerCell]}>{t("goals.usage.columns.output")}</Text>
        <Text style={[styles.cell, styles.headerCell]}>{t("goals.usage.columns.total")}</Text>
        <Text style={[styles.cell, styles.costCell, styles.headerCell]}>
          {t("goals.usage.columns.cost")}
        </Text>
      </View>
    </View>
  );
}

/**
 * One role or agent. Wide layouts put the numbers in aligned columns; compact ones fold them into
 * a muted line under the title so nothing scrolls sideways at phone width.
 */
function UsageLineRow({ line, testID }: { line: UsageLine; testID: string }): ReactElement {
  const { t } = useTranslation();
  const layout = useSettingsRowLayout();
  const compact = useIsCompactFormFactor();
  const sep = t("goals.usage.separator");

  if (compact) {
    return (
      <View style={[layout.row, styles.compactLine]} testID={testID}>
        <View style={styles.compactHeadline}>
          <Text style={[layout.title, styles.lineTitle]} numberOfLines={2}>
            {line.title}
          </Text>
          <Text style={[layout.title, styles.numbers]}>{[line.total, line.cost].join(sep)}</Text>
        </View>
        {line.detail ? (
          <Text style={layout.hint} numberOfLines={1}>
            {line.detail}
          </Text>
        ) : null}
        <Text style={[layout.hint, styles.numbers]}>
          {[
            t("goals.usage.turnsCount", { n: line.turns }),
            `${t("goals.usage.columns.input")} ${line.input}`,
            `${t("goals.usage.columns.cached")} ${line.cached}`,
            `${t("goals.usage.columns.output")} ${line.output}`,
          ].join(sep)}
        </Text>
        {line.coverage ? <Text style={layout.hint}>{line.coverage}</Text> : null}
      </View>
    );
  }

  return (
    <View style={layout.row} testID={testID}>
      <View style={styles.lineContent}>
        <Text style={layout.title} numberOfLines={2}>
          {line.title}
        </Text>
        {line.detail ? (
          <Text style={layout.hint} numberOfLines={1}>
            {line.detail}
          </Text>
        ) : null}
        {line.coverage ? <Text style={layout.hint}>{line.coverage}</Text> : null}
      </View>
      <View style={styles.cells}>
        <Text style={[layout.title, styles.cell, styles.turnsCell]}>{line.turns}</Text>
        <Text style={[layout.title, styles.cell]}>{line.input}</Text>
        <Text style={[layout.title, styles.cell]}>{line.cached}</Text>
        <Text style={[layout.title, styles.cell]}>{line.output}</Text>
        <Text style={[layout.title, styles.cell]}>{line.total}</Text>
        <Text style={[layout.title, styles.cell, styles.costCell]}>{line.cost}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  lineContent: {
    flex: 1,
    minWidth: 0,
    marginRight: theme.spacing[3],
  },
  lineTitle: {
    flex: 1,
  },
  compactLine: {
    flexDirection: "column",
    alignItems: "stretch",
  },
  compactHeadline: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  numbers: {
    fontVariant: ["tabular-nums"],
  },
  cells: {
    flexDirection: "row",
    alignItems: "baseline",
  },
  // Fixed widths keep each number on its column's trailing rail from row to row.
  cell: {
    width: 64,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
  turnsCell: {
    width: 48,
  },
  costCell: {
    width: 96,
  },
  headerCell: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
