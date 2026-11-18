import type { TFunction } from "i18next";
import type {
  Goal,
  UsageBreakdownEntry,
  UsageRole,
  UsageTotals,
} from "@getpaseo/protocol/goal/types";
import { budgetStatus, formatUsd, type BudgetStatus } from "./goal-progress";

/**
 * "189.7k", "1.2M", "800": one decimal at every size, as `paseo goal ls` prints them, so the
 * numbers can be compared; a trailing ".0" is dropped.
 */
export function formatTokenCount(value: number): string {
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [size, suffix] of units) {
    if (Math.abs(value) >= size) {
      return `${Number((value / size).toFixed(1))}${suffix}`;
    }
  }
  return String(Math.round(value));
}

/**
 * A usage total as far as it is known. `at_least` when only some turns reported it, so the
 * sum is a lower bound; `untracked` when a host older than v0.13.3 summed no cost and does not
 * say whether any turn reported one.
 */
export type UsageAmount =
  | { kind: "not_reported" }
  | { kind: "untracked" }
  | { kind: "exact"; value: number }
  | { kind: "at_least"; value: number; reported: number; total: number };

function amountFrom(value: number, reported: number, total: number): UsageAmount {
  if (reported === 0) {
    return { kind: "not_reported" };
  }
  return reported < total ? { kind: "at_least", value, reported, total } : { kind: "exact", value };
}

/** Tokens (input + output, cache reads excluded), the total `maxTotalTokens` is checked against. */
export function tokenAmount(usage: UsageTotals | undefined): UsageAmount {
  if (!usage) {
    return { kind: "not_reported" };
  }
  // COMPAT(goalUsageBreakdown): hosts before v0.13.3 count only turns with any usage.
  const reported = usage.tokenReportedTurns ?? usage.reportedTurns;
  return amountFrom(usage.totalTokens, reported, usage.totalTurns);
}

/** Cost as providers reported it; Paseo never prices tokens. Same rule as `paseo goal ls`. */
export function costAmount(usage: UsageTotals | undefined): UsageAmount {
  if (!usage) {
    return { kind: "not_reported" };
  }
  // COMPAT(goalUsageBreakdown): hosts before v0.13.3 do not count cost reports.
  if (usage.costReportedTurns === undefined) {
    if (usage.reportedTurns === 0) {
      return { kind: "not_reported" };
    }
    return usage.costUsd > 0 ? { kind: "exact", value: usage.costUsd } : { kind: "untracked" };
  }
  return amountFrom(usage.costUsd, usage.costReportedTurns, usage.totalTurns);
}

/** The amount's value, or null when nothing was reported. */
export function amountValue(amount: UsageAmount): number | null {
  return amount.kind === "exact" || amount.kind === "at_least" ? amount.value : null;
}

/** "189.7k", "At least 189.7k", "Not reported". */
export function amountLabel(
  t: TFunction,
  amount: UsageAmount,
  format: (value: number) => string,
): string {
  switch (amount.kind) {
    case "not_reported":
    case "untracked":
      return t("goals.usage.notReported");
    case "exact":
      return format(amount.value);
    case "at_least":
      return t("goals.usage.atLeast", { value: format(amount.value) });
  }
}

/** A usage total and where it stands against the goal's cap. */
export interface UsageBudget {
  amount: UsageAmount;
  budget: BudgetStatus;
}

/** Tokens and cost so far against the goal's caps. Unreported usage is not counted as zero. */
export function goalUsageBudgets(goal: Pick<Goal, "usage" | "config">): {
  tokens: UsageBudget;
  cost: UsageBudget;
} {
  const limits = goal.config?.limits;
  const tokens = tokenAmount(goal.usage);
  const cost = costAmount(goal.usage);
  return {
    tokens: {
      amount: tokens,
      budget: budgetStatus(amountValue(tokens), limits?.maxTotalTokens ?? null),
    },
    cost: { amount: cost, budget: budgetStatus(amountValue(cost), limits?.maxCostUsd ?? null) },
  };
}

/** "At least 189.7k of 1M", "$0.53", "Not reported". */
export function usageBudgetLabel(
  t: TFunction,
  usage: UsageBudget,
  format: (value: number) => string,
): string {
  const used = amountLabel(t, usage.amount, format);
  if (usage.budget.kind !== "limited") {
    return used;
  }
  return t("goals.usage.usedOf", { used, limit: format(usage.budget.limit) });
}

/** The same as `usageBudgetLabel`, for a list row: "≥189.7k of 1M", "≥$0.53". */
export function compactUsageBudgetLabel(
  t: TFunction,
  usage: UsageBudget,
  format: (value: number) => string,
): string {
  const used = compactAmountLabel(t, usage.amount, format);
  if (usage.budget.kind !== "limited") {
    return used;
  }
  return t("goals.usage.usedOf", { used, limit: format(usage.budget.limit) });
}

/** "189.7k", "≥189.7k", "not reported": for dense rows and cells. */
export function compactAmountLabel(
  t: TFunction,
  amount: UsageAmount,
  format: (value: number) => string,
): string {
  switch (amount.kind) {
    case "not_reported":
    case "untracked":
      return t("goals.usage.notReportedShort");
    case "exact":
      return format(amount.value);
    case "at_least":
      return t("goals.usage.atLeastShort", { value: format(amount.value) });
  }
}

/** "Cost reported for 1 of 4 turns" when the amount is a lower bound, else null. */
export function coverageLabel(
  t: TFunction,
  amount: UsageAmount,
  what: "tokens" | "cost",
): string | null {
  if (amount.kind !== "at_least") {
    return null;
  }
  return t(`goals.usage.${what}Coverage`, { reported: amount.reported, total: amount.total });
}

/** "In 120k · Cached 1.2M · Out 69.7k", or null when no turn reported tokens. */
export function tokenSplitLabel(t: TFunction, usage: UsageTotals): string | null {
  if (tokenAmount(usage).kind === "not_reported") {
    return null;
  }
  return t("goals.usage.split", {
    input: formatTokenCount(usage.inputTokens),
    cached: formatTokenCount(usage.cachedInputTokens),
    output: formatTokenCount(usage.outputTokens),
  });
}

/** One line per usage total: role or agent, with what it is and every number already formatted. */
export interface UsageLine {
  key: string;
  title: string;
  /** Provider, model and thinking for an agent; null for a role. */
  detail: string | null;
  turns: string;
  input: string;
  cached: string;
  output: string;
  total: string;
  cost: string;
  /** "Cost reported for 1 of 4 turns" and the like, joined; null when both are complete. */
  coverage: string | null;
}

const ROLES: readonly UsageRole[] = ["lead", "worker", "reviewer", "verifier"];

function usageLine(
  t: TFunction,
  head: Pick<UsageLine, "key" | "title" | "detail">,
  usage: UsageTotals,
): UsageLine {
  const tokens = tokenAmount(usage);
  const cost = costAmount(usage);
  const reported = tokens.kind !== "not_reported";
  const count = (value: number) => (reported ? formatTokenCount(value) : "-");
  const coverage = [coverageLabel(t, tokens, "tokens"), coverageLabel(t, cost, "cost")].filter(
    (line): line is string => line !== null,
  );
  return {
    key: head.key,
    title: head.title,
    detail: head.detail,
    turns: String(usage.totalTurns),
    input: count(usage.inputTokens),
    cached: count(usage.cachedInputTokens),
    output: count(usage.outputTokens),
    total: compactAmountLabel(t, tokens, formatTokenCount),
    cost: compactAmountLabel(t, cost, formatUsd),
    coverage: coverage.length > 0 ? coverage.join(t("goals.usage.separator")) : null,
  };
}

/** One line per role that recorded a turn, Lead first. */
export function roleUsageLines(t: TFunction, goal: Pick<Goal, "usageByRole">): UsageLine[] {
  const byRole = goal.usageByRole;
  if (!byRole) {
    return [];
  }
  return ROLES.flatMap((role) => {
    const usage = byRole[role];
    return usage
      ? [usageLine(t, { key: role, title: t(`goals.usage.roles.${role}`), detail: null }, usage)]
      : [];
  });
}

/** What the agent worked on: its task's title, else its run or change set id. */
function workLabel(goal: Pick<Goal, "tasks">, entry: UsageBreakdownEntry): string | null {
  const task = entry.taskId ? goal.tasks.find((candidate) => candidate.id === entry.taskId) : null;
  return task?.title ?? entry.runId ?? entry.changeSetId ?? entry.taskId ?? null;
}

/** "claude/opus · Thinking high"; thinking is formatted by the caller so it can be localized. */
function agentDetail(
  t: TFunction,
  entry: UsageBreakdownEntry,
  formatThinking: (id: string) => string,
): string | null {
  const parts: string[] = [];
  if (entry.provider) {
    parts.push(entry.model ? `${entry.provider}/${entry.model}` : entry.provider);
  }
  if (entry.thinking) {
    parts.push(t("goals.detail.thinking", { level: formatThinking(entry.thinking) }));
  }
  return parts.length > 0 ? parts.join(t("goals.usage.separator")) : null;
}

/** One line per agent the host kept, most recently active first. */
export function agentUsageLines(
  t: TFunction,
  goal: Pick<Goal, "tasks" | "usageBreakdown">,
  formatThinking: (id: string) => string,
): UsageLine[] {
  return (goal.usageBreakdown ?? []).toReversed().map((entry) => {
    const role = t(`goals.usage.agentRoles.${entry.role}`);
    const work = workLabel(goal, entry);
    const title = work ? t("goals.usage.agentTitle", { role, work }) : role;
    const detail = agentDetail(t, entry, formatThinking);
    return usageLine(t, { key: entry.agentId, title, detail }, entry.usage);
  });
}
