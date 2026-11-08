import type {
  Goal,
  UsageBreakdownEntry,
  UsageRole,
  UsageTotals,
} from "@getpaseo/protocol/goal/types";
import type { OutputSchema } from "../../output/index.js";
import { formatCost, formatTokens } from "./progress.js";

export interface GoalUsageRow {
  agent: string;
  role: string;
  work: string;
  provider: string;
  thinking: string;
  turns: string;
  input: string;
  cached: string;
  output: string;
  total: string;
  cost: string;
}

export const goalUsageSchema: OutputSchema<GoalUsageRow> = {
  idField: "agent",
  columns: [
    { header: "AGENT", field: "agent", width: 10 },
    { header: "ROLE", field: "role", width: 9 },
    { header: "TASK/RUN", field: "work", width: 18 },
    { header: "PROVIDER", field: "provider", width: 24 },
    { header: "THINKING", field: "thinking", width: 9 },
    { header: "TURNS", field: "turns", width: 6 },
    { header: "IN", field: "input", width: 8, align: "right" },
    { header: "CACHED", field: "cached", width: 8, align: "right" },
    { header: "OUT", field: "output", width: 8, align: "right" },
    { header: "TOTAL", field: "total", width: 8, align: "right" },
    { header: "COST", field: "cost", width: 14 },
  ],
};

const ROLES: UsageRole[] = ["lead", "worker", "reviewer", "verifier"];

/** "$0.53", ">=$0.53 (1/4)" when some turns reported none, "not reported" when no turn did. */
function costCell(usage: UsageTotals): string {
  if (usage.costReportedTurns === 0) return "not reported";
  const cost = formatCost(usage) || "$0.00";
  return cost.startsWith(">=") ? `${cost} (${usage.costReportedTurns}/${usage.totalTurns})` : cost;
}

function usageCells(usage: UsageTotals) {
  const tokens = usage.reportedTurns > 0;
  const count = (value: number) => (tokens ? formatTokens(value) : "-");
  return {
    turns: `${usage.reportedTurns}/${usage.totalTurns}`,
    input: count(usage.inputTokens),
    cached: count(usage.cachedInputTokens),
    output: count(usage.outputTokens),
    total: count(usage.totalTokens),
    cost: costCell(usage),
  };
}

function workCell(entry: UsageBreakdownEntry): string {
  if (entry.runId) return `${entry.taskId ?? "?"}/${entry.runId}`;
  if (entry.changeSetId)
    return entry.taskId ? `${entry.taskId}/${entry.changeSetId}` : entry.changeSetId;
  return entry.taskId ?? "-";
}

/**
 * One row per agent, then one per role and the goal's total. Null when the host sends no
 * breakdown.
 */
export function goalUsageRows(goal: Goal): GoalUsageRow[] | null {
  if (!goal.usageBreakdown) return goal.usage ? null : [];
  const rows: GoalUsageRow[] = goal.usageBreakdown.map((entry) => ({
    agent: entry.agentId.slice(0, 8),
    role: entry.role,
    work: workCell(entry),
    provider: entry.provider ? `${entry.provider}${entry.model ? `/${entry.model}` : ""}` : "-",
    thinking: entry.thinking ?? "-",
    ...usageCells(entry.usage),
  }));
  if (goal.usageBreakdownTruncated) {
    rows.push({
      agent: "...",
      role: "-",
      work: `${goal.usageBreakdownTruncated} older agents not listed`,
      provider: "-",
      thinking: "-",
      turns: "-",
      input: "-",
      cached: "-",
      output: "-",
      total: "-",
      cost: "-",
    });
  }
  const summary = (label: string, role: string, usage: UsageTotals): GoalUsageRow => ({
    agent: label,
    role,
    work: "-",
    provider: "-",
    thinking: "-",
    ...usageCells(usage),
  });
  for (const role of ROLES) {
    const usage = goal.usageByRole?.[role];
    if (usage) rows.push(summary("ROLE", role, usage));
  }
  if (goal.usage) rows.push(summary("TOTAL", "all", goal.usage));
  return rows;
}
