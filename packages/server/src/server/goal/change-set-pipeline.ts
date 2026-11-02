import type pino from "pino";
import type {
  ChangeSet,
  ChangeSetStatus,
  Goal,
  GoalConfig,
  GoalEvent,
  GoalEventInput,
  Integration,
  Task,
} from "@getpaseo/protocol/goal/types";
import {
  CHANGE_SET_INTEGRATION_FAILED,
  CHANGE_SET_REWORK_FAILED,
  CHANGE_SET_REWORK_LIMIT,
} from "@getpaseo/protocol/goal/types";
import {
  DEFAULT_GOAL_BRANCH_PREFIX,
  goalPermissionPolicy,
} from "@getpaseo/protocol/goal/config-bounds";
import {
  VERIFICATION_NOT_MET_PREFIX,
  WORK_NOT_RECOVERED_PREFIX,
  isNoAnswerFailure,
  isPendingRequestFailure,
  isWorkerBlocked,
  workerBlockedFailureText,
} from "@getpaseo/protocol/goal/failure-wording";
import { goalRoleThinking } from "@getpaseo/protocol/goal/thinking";
import type { GitPort } from "./git-ops.js";
import { reworkReasonFor } from "./goal-reducer.js";
import { thinkingInput } from "./goal-thinking.js";
import type {
  ManagerAgentPort,
  ManagerWorkspacePort,
  TurnResult,
  TurnUsageLabel,
} from "./goal-manager.js";
import {
  ReplyParseError,
  buildReviewCorrectionPrompt,
  buildReviewPrompt,
  buildVerifyPrompt,
  describeRework,
  parseVerdict,
  parseVerification,
} from "./review.js";

export type DispatchOutcome = "new" | "duplicate" | "rejected";

/** The Manager services the pipeline relies on. */
export interface PipelineHost {
  dispatchOutcome(goalId: string, input: GoalEventInput): Promise<DispatchOutcome>;
  dispatch(goalId: string, input: GoalEventInput): Promise<boolean>;
  track(work: Promise<unknown>): void;
  isStopped(): boolean;
  failGoal(goalId: string, reason: string): Promise<void>;
  /** Ask the Manager to look for runnable work again. */
  requestPump(goalId: string): void;
  /** Cancel an agent and, when given, archive its workspace. */
  discard(agentId: string | null, workspaceId: string | null): Promise<void>;
  notifyLeadFinal(goal: Goal, text: string): void;
  /** Run one agent turn under the goal's time limit and permission policy, recording its usage. */
  runTurn(
    goalId: string,
    agentId: string,
    prompt: string,
    usage: TurnUsageLabel & { role: "reviewer" | "verifier" },
  ): Promise<TurnResult>;
}

export interface PipelineOptions {
  store: { get(goalId: string): Goal | undefined };
  agents: ManagerAgentPort;
  workspaces: ManagerWorkspacePort;
  git: GitPort;
  logger: pino.Logger;
  host: PipelineHost;
  /** Time allowed for the test command. */
  testTimeoutMs?: number;
}

const DEFAULT_MAX_REWORK_ROUNDS = 2;
const DEFAULT_TEST_TIMEOUT_MS = 10 * 60_000;
const REPLY_ATTEMPTS = 2;
const FINAL_STATUSES: ReadonlySet<ChangeSetStatus> = new Set([
  "integrated",
  "superseded",
  "rejected",
]);

function verifierProvider(config: GoalConfig): string {
  return config.verifyProvider ?? config.reviewProvider ?? config.leadProvider;
}

/** The task a rework task descends from. Rework ids are `<task>-rw<round>`. */
export function rootTaskId(taskId: string): string {
  return taskId.replace(/-rw\d+$/, "");
}

/**
 * Carries each implement task's work from "the agent says it is done" to "merged
 * on the goal's integration branch": capture it as a Change Set with explicit
 * commits, have an independent agent review it, merge approved sets one at a
 * time, test the result, and turn review feedback, conflicts and test failures
 * into rework. It is deterministic: agents only judge and edit; the transitions,
 * ordering and limits are decided here and enforced by the reducer.
 */
export class ChangeSetPipeline {
  private readonly store: PipelineOptions["store"];
  private readonly agents: ManagerAgentPort;
  private readonly workspaces: ManagerWorkspacePort;
  private readonly git: GitPort;
  private readonly logger: pino.Logger;
  private readonly host: PipelineHost;
  private readonly testTimeoutMs: number;
  private readonly integrationQueues = new Map<string, Promise<unknown>>();
  private readonly preparing = new Map<string, Promise<Integration>>();
  private readonly capturing = new Set<string>();
  private readonly verifying = new Set<string>();
  /** Reviewers and verifiers running per goal, so ending the goal can stop them. */
  private readonly liveAgents = new Map<string, Set<string>>();
  /** Reviews, merges and rework scheduling in progress per goal. */
  private readonly busy = new Map<string, number>();

  constructor(options: PipelineOptions) {
    this.store = options.store;
    this.agents = options.agents;
    this.workspaces = options.workspaces;
    this.git = options.git;
    this.logger = options.logger.child({ module: "change-set-pipeline" });
    this.host = options.host;
    this.testTimeoutMs = options.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  }

  // ---- queries the Manager uses to schedule ------------------------------

  /** Work is still moving through capture, review, integration or verification. */
  hasOpenWork(goal: Goal): boolean {
    return (
      this.verifying.has(goal.id) ||
      [...this.capturing].some((key) => key.startsWith(`${goal.id}:`)) ||
      // A succeeded implement task whose work is not yet captured has unreviewed changes.
      goal.tasks.some((t) => t.kind === "implement" && t.status === "succeeded" && !t.captured) ||
      goal.changeSets.some((c) => !FINAL_STATUSES.has(c.status))
    );
  }

  /**
   * An implement task may start once the code it builds on is on the
   * integration branch: every implement dependency's latest change set is
   * integrated, and none is still being captured.
   */
  dependenciesIntegrated(goal: Goal, task: Task): boolean {
    for (const depId of task.dependsOn) {
      const dep = goal.tasks.find((t) => t.id === depId);
      if (!dep || dep.kind !== "implement") continue;
      if (this.capturing.has(`${goal.id}:${depId}`)) return false;
      if (dep.status === "succeeded" && !dep.captured) return false;
      const chain = goal.changeSets.filter((c) => rootTaskId(c.taskId) === depId);
      const latest = chain.reduce<ChangeSet | null>(
        (best, c) => (best === null || c.round > best.round ? c : best),
        null,
      );
      if (latest && latest.status !== "integrated") return false;
    }
    return true;
  }

  // ---- integration branch ------------------------------------------------

  /** Create the goal's integration branch and worktree on first use. */
  ensureIntegration(goalId: string): Promise<Integration> {
    const existing = this.store.get(goalId)?.integration;
    if (existing) return Promise.resolve(existing);
    let pending = this.preparing.get(goalId);
    if (!pending) {
      pending = this.prepareIntegration(goalId).finally(() => this.preparing.delete(goalId));
      this.preparing.set(goalId, pending);
    }
    return pending;
  }

  private async prepareIntegration(goalId: string): Promise<Integration> {
    const goal = this.store.get(goalId);
    if (!goal?.config) throw new Error(`Goal ${goalId} has no config`);
    const workspace = await this.workspaces.create({
      cwd: goal.config.cwd,
      isolation: "worktree",
      title: `${goal.title} (integration)`,
      branchName: `${goal.config.branchPrefix ?? DEFAULT_GOAL_BRANCH_PREFIX}/${goalId}`,
      keepBranchName: true,
      ...(goal.config.baseCommit ? { baseRef: goal.config.baseCommit } : {}),
    });
    try {
      const branch = await this.git.currentBranch(workspace.cwd);
      const baseCommit = await this.git.head(workspace.cwd);
      // Worktree setup may have left files behind. The first merge needs a clean tree.
      if (!(await this.git.isClean(workspace.cwd))) {
        await this.git.resetHard({ cwd: workspace.cwd, commit: baseCommit });
      }
      await this.host.dispatch(goalId, {
        id: `${goalId}:integration`,
        goalId,
        type: "integration.prepared",
        branch,
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        baseCommit,
      });
    } catch (error) {
      // Do not strand a worktree nothing refers to.
      await this.host.discard(null, workspace.workspaceId);
      throw error;
    }
    const integration = this.store.get(goalId)?.integration;
    if (!integration) {
      await this.host.discard(null, workspace.workspaceId);
      throw new Error(`Goal ${goalId} ended while preparing integration`);
    }
    return integration;
  }

  // ---- capture -----------------------------------------------------------

  /** Mark a task as awaiting capture before it is reported succeeded, so dependents wait. */
  beginCapture(goalId: string, taskId: string): void {
    this.capturing.add(`${goalId}:${taskId}`);
  }

  endCapture(goalId: string, taskId: string): void {
    this.capturing.delete(`${goalId}:${taskId}`);
  }

  /**
   * Record an implement task's work as a Change Set. Tasks that changed nothing
   * produce none. A rework that adds no commits is a failure: the change it was
   * meant to fix is still broken.
   */
  async capture(input: {
    goalId: string;
    task: Task;
    runId: string;
    workspaceId: string;
    cwd: string;
  }): Promise<void> {
    const { goalId, task, runId } = input;
    const goal = this.store.get(goalId);
    if (!goal?.config) return;
    const integration = await this.ensureIntegration(goalId);
    const captured = await this.git.capture({
      cwd: input.cwd,
      integrationCommit: integration.headCommit,
      message: `Task ${task.id}: ${task.title}`,
    });
    const previous = task.rework
      ? goal.changeSets.find((c) => c.id === task.rework?.changeSetId)
      : undefined;

    if (!captured || (previous && captured.headCommit === previous.headCommit)) {
      if (previous) {
        await this.reject(goalId, previous.id, "Rework added no commits");
        await this.host.failGoal(goalId, `Rework of ${previous.id} changed nothing.`);
        return;
      }
      // Record that nothing changed, so a restart does not mistake this for work never captured.
      await this.host.dispatch(goalId, {
        id: `${runId}:capture-skipped`,
        goalId,
        type: "capture.skipped",
        taskId: task.id,
        runId,
      });
      return;
    }
    await this.host.dispatch(goalId, {
      id: `cs-${runId}:captured`,
      goalId,
      type: "changeset.captured",
      changeSetId: `cs-${runId}`,
      taskId: task.id,
      runId,
      round: task.rework?.round ?? 0,
      supersedes: previous?.id ?? null,
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      branch: captured.branch,
      baseCommit: captured.baseCommit,
      headCommit: captured.headCommit,
      files: captured.files,
    });
  }

  /**
   * True while anything of this goal still runs in this process. A failed goal is
   * reopened only once this is false, so work it left stopping cannot act on it again.
   */
  hasLiveWork(goalId: string): boolean {
    return (
      (this.busy.get(goalId) ?? 0) > 0 ||
      (this.liveAgents.get(goalId)?.size ?? 0) > 0 ||
      this.verifying.has(goalId) ||
      this.preparing.has(goalId) ||
      [...this.capturing].some((key) => key.startsWith(`${goalId}:`))
    );
  }

  /** Track one piece of this goal's work as live until it settles. */
  private hold(goalId: string, work: () => Promise<void>): Promise<void> {
    this.busy.set(goalId, (this.busy.get(goalId) ?? 0) + 1);
    return work().finally(() => {
      const left = (this.busy.get(goalId) ?? 1) - 1;
      if (left > 0) this.busy.set(goalId, left);
      else this.busy.delete(goalId);
    });
  }

  // ---- reactions ---------------------------------------------------------

  onEvent(goal: Goal, event: GoalEvent): void {
    if (event.type === "changeset.captured") {
      this.host.track(this.hold(goal.id, () => this.review(goal.id, event.changeSetId)));
    } else if (event.type === "changeset.transitioned") {
      this.onTransition(goal, event.changeSetId, event.to);
    }
  }

  private onTransition(goal: Goal, changeSetId: string, to: ChangeSetStatus): void {
    if (to === "approved") {
      this.host.track(this.hold(goal.id, () => this.enqueueIntegration(goal.id, changeSetId)));
    } else if (to === "integrated") {
      this.host.requestPump(goal.id);
    } else if (reworkReasonFor(to)) {
      this.host.track(this.hold(goal.id, () => this.requestRework(goal.id, changeSetId)));
    }
  }

  /** Stop everything still running, for a daemon that is shutting down. */
  shutdown(): void {
    this.git.killCommands();
  }

  /** The goal's reviewers and verifier that are running now. */
  liveAgentIds(goalId: string): string[] {
    return [...(this.liveAgents.get(goalId) ?? [])];
  }

  /** The goal ended: stop its reviewers and verifier, and its test command. */
  async abort(goalId: string): Promise<void> {
    this.git.killCommands(goalId);
    const agents = [...(this.liveAgents.get(goalId) ?? [])];
    await Promise.allSettled(agents.map((id) => this.agents.cancel(id)));
  }

  // ---- review ------------------------------------------------------------

  private changeSet(goalId: string, id: string): ChangeSet | undefined {
    return this.store.get(goalId)?.changeSets.find((c) => c.id === id);
  }

  private async transition(
    goalId: string,
    changeSetId: string,
    to: ChangeSetStatus,
    detail: {
      findings?: string;
      testSummary?: string;
      integratedCommit?: string;
      error?: string;
      reason?: string;
    } = {},
  ): Promise<boolean> {
    const seq = this.store.get(goalId)?.lastSeq ?? 0;
    return this.host.dispatch(goalId, {
      id: `${changeSetId}:${to}:${seq}`,
      goalId,
      type: "changeset.transitioned",
      changeSetId,
      to,
      ...detail,
    });
  }

  private async reject(
    goalId: string,
    changeSetId: string,
    error: string,
    reason?: string,
  ): Promise<void> {
    await this.transition(goalId, changeSetId, "rejected", {
      error,
      ...(reason ? { reason } : {}),
    });
  }

  private trackAgent(goalId: string, agentId: string, add: boolean): void {
    const set = this.liveAgents.get(goalId) ?? new Set<string>();
    if (add) set.add(agentId);
    else set.delete(agentId);
    this.liveAgents.set(goalId, set);
  }

  /** Ask an independent agent to judge the change in the author's worktree. */
  private async review(goalId: string, changeSetId: string): Promise<void> {
    try {
      const goal = this.store.get(goalId);
      const cs = this.changeSet(goalId, changeSetId);
      const task = goal?.tasks.find((t) => t.id === cs?.taskId);
      if (!goal?.config || !cs || !task || this.host.isStopped()) return;
      if (cs.status === "captured") {
        if (!(await this.transition(goalId, cs.id, "in_review"))) return;
      } else if (cs.status !== "in_review") {
        return;
      }

      const verdict = await this.askForVerdict(goal, task, cs);
      if (!verdict || this.host.isStopped()) return;
      if (verdict.verdict === "approve") {
        const to = goal.config.requireHumanApproval ? "awaiting_human" : "approved";
        const findings = verdict.findings.join("\n");
        await this.transition(goalId, cs.id, to, findings ? { findings } : {});
        return;
      }
      await this.transition(goalId, cs.id, "changes_requested", {
        findings: verdict.findings.map((f) => `- ${f}`).join("\n"),
      });
    } catch (error) {
      if (this.host.isStopped()) return;
      await this.failReview(goalId, changeSetId, error);
    }
  }

  private async failReview(goalId: string, changeSetId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.reject(goalId, changeSetId, `Review failed: ${message}`);
    await this.host.failGoal(goalId, `Review of ${changeSetId} failed: ${message}`);
  }

  private async askForVerdict(goal: Goal, task: Task, cs: ChangeSet) {
    const config = goal.config;
    if (!config) return null;
    const { agentId, thinking } = await this.agents.createAgent({
      provider: config.reviewProvider ?? config.leadProvider,
      ...thinkingInput(goalRoleThinking(config, "reviewer")),
      permission: goalPermissionPolicy(config),
      cwd: cs.cwd,
      workspaceId: cs.workspaceId,
      title: `Review: ${task.title}`,
      labels: {
        "paseo.goal-id": goal.id,
        "paseo.goal-role": "reviewer",
        "paseo.goal-changeset": cs.id,
      },
    });
    this.trackAgent(goal.id, agentId, true);
    try {
      let prompt = buildReviewPrompt(goal, task, cs);
      let problem = "";
      for (let attempt = 0; attempt < REPLY_ATTEMPTS; attempt += 1) {
        const result = await this.host.runTurn(goal.id, agentId, prompt, {
          role: "reviewer",
          changeSetId: cs.id,
          ...(thinking ? { thinking } : {}),
        });
        if (this.host.isStopped() || this.store.get(goal.id)?.status !== "executing") return null;
        if (result.outcome !== "completed") {
          // A failed turn's error says why, such as a request nobody answered in time.
          throw new Error(`Reviewer did not finish (${turnEnd(result)})`);
        }
        // A reviewer only reads. If it changed the author's worktree, undo that and
        // do not trust the verdict it gave from a changed tree.
        if (!(await this.leftWorktreeAlone(cs))) {
          problem =
            "You changed files or commits in the worktree. A reviewer must not modify anything.";
          prompt = buildReviewCorrectionPrompt(
            `${problem} Your changes were undone; review the original change again.`,
          );
          continue;
        }
        try {
          return parseVerdict(result.text);
        } catch (error) {
          if (!(error instanceof ReplyParseError)) throw error;
          problem = error.message;
          prompt = buildReviewCorrectionPrompt(problem);
        }
      }
      throw new Error(`Reviewer gave no usable verdict: ${problem}`);
    } finally {
      this.trackAgent(goal.id, agentId, false);
      // The reviewer works in the author's worktree: stop the agent, keep the workspace.
      if (!this.host.isStopped()) await this.host.discard(agentId, null);
    }
  }

  /** True if the reviewer left the change exactly as captured; otherwise puts it back. */
  private async leftWorktreeAlone(cs: ChangeSet): Promise<boolean> {
    const untouched =
      (await this.git.head(cs.cwd)) === cs.headCommit && (await this.git.isClean(cs.cwd));
    if (untouched) return true;
    await this.git.resetHard({ cwd: cs.cwd, commit: cs.headCommit });
    return false;
  }

  // ---- integration -------------------------------------------------------

  /** Merge approved sets one at a time, in the order they were approved. */
  private enqueueIntegration(goalId: string, changeSetId: string): Promise<void> {
    const previous = this.integrationQueues.get(goalId) ?? Promise.resolve();
    const run = previous.then(() => this.integrate(goalId, changeSetId));
    this.integrationQueues.set(
      goalId,
      run.catch(() => undefined),
    );
    return run;
  }

  private async integrate(goalId: string, changeSetId: string): Promise<void> {
    const goal = this.store.get(goalId);
    const cs = this.changeSet(goalId, changeSetId);
    if (!goal?.config || !goal.integration || !cs || cs.status !== "approved") return;
    if (this.host.isStopped()) return;
    const { integration } = goal;
    if (!(await this.transition(goalId, cs.id, "integrating"))) return;

    try {
      // Nothing but this pipeline may move the integration branch. If something did
      // (an agent committing to it), put it back before building on it.
      if ((await this.git.head(integration.cwd)) !== integration.headCommit) {
        this.logger.warn(
          { goalId, expected: integration.headCommit },
          "Integration branch moved outside the pipeline; resetting",
        );
        await this.git.resetHard({ cwd: integration.cwd, commit: integration.headCommit });
      }
      const merged = await this.git.merge({
        cwd: integration.cwd,
        commit: cs.headCommit,
        message: `Integrate ${cs.taskId} (${cs.id})`,
      });
      if (!merged.ok) {
        await this.transition(goalId, cs.id, "conflicted", {
          error: `Conflicts in: ${merged.conflicts.join(", ")}`,
        });
        return;
      }
      const testSummary = await this.runTests(goal, integration, merged.headCommit);
      if (testSummary.failed) {
        await this.git.resetHard({ cwd: integration.cwd, commit: integration.headCommit });
        await this.transition(goalId, cs.id, "test_failed", {
          testSummary: testSummary.output,
          error: testSummary.reason,
        });
        return;
      }
      // The test command may have left files or commits behind. Put the branch back
      // to exactly the merge that was tested, so the next merge starts clean.
      await this.git.resetHard({ cwd: integration.cwd, commit: merged.headCommit });
      await this.transition(goalId, cs.id, "integrated", {
        integratedCommit: merged.headCommit,
        ...(testSummary.output ? { testSummary: testSummary.output } : {}),
      });
    } catch (error) {
      if (this.host.isStopped()) return;
      // Leave the branch exactly where it was before this attempt.
      await this.git
        .resetHard({ cwd: integration.cwd, commit: integration.headCommit })
        .catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      await this.transition(goalId, cs.id, "rejected", {
        error: `Integration failed: ${message}`,
        reason: CHANGE_SET_INTEGRATION_FAILED,
      });
      await this.host.failGoal(goalId, `Integrating ${cs.id} failed: ${message}`);
    }
  }

  private async runTests(
    goal: Goal,
    integration: Integration,
    mergedHead: string,
  ): Promise<{ failed: boolean; output: string; reason: string }> {
    const command = goal.config?.testCommand;
    if (!command) return { failed: false, output: "", reason: "" };
    const outcome = await this.git.runCommand({
      cwd: integration.cwd,
      command,
      timeoutMs: this.testTimeoutMs,
      key: goal.id,
    });
    this.logger.debug(
      { goalId: goal.id, mergedHead, exitCode: outcome.exitCode },
      "Test command ran",
    );
    if (outcome.timedOut) {
      return { failed: true, output: outcome.output, reason: `Test command timed out` };
    }
    if (outcome.exitCode !== 0) {
      return {
        failed: true,
        output: outcome.output,
        reason: `Test command exited ${outcome.exitCode}`,
      };
    }
    return { failed: false, output: outcome.output, reason: "" };
  }

  // ---- rework ------------------------------------------------------------

  private async requestRework(goalId: string, changeSetId: string): Promise<void> {
    try {
      const goal = this.store.get(goalId);
      const cs = this.changeSet(goalId, changeSetId);
      const reason = cs ? reworkReasonFor(cs.status) : null;
      if (!goal?.config || !cs || !reason || this.host.isStopped()) return;
      const round = cs.round + 1;
      if (round > (goal.config.maxReworkRounds ?? DEFAULT_MAX_REWORK_ROUNDS)) {
        await this.reject(
          goalId,
          cs.id,
          `Rework limit reached after ${cs.round} rounds`,
          CHANGE_SET_REWORK_LIMIT,
        );
        await this.host.failGoal(
          goalId,
          `Change ${cs.id} still needs ${reason} fixes after ${cs.round} rework rounds.`,
        );
        return;
      }
      const original = goal.tasks.find((t) => t.id === cs.taskId);
      if (!original) return;
      const base = rootTaskId(cs.taskId);
      const added = await this.host.dispatch(goalId, {
        id: `${cs.id}:rework`,
        goalId,
        type: "task.added",
        task: {
          id: `${base}-rw${round}`,
          title: `Rework (${reason}): ${original.title}`,
          description: describeRework(cs, reason),
          kind: "implement",
          dependsOn: [],
          ...(original.provider ? { provider: original.provider } : {}),
          ...(original.thinking ? { thinking: original.thinking } : {}),
        },
        rework: { changeSetId: cs.id, reason, round },
      });
      if (!added) {
        await this.reject(goalId, cs.id, "Rework task could not be added");
        await this.host.failGoal(goalId, `Could not schedule rework of ${cs.id}.`);
      }
    } catch (error) {
      if (this.host.isStopped()) return;
      await this.host.failGoal(
        goalId,
        `Could not schedule rework: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * A rework task failed for good. The change set is rejected as `rework_failed`, which a retry
   * or recovery that reopens the goal reopens, so the rework runs again in the same worktree.
   */
  async reworkFailed(goalId: string, task: Task): Promise<void> {
    if (!task.rework) return;
    const error = task.error ?? "unknown error";
    await this.reject(
      goalId,
      task.rework.changeSetId,
      `Rework ${task.id} failed: ${error}`,
      CHANGE_SET_REWORK_FAILED,
    );
    // `needs_permission` is what the app looks for, as in the Manager's stuck-goal reason.
    const request = isPendingRequestFailure(task.error)
      ? ` Task ${task.id} stopped on a request (needs_permission): ${error}`
      : "";
    // A worker's blocked claim opens the reason, quoted, as in the Manager's stuck-goal reason.
    // It is not retried, so the reason names no attempt count.
    let reason = `Rework ${task.id} failed after ${task.attempts} attempts.${request}`;
    if (isWorkerBlocked(task.error)) {
      reason = `${workerBlockedFailureText(task.id, error)} Rework ${task.id} failed.`;
    } else if (isNoAnswerFailure(task.error)) {
      // Nobody answered in time: not retried either, and the person decides how to go on.
      reason = `Rework ${task.id} failed: nobody answered its request in time; answer sooner or raise userWaitMinutes, then retry. Task ${task.id} stopped on a request (needs_permission): ${error}`;
    }
    await this.host.failGoal(goalId, reason);
  }

  // ---- recovery ----------------------------------------------------------

  /** Pick up change sets a previous process left between steps. */
  async recover(goalId: string): Promise<void> {
    const goal = this.store.get(goalId);
    if (!goal?.config || goal.status !== "executing") return;
    for (const cs of goal.changeSets) {
      if (cs.status === "captured" || cs.status === "in_review") {
        this.host.track(this.hold(goalId, () => this.review(goalId, cs.id)));
      } else if (cs.status === "approved") {
        this.host.track(this.hold(goalId, () => this.enqueueIntegration(goalId, cs.id)));
      } else if (cs.status === "integrating") {
        await this.recoverInterruptedMerge(goal, cs);
      } else if (
        reworkReasonFor(cs.status) &&
        !goal.tasks.some((t) => t.rework?.changeSetId === cs.id)
      ) {
        this.host.track(this.hold(goalId, () => this.requestRework(goalId, cs.id)));
      }
    }
    await this.recaptureMissing(goalId);
  }

  private async recoverInterruptedMerge(goal: Goal, cs: ChangeSet): Promise<void> {
    if (goal.integration) {
      await this.git
        .resetHard({ cwd: goal.integration.cwd, commit: goal.integration.headCommit })
        .catch((error) => this.logger.warn({ err: error, goalId: goal.id }, "Reset failed"));
    }
    await this.transition(goal.id, cs.id, "approved");
  }

  /** A succeeded implement task whose capture never happened is captured now. */
  private async recaptureMissing(goalId: string): Promise<void> {
    const goal = this.store.get(goalId);
    if (!goal) return;
    for (const task of goal.tasks) {
      if (task.kind !== "implement" || task.status !== "succeeded") continue;
      if (task.captured) continue;
      const run = goal.runs.findLast((r) => r.taskId === task.id && r.status === "succeeded");
      const cs = task.rework
        ? goal.changeSets.find((c) => c.id === task.rework?.changeSetId)
        : undefined;
      const workspaceId = run?.workspaceId ?? cs?.workspaceId;
      const cwd = cs?.cwd ?? run?.cwd;
      if (!run || !workspaceId || !cwd) {
        // The work cannot be found, so it cannot be reviewed. Do not let the goal complete without it.
        await this.host.failGoal(goalId, `${WORK_NOT_RECOVERED_PREFIX} ${task.id} for review.`);
        return;
      }
      await this.capture({ goalId, task, runId: run.id, workspaceId, cwd });
    }
  }

  // ---- verification and completion ---------------------------------------

  /**
   * With every change integrated, have an independent agent check each
   * acceptance criterion against the integration branch. The goal completes only
   * when all are met; the reducer independently refuses completion otherwise.
   */
  async verifyAndComplete(goalId: string): Promise<void> {
    if (this.verifying.has(goalId)) return;
    this.verifying.add(goalId);
    try {
      await this.verify(goalId);
    } catch (error) {
      if (!this.host.isStopped()) {
        await this.host.failGoal(
          goalId,
          `Verification failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      this.verifying.delete(goalId);
    }
  }

  private async verify(goalId: string): Promise<void> {
    const goal = this.store.get(goalId);
    if (!goal?.config || goal.status !== "executing") return;
    const pending = goal.criteria.filter((c) => !c.verifiedAt);
    if (pending.length > 0) {
      const unmet = await this.askVerifier(
        goal,
        pending.map((c) => c.id),
      );
      if (unmet === null) return;
      if (unmet.length > 0) {
        await this.host.failGoal(goalId, `${VERIFICATION_NOT_MET_PREFIX} ${unmet.join("; ")}`);
        return;
      }
    }
    if (
      await this.host.dispatch(goalId, {
        id: `${goalId}:completed`,
        goalId,
        type: "goal.completed",
      })
    ) {
      const done = this.store.get(goalId);
      if (done)
        this.host.notifyLeadFinal(
          done,
          "completed. Every task is integrated and every acceptance criterion was verified.",
        );
    }
  }

  /** Returns the unmet criteria as readable lines, or null if the goal ended meanwhile. */
  private async askVerifier(goal: Goal, ids: string[]): Promise<string[] | null> {
    const config = goal.config;
    if (!config) return null;
    // With nothing integrated there is no branch to check, so verify in a throwaway
    // worktree rather than in the user's own checkout.
    const scratch = goal.integration
      ? null
      : await this.workspaces.create({
          cwd: config.cwd,
          isolation: "worktree",
          title: `${goal.title} (verify)`,
          ...(config.baseCommit ? { baseRef: config.baseCommit } : {}),
        });
    const workspace =
      scratch ??
      (goal.integration
        ? { workspaceId: goal.integration.workspaceId, cwd: goal.integration.cwd }
        : null);
    if (!workspace) return null;
    const { agentId, thinking } = await this.agents.createAgent({
      provider: verifierProvider(config),
      ...thinkingInput(goalRoleThinking(config, "verifier")),
      permission: goalPermissionPolicy(config),
      cwd: workspace.cwd,
      workspaceId: workspace.workspaceId,
      title: `Verify: ${goal.title}`,
      labels: { "paseo.goal-id": goal.id, "paseo.goal-role": "verifier" },
    });
    this.trackAgent(goal.id, agentId, true);
    try {
      let prompt = buildVerifyPrompt(goal, goal.integration?.branch ?? null);
      let problem = "";
      for (let attempt = 0; attempt < REPLY_ATTEMPTS; attempt += 1) {
        const result = await this.host.runTurn(goal.id, agentId, prompt, {
          role: "verifier",
          ...(thinking ? { thinking } : {}),
        });
        if (this.host.isStopped() || this.store.get(goal.id)?.status !== "executing") return null;
        if (result.outcome !== "completed") {
          throw new Error(`Verifier did not finish (${turnEnd(result)})`);
        }
        await this.assertUnchanged(goal, workspace.cwd);
        try {
          return await this.recordVerification(goal.id, parseVerification(result.text, ids), goal);
        } catch (error) {
          if (!(error instanceof ReplyParseError)) throw error;
          problem = error.message;
          prompt = buildReviewCorrectionPrompt(problem);
        }
      }
      throw new Error(`Verifier gave no usable answer: ${problem}`);
    } finally {
      this.trackAgent(goal.id, agentId, false);
      if (!this.host.isStopped()) await this.host.discard(agentId, scratch?.workspaceId ?? null);
    }
  }

  /** The verifier may only look. If it changed the integration branch, discard its verdict. */
  private async assertUnchanged(goal: Goal, cwd: string): Promise<void> {
    if (!goal.integration) return;
    const unchanged =
      (await this.git.head(cwd)) === goal.integration.headCommit && (await this.git.isClean(cwd));
    if (unchanged) return;
    await this.git.resetHard({ cwd, commit: goal.integration.headCommit });
    throw new Error("The verifier changed the integration branch, so its verdict was discarded");
  }

  private async recordVerification(
    goalId: string,
    verification: ReturnType<typeof parseVerification>,
    goal: Goal,
  ): Promise<string[]> {
    const unmet: string[] = [];
    for (const answer of verification.criteria) {
      if (!answer.met) {
        const text = goal.criteria.find((c) => c.id === answer.id)?.text ?? answer.id;
        unmet.push(`${text} (${answer.evidence})`);
        continue;
      }
      // A recovery that adds work starts a new round; round 0 keeps the id older logs carry.
      // `goal` is the state the verifier was asked from, so a result from an earlier round is
      // refused rather than counted in a later one.
      const round = goal.verificationRound ?? 0;
      await this.host.dispatch(goalId, {
        id: `${goalId}:verified:${answer.id}${round > 0 ? `:v${round}` : ""}`,
        goalId,
        type: "criterion.verified",
        criterionId: answer.id,
        evidence: answer.evidence,
        round,
      });
    }
    return unmet;
  }
}

/** How a turn that did not complete ended: its outcome, with the error of a failed one. */
function turnEnd(result: TurnResult): string {
  return result.outcome === "failed" ? `failed: ${result.error}` : result.outcome;
}
