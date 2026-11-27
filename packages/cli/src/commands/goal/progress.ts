import type { Goal, Task, UsageTotals } from "@getpaseo/protocol/goal/types";

/** "1h 05m", "3m 12s", "45s". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

/**
 * "$0.42"; ">=$0.42" when some turns reported no cost, so the sum is a lower bound;
 * "no cost" when none did. Hosts that do not count cost reports give "$0.42", or "" for 0.
 */
export function formatCost(usage: UsageTotals): string {
  const amount = `$${usage.costUsd.toFixed(2)}`;
  if (usage.costReportedTurns === undefined) return usage.costUsd > 0 ? amount : "";
  if (usage.costReportedTurns === 0) return "no cost";
  return usage.costReportedTurns < usage.totalTurns ? `>=${amount}` : amount;
}

/** "12.3k tok >=$0.42 (3/5 turns)"; "-" when nothing was recorded. */
export function formatUsage(usage: UsageTotals | undefined): string {
  if (!usage || usage.totalTurns === 0) return "-";
  const turns = `(${usage.reportedTurns}/${usage.totalTurns} turns)`;
  if (usage.reportedTurns === 0) return `not reported ${turns}`;
  const cost = formatCost(usage);
  return `${formatTokens(usage.totalTokens)} tok${cost ? ` ${cost}` : ""} ${turns}`;
}

/** Time since creation for a live goal; creation to its last event for an ended one. */
export function goalElapsedMs(goal: Goal, now: number): number {
  const live =
    goal.status !== "completed" && goal.status !== "failed" && goal.status !== "cancelled";
  return (live ? now : Date.parse(goal.updatedAt)) - Date.parse(goal.createdAt);
}

/** When a task's first run started and its last run ended, from the goal's runs. */
export function taskTimes(
  goal: Goal,
  task: Task,
): { startedAt: string | null; endedAt: string | null } {
  const runs = goal.runs.filter((r) => r.taskId === task.id);
  const first = runs[0];
  const last = runs.at(-1);
  return {
    startedAt: first?.startedAt ?? null,
    endedAt: last && last.status !== "running" ? last.endedAt : null,
  };
}

/** Usage of a task's runs added together. */
export function taskUsage(goal: Goal, task: Task): UsageTotals | undefined {
  const runs = goal.runs.filter((r) => r.taskId === task.id && r.usage);
  if (runs.length === 0) return undefined;
  return runs.reduce<UsageTotals>(
    (sum, run) => {
      const u = run.usage as UsageTotals;
      return {
        inputTokens: sum.inputTokens + u.inputTokens,
        cachedInputTokens: sum.cachedInputTokens + u.cachedInputTokens,
        outputTokens: sum.outputTokens + u.outputTokens,
        totalTokens: sum.totalTokens + u.totalTokens,
        costUsd: sum.costUsd + u.costUsd,
        reportedTurns: sum.reportedTurns + u.reportedTurns,
        totalTurns: sum.totalTurns + u.totalTurns,
        ...(sum.costReportedTurns !== undefined && u.costReportedTurns !== undefined
          ? { costReportedTurns: sum.costReportedTurns + u.costReportedTurns }
          : {}),
        ...(sum.tokenReportedTurns !== undefined && u.tokenReportedTurns !== undefined
          ? { tokenReportedTurns: sum.tokenReportedTurns + u.tokenReportedTurns }
          : {}),
      };
    },
    {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      reportedTurns: 0,
      totalTurns: 0,
      costReportedTurns: 0,
      tokenReportedTurns: 0,
    },
  );
}
