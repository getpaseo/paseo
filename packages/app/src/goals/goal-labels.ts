import type { TFunction } from "i18next";
import type { GoalRetainedResource } from "@getpaseo/protocol/goal/rpc-schemas";
import type { Goal, GoalPriority, GoalStatus } from "@getpaseo/protocol/goal/types";
import type { StatusBadgeVariant } from "@/components/ui/status-badge";
import { formatDuration } from "@/utils/time";
import { acceptedWaivedCount } from "./goal-accept";
import { goalAttention } from "./goal-attention";
import { GOAL_STATUS_BADGE, isGoalTerminal } from "./goal-derivation";
import { formatUsd, type GoalEstimate } from "./goal-progress";
import { liveRecovery } from "./goal-recovery";
import type { DurationParts, GoalSettingsSummaryPart } from "./goal-settings";
import { compactUsageBudgetLabel, formatTokenCount, goalUsageBudgets } from "./goal-usage";

export function durationLabel(t: TFunction, parts: DurationParts): string {
  return t(`goals.duration.${parts.unit}`, { n: parts.n });
}

export function settingsSummaryText(
  t: TFunction,
  parts: readonly GoalSettingsSummaryPart[],
): string {
  const clauses = parts.map((part) => {
    switch (part.key) {
      case "parallel":
        return t("goals.form.summary.parallel", { n: part.n });
      case "runLimit":
      case "deadline":
        return t(`goals.form.summary.${part.key}`, { duration: durationLabel(t, part.duration) });
      case "thinking":
        // Mid-sentence, so the level reads as a word rather than a label.
        return t("goals.form.summary.thinking", {
          level: part.label.toLocaleLowerCase(),
          role: t(`goals.form.thinkingRoles.${part.role}`),
        });
      default:
        return t(`goals.form.summary.${part.key}`);
    }
  });
  const sentence = clauses.join(t("goals.form.listSeparator"));
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export interface GoalBadge {
  label: string;
  variant: StatusBadgeVariant;
}

/** The status pill for a goal: what it waits on when it waits on you, else its status. */
export function goalBadge(
  t: TFunction,
  goal: Pick<
    Goal,
    "status" | "changeSets" | "pausedAt" | "planRevisions" | "recovery" | "accepted" | "criteria"
  >,
): GoalBadge {
  const attention = goalAttention(goal);
  if (attention === "change_review") {
    return { label: t("goals.changeSetStatus.awaiting_human"), variant: "warning" };
  }
  if (attention === "revision_review" || attention === "recovery_review") {
    return { label: t("goals.status.awaitingPlanChange"), variant: "warning" };
  }
  // The goal stays failed while a recovery decides; it is being worked on, not given up.
  if (liveRecovery(goal)) {
    return { label: t("goals.status.recovering"), variant: "running" };
  }
  const status: GoalStatus = goal.status;
  // A paused goal is still "executing" in its status; the person sees it as stopped.
  if (goal.pausedAt && !isGoalTerminal(status)) {
    return { label: t("goals.status.paused"), variant: "warning" };
  }
  // A person accepted it with criteria unverified: completed, and how many it waived. An accept
  // that waived nothing reads as a plain completion.
  const waived = status === "completed" ? acceptedWaivedCount(goal) : null;
  if (waived !== null && waived > 0) {
    return { label: t("goals.accept.completedWaived", { n: waived }), variant: "success" };
  }
  return { label: t(`goals.status.${status}`), variant: GOAL_STATUS_BADGE[status] };
}

export function estimateLabel(t: TFunction, estimate: GoalEstimate): string | null {
  switch (estimate.kind) {
    case "none":
      return null;
    case "paused":
      return t("goals.progress.paused");
    case "estimating":
      return t("goals.progress.estimating");
    case "range":
      if (estimate.lowMs === estimate.highMs) {
        return formatDuration(estimate.highMs);
      }
      return t("goals.progress.estimateRange", {
        low: formatDuration(estimate.lowMs),
        high: formatDuration(estimate.highMs),
      });
  }
}

/** Tokens and cost for a managed goal's list row; null for a manual goal, which runs nothing. */
export function rowUsageLabel(t: TFunction, goal: Pick<Goal, "usage" | "config">): string | null {
  if (!goal.config) {
    return null;
  }
  const { tokens, cost } = goalUsageBudgets(goal);
  const costReported = cost.amount.kind === "exact" || cost.amount.kind === "at_least";
  if (tokens.amount.kind === "not_reported" && !costReported) {
    return t("goals.row.usageNotReported");
  }
  const tokenText = compactUsageBudgetLabel(t, tokens, formatTokenCount);
  // An older host sums no cost without saying whether any turn reported one; a bare $0.00
  // would read as free.
  if (cost.amount.kind === "untracked") {
    return t("goals.row.tokensOnly", { tokens: tokenText });
  }
  return t("goals.row.usage", {
    tokens: tokenText,
    cost: compactUsageBudgetLabel(t, cost, formatUsd),
  });
}

const MAX_RETAINED_LINES = 4;

/** What delete kept, one line per branch or worktree and at most a few, for the toast. */
export function retainedSummary(t: TFunction, retained: readonly GoalRetainedResource[]): string {
  const lines = retained.slice(0, MAX_RETAINED_LINES).map((resource) =>
    t(resource.kind === "branch" ? "goals.actions.keptBranch" : "goals.actions.keptWorktree", {
      name: resource.name,
      reason: resource.reason,
    }),
  );
  if (retained.length > MAX_RETAINED_LINES) {
    lines.push(t("goals.actions.keptMore", { n: retained.length - MAX_RETAINED_LINES }));
  }
  return [t("goals.actions.deletedKept"), ...lines].join("\n");
}

/** The row's priority mark; none for normal, which is every goal's default. */
export function priorityBadgeLabel(t: TFunction, priority: GoalPriority): string | null {
  return priority === "normal" ? null : t(`goals.priority.badge.${priority}`);
}
