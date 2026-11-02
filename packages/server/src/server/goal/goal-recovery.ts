import { stat } from "node:fs/promises";
import type pino from "pino";
import { goalPermissionPolicy } from "@getpaseo/protocol/goal/config-bounds";
import {
  MAX_INTERVENTION_ERROR_CHARS,
  RECOVERY_DECISION_MS,
  RECOVERY_TRIGGER,
  capText,
} from "@getpaseo/protocol/goal/interventions";
import { goalRoleThinking } from "@getpaseo/protocol/goal/thinking";
import type {
  Goal,
  GoalEventInput,
  Recovery,
  RecoveryDecision,
} from "@getpaseo/protocol/goal/types";
import type { GitPort } from "./git-ops.js";
import type { ManagerAgentPort, ManagerWorkspacePort } from "./goal-manager.js";
import { budgetExceeded, resolveLimits } from "./goal-limits.js";
import { MAX_PLAN_REVISIONS, isReworkFailed } from "./goal-reducer.js";
import type { GoalStore } from "./goal-store.js";
import { thinkingInput } from "./goal-thinking.js";
import {
  MAX_LEAD_TURN_TRIES,
  type InterventionFallback,
  type InterventionHandler,
} from "./lead-intervention.js";
import { InterventionDecisionError, extractRecoveryDecision } from "./plan-extract.js";
import { PlanRevisionError, checkRecoveryDecision } from "./plan-revision.js";
import { buildRecoveryPrompt } from "./prompts.js";

/**
 * Recovering a failed goal: a person starts it (recovery.started), the Manager gives the goal a
 * fresh Lead, the Lead decides in one turn (recovery.decided), and the Manager applies the
 * decision (recovery.resolved) or a person approves it first. The goal stays failed until the
 * decision applies. Every step is derived from the goal's state, so a restart picks it up.
 */

/** The label a recovery Lead carries, so one orphaned by a crash before lead.attached can be found. */
export const RECOVERY_LABEL = "paseo.goal-recovery";

/** The intervention that asks the recovery's Lead. */
export function recoveryInterventionId(recoveryId: string): string {
  return `recovery-${recoveryId}`;
}

/** Event ids the Manager records for a recovery; a repeated reaction is a duplicate. */
const recoveryEventId = (goalId: string, recoveryId: string, step: string) =>
  `${goalId}:recovery:${recoveryId}:${step}`;

/** The Lead's integration problem lines shown at most; a dirty tree can list thousands. */
const MAX_DIRTY_LINES = 20;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** `value` as one shell word, so a command in a message can be pasted as it is. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why the goal's integration worktree cannot take a recovery, in words a person can act on, or
 * null. It must exist, sit at the commit the goal recorded and hold no uncommitted changes to
 * tracked files. Nothing is reset or moved: a person decides what happens to that work.
 */
export async function integrationProblem(
  goal: Goal,
  git: Pick<GitPort, "head" | "trackedChanges">,
): Promise<string | null> {
  const integration = goal.integration;
  if (!integration) return null;
  const cwd = shellQuote(integration.cwd);
  const headCommit = shellQuote(integration.headCommit);
  const branch = shellQuote(integration.branch);
  const repo = shellQuote(goal.config?.cwd ?? "<repository>");
  let head: string;
  try {
    head = await git.head(integration.cwd);
  } catch (error) {
    if (!(await exists(integration.cwd))) {
      return `The integration worktree ${cwd} is missing. Recreate it on its branch: git -C ${repo} worktree prune && git -C ${repo} worktree add ${cwd} ${branch}. Check that git -C ${cwd} rev-parse HEAD prints ${headCommit}, then recover again.`;
    }
    return `The integration worktree ${cwd} could not be read (${errorText(error)}). Repair it so that git -C ${cwd} rev-parse HEAD prints ${headCommit}, then recover again.`;
  }
  if (head !== integration.headCommit) {
    return `The integration worktree ${cwd} is at ${head}, but the goal recorded ${headCommit} on ${branch}; Paseo does not move it. Keep what is there on another branch if you need it (git -C ${cwd} branch <name> ${shellQuote(head)}), put it back with git -C ${cwd} reset --hard ${headCommit}, then recover again.`;
  }
  let dirty: string;
  try {
    dirty = await git.trackedChanges(integration.cwd);
  } catch (error) {
    return `The integration worktree ${cwd} could not be read (${errorText(error)}). Repair it so that git -C ${cwd} status works, then recover again.`;
  }
  if (!dirty) return null;
  const lines = dirty.split("\n");
  const shown = lines.slice(0, MAX_DIRTY_LINES).join("\n");
  const more = lines.length > MAX_DIRTY_LINES ? `\n(${lines.length - MAX_DIRTY_LINES} more)` : "";
  return `The integration worktree ${cwd} has uncommitted changes to tracked files:\n${shown}${more}\nCommit them elsewhere or put them aside with git -C ${cwd} stash, then recover again.`;
}

/**
 * Why a change set whose rework failed cannot be reworked again, or null. Its rework runs in the
 * change set's own worktree, so that worktree must still exist; once archived it is gone, and
 * reopening would only fail the rework again.
 */
export async function reworkWorktreeProblem(
  goal: Goal,
  git: Pick<GitPort, "head">,
): Promise<string | null> {
  for (const cs of goal.changeSets.filter(isReworkFailed)) {
    try {
      await git.head(cs.cwd);
      continue;
    } catch {
      if (await exists(cs.cwd)) continue;
    }
    const task = goal.tasks.findLast((t) => t.rework?.changeSetId === cs.id);
    const branch = goal.integration ? ` ${shellQuote(goal.integration.branch)}` : "";
    // Branches are never deleted, so the change set's own branch still holds its work.
    return `The rework worktree ${shellQuote(cs.cwd)} of ${cs.id} is gone, so its rework${task ? ` ${task.id}` : ""} cannot run again. Its work is on branch ${shellQuote(cs.branch)}. Start a new goal from the integration branch${branch} and rebuild the change from that branch.`;
  }
  return null;
}

/**
 * Whether an apply refused against the goal as it is now was refused for the Lead's decision
 * (its ops or hints no longer fit), which counts toward the recovery limit. Any other refusal
 * comes from a limit (time, runs, budget) and does not count. A revise is checked against the
 * run limit and budgets too, so a limit that leaves no room is ruled out first: a person who
 * lowered it must not burn a recovery.
 */
export function decisionNoLongerFits(goal: Goal, recovery: Recovery): boolean {
  const decision = recovery.decision;
  if (!decision) return false;
  if (goal.runs.length >= resolveLimits(goal.config).maxRuns || budgetExceeded(goal)) return false;
  if (decision.decision === "revise" && (goal.planRevisions?.length ?? 0) >= MAX_PLAN_REVISIONS) {
    return true;
  }
  try {
    checkRecoveryDecision(goal, decision, recovery.interventionId);
    return false;
  } catch (error) {
    if (error instanceof PlanRevisionError) return true;
    throw error;
  }
}

/** The time fields recovery.resolved{applied} copies from the recovery, absent kept absent. */
export function recoveryTimeFields(recovery: Recovery): { timeMode?: string; activeMs?: number } {
  return {
    ...(recovery.timeMode === undefined ? {} : { timeMode: recovery.timeMode }),
    ...(recovery.activeMs === undefined ? {} : { activeMs: recovery.activeMs }),
  };
}

/** The change sets an applied recovery reworks again: every one whose rework failed. */
export function reworkChangeSetFields(goal: Goal): { reworkChangeSetIds?: string[] } {
  const ids = goal.changeSets.filter(isReworkFailed).map((c) => c.id);
  return ids.length > 0 ? { reworkChangeSetIds: ids } : {};
}

/** What the recovery handler needs from the Manager. */
export interface RecoveryHandlerDeps {
  goal(goalId: string): Goal | undefined;
  /** Records an event. Resolves with the reducer's refusal, or null when recorded (or already). */
  record(goalId: string, input: GoalEventInput): Promise<string | null>;
  /** Now, on the Manager's clock. */
  now(): number;
}

/** The recovery deciding through `interventionId`, if any. */
function decidingThrough(goal: Goal | undefined, interventionId: string): Recovery | null {
  const recovery = goal?.recovery;
  if (goal?.status !== "failed" || recovery?.status !== "deciding") return null;
  return recovery.interventionId === interventionId ? recovery : null;
}

function decidedEvent(goalId: string, recoveryId: string, decision: RecoveryDecision) {
  return {
    id: recoveryEventId(goalId, recoveryId, "decided"),
    goalId,
    type: "recovery.decided" as const,
    recoveryId,
    decision,
  };
}

function fallbackReason(reason: InterventionFallback): string {
  const minutes = Math.round(RECOVERY_DECISION_MS / 60_000);
  const without = "retrying every failed and cancelled task with the person's instruction only";
  switch (reason.kind) {
    case "expired":
      return `The Lead did not decide within ${minutes} minutes; ${without}`;
    case "lead_unavailable":
      return `The Lead could not decide (${reason.note || "no reason given"}); ${without}`;
    case "unusable":
      return `The Lead's answer could not be used (${reason.note}); ${without}`;
  }
}

/**
 * The recovery Lead's decision, run by the generic intervention loop. The reply is read against
 * the goal as it is when it is applied, so `parse` keeps the text and `apply` reads it: a reply
 * that does not fit gets one correction turn. The decision is always recorded as
 * recovery.decided, never intervention.resolved; without a usable answer in time it is a retry
 * with the person's instruction only, which does not count toward the recovery limit.
 */
export function recoveryHandler(deps: RecoveryHandlerDeps): InterventionHandler<string> {
  return {
    decisionMs: RECOVERY_DECISION_MS,
    maxTurns: MAX_LEAD_TURN_TRIES,
    buildPrompt: (goal) =>
      buildRecoveryPrompt(goal, {
        decisionMinutes: Math.round(RECOVERY_DECISION_MS / 60_000),
        now: deps.now(),
      }),
    parse: (text) => text,
    async apply(goal, intervention, text) {
      const recovery = decidingThrough(goal, intervention.id);
      if (!recovery) return;
      const decision = extractRecoveryDecision(text, goal, intervention.id);
      const refusal = await deps.record(goal.id, decidedEvent(goal.id, recovery.id, decision));
      if (refusal === null) return;
      // Cancelled meanwhile: nothing is left to decide.
      if (!decidingThrough(deps.goal(goal.id), intervention.id)) return;
      throw new InterventionDecisionError(refusal);
    },
    async fallback(goal, intervention, reason) {
      const recovery = decidingThrough(goal, intervention.id);
      if (!recovery) return;
      await deps.record(
        goal.id,
        decidedEvent(goal.id, recovery.id, {
          decision: "retry",
          reason: fallbackReason(reason),
          fallback: true,
        }),
      );
    },
  };
}

/** What GoalRecoveries needs from the Manager. */
export interface GoalRecoveriesHost {
  store: Pick<GoalStore, "get">;
  agents: Pick<ManagerAgentPort, "createAgent" | "cancel" | "findAgents">;
  workspaces: ManagerWorkspacePort;
  git: Pick<GitPort, "head" | "trackedChanges">;
  logger: pino.Logger;
  isStopped(): boolean;
  record(goalId: string, input: GoalEventInput): Promise<string | null>;
  /** Cancel the agent and archive the workspace, ignoring failures. */
  discard(agentId: string | null, workspaceId: string | null): Promise<void>;
}

/**
 * The daemon's side of a recovery: start its Lead and ask for the decision, apply a decision,
 * and end a recovery a budget overran. The decision itself runs in LeadInterventions with
 * recoveryHandler.
 */
export class GoalRecoveries {
  /** Goals whose recovery Lead is being created, so hasLiveWork holds a retry or delete. */
  private readonly starting = new Set<string>();

  constructor(private readonly host: GoalRecoveriesHost) {}

  hasLive(goalId: string): boolean {
    return this.starting.has(goalId);
  }

  /**
   * After recovery.started, or at start for a recovery deciding: check the integration worktree,
   * give the goal a fresh Lead when it has none, then ask it. A Lead that cannot be started is
   * a fallback: a retry with the person's instruction only.
   */
  async begin(goalId: string): Promise<void> {
    const recovery = this.deciding(goalId);
    if (!recovery || this.starting.has(goalId) || this.host.isStopped()) return;
    this.starting.add(goalId);
    try {
      if (!recovery.leadAgentId) {
        const goal = this.host.store.get(goalId) as Goal;
        const problem =
          (await integrationProblem(goal, this.host.git)) ??
          (await reworkWorktreeProblem(goal, this.host.git));
        if (problem) {
          await this.decideWithout(goalId, recovery.id, "needs_person", problem);
          return;
        }
        try {
          if (!(await this.attachLead(goalId, recovery.id))) return;
        } catch (error) {
          if (this.host.isStopped()) return;
          await this.decideWithout(
            goalId,
            recovery.id,
            "retry",
            `The recovery Lead could not be started (${errorText(error)}); retrying every failed and cancelled task with the person's instruction only`,
          );
          return;
        }
      }
      await this.requestDecision(goalId, recovery.id);
    } finally {
      this.starting.delete(goalId);
    }
  }

  private deciding(goalId: string, recoveryId?: string): Recovery | null {
    const goal = this.host.store.get(goalId);
    const recovery = goal?.recovery;
    if (!goal?.config || goal.status !== "failed" || recovery?.status !== "deciding") return null;
    return recoveryId === undefined || recovery.id === recoveryId ? recovery : null;
  }

  /**
   * The recovery Lead works in its own worktree at the integration head, labelled with the
   * recovery so a crash before lead.attached leaves it findable. False when the recovery ended
   * meanwhile; the agent and worktree are then released.
   */
  private async attachLead(goalId: string, recoveryId: string): Promise<boolean> {
    const goal = this.host.store.get(goalId) as Goal;
    const config = goal.config;
    if (!config) return false;
    const baseRef = goal.integration?.headCommit ?? config.baseCommit;
    const workspace = await this.host.workspaces.create({
      cwd: config.cwd,
      isolation: "worktree",
      title: `${goal.title} (recovery lead)`,
      ...(baseRef ? { baseRef } : {}),
    });
    const { agentId } = await this.host.agents
      .createAgent({
        provider: config.leadProvider,
        ...thinkingInput(goalRoleThinking(config, "lead")),
        permission: goalPermissionPolicy(config),
        cwd: workspace.cwd,
        workspaceId: workspace.workspaceId,
        title: `Lead (recovery): ${goal.title}`,
        labels: {
          "paseo.goal-id": goalId,
          "paseo.goal-role": "lead",
          [RECOVERY_LABEL]: recoveryId,
        },
      })
      .catch(async (error) => {
        await this.host.discard(null, workspace.workspaceId);
        throw error;
      });
    // A stopping daemon records nothing; the next start finds the agent by its label.
    if (this.host.isStopped()) return false;
    const refusal = this.deciding(goalId, recoveryId)
      ? await this.host.record(goalId, {
          id: `${goalId}:lead:recovery-${recoveryId}`,
          goalId,
          type: "lead.attached",
          agentId,
          workspaceId: workspace.workspaceId,
        })
      : "the recovery ended";
    if (refusal === null) return true;
    await this.host.discard(agentId, workspace.workspaceId);
    return false;
  }

  /** Ask the recovery's Lead; the Manager's reaction to the request runs the decision. */
  async requestDecision(goalId: string, recoveryId: string): Promise<void> {
    const recovery = this.deciding(goalId, recoveryId);
    if (!recovery?.leadAgentId || recovery.interventionId) return;
    await this.host.record(goalId, {
      id: `${goalId}:intervention:${recoveryInterventionId(recoveryId)}`,
      goalId,
      type: "intervention.requested",
      interventionId: recoveryInterventionId(recoveryId),
      trigger: RECOVERY_TRIGGER,
      error: capText(recovery.failureReason, MAX_INTERVENTION_ERROR_CHARS),
    });
  }

  /** A decision the Manager takes without the Lead; it never counts toward the limit. */
  private async decideWithout(
    goalId: string,
    recoveryId: string,
    decision: "retry" | "needs_person",
    reason: string,
  ): Promise<void> {
    await this.host.record(
      goalId,
      decidedEvent(goalId, recoveryId, { decision, reason, fallback: true }),
    );
  }

  /**
   * Apply a decided recovery: the integration worktree is checked again, then the decision is
   * applied with the recovery's time mode. A refusal ends the recovery for a person; it counts
   * only when the Lead's decision no longer fits the goal.
   */
  async apply(goalId: string): Promise<void> {
    const goal = this.host.store.get(goalId);
    const recovery = goal?.recovery;
    if (!goal || goal.status !== "failed" || recovery?.status !== "decided") return;
    if (this.host.isStopped()) return;
    const problem =
      (await integrationProblem(goal, this.host.git)) ??
      (await reworkWorktreeProblem(goal, this.host.git));
    if (this.host.isStopped()) return;
    if (problem) {
      await this.needsPerson(goalId, recovery.id, problem, true);
      return;
    }
    const refusal = await this.host.record(goalId, {
      id: recoveryEventId(goalId, recovery.id, "applied"),
      goalId,
      type: "recovery.resolved",
      recoveryId: recovery.id,
      outcome: "applied",
      ...recoveryTimeFields(recovery),
      ...reworkChangeSetFields(goal),
    });
    if (refusal === null) return;
    const current = this.host.store.get(goalId);
    if (current?.recovery?.id !== recovery.id || current.recovery.status !== "decided") return;
    await this.needsPerson(
      goalId,
      recovery.id,
      `The recovery could not be applied: ${refusal}`,
      !decisionNoLongerFits(current, current.recovery),
    );
  }

  private async needsPerson(
    goalId: string,
    recoveryId: string,
    reason: string,
    uncounted: boolean,
  ): Promise<void> {
    await this.host.record(goalId, {
      id: recoveryEventId(goalId, recoveryId, "needs-person"),
      goalId,
      type: "recovery.resolved",
      recoveryId,
      outcome: "needs_person",
      reason,
      ...(uncounted ? { uncounted: true } : {}),
    });
  }

  /**
   * The Lead's usage overran a budget while the recovery was open: it ends for a person, not
   * counted. A decided recovery is left to apply(), whose refusal says the same.
   */
  async endOverBudget(goalId: string, overBudget: string): Promise<void> {
    const recovery = this.host.store.get(goalId)?.recovery;
    if (!recovery) return;
    const reason = `${overBudget}. Raise the budget with paseo goal config ${goalId} --max-tokens or --max-cost, then recover again.`;
    if (recovery.status === "deciding") {
      await this.decideWithout(goalId, recovery.id, "needs_person", reason);
    } else if (recovery.status === "awaiting_approval") {
      await this.needsPerson(goalId, recovery.id, reason, true);
    }
  }

  /**
   * A crash between creating the recovery Lead and recording lead.attached leaves an agent no
   * log names. It carries the recovery's label; release every such agent and its worktree.
   * Without a searchable agent layer it is left in place.
   */
  async releaseOrphans(goalId: string, recoveryId: string): Promise<void> {
    const found =
      (await this.host.agents
        .findAgents?.({ "paseo.goal-id": goalId, [RECOVERY_LABEL]: recoveryId })
        .catch((error) => {
          this.host.logger.warn({ err: error, goalId }, "Could not search for recovery Leads");
          return [];
        })) ?? [];
    for (const agent of found) await this.host.discard(agent.agentId, agent.workspaceId);
  }

  /**
   * Whether the recovery Lead of an ended recovery may still be running or hold its worktree.
   * With a searchable agent layer this is what it finds; without one, assume so (releasing is
   * idempotent).
   */
  async hasLeftovers(goalId: string, recovery: Recovery): Promise<boolean> {
    if (!recovery.leadAgentId && !recovery.leadWorkspaceId) return false;
    if (!this.host.agents.findAgents) return true;
    const found = await this.host.agents
      .findAgents({ "paseo.goal-id": goalId, [RECOVERY_LABEL]: recovery.id })
      .catch(() => null);
    return found === null || found.length > 0;
  }
}
