import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { diagnoseGoalFailure } from "@getpaseo/protocol/goal/diagnosis";
import {
  MAX_GUIDANCE_CHARS,
  MAX_RECOVERIES,
  RECOVERY_DECISION_MS,
} from "@getpaseo/protocol/goal/interventions";
import type { Goal, GoalConfig } from "@getpaseo/protocol/goal/types";
import type { GoalManager, TurnResult } from "./goal-manager.js";
import { RECOVERY_LABEL } from "./goal-recovery.js";
import type { GoalService } from "./goal-service.js";
import type { GoalStore } from "./goal-store.js";
import { CONFIG, createGoalTestEnv, task, type GoalTestEnv, type Turn } from "./goal-test-env.js";
import { TURN_TIMEOUT_PREFIX } from "./lead-intervention.js";

type TurnInfo = Omit<Turn, "resolve">;

const RECOVERY_PROMPT = "asked you to recover it";

/** The task a worker prompt is about; the test plans title tasks "Task <id>". */
function taskOf(prompt: string): string | null {
  return /Your task \(\w+\): Task (\S+)\n/.exec(prompt)?.[1] ?? null;
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The criterion ids a verifier prompt asks about. */
function askedIds(prompt: string): string[] {
  return [...prompt.matchAll(/^- (\w+): /gm)].map((m) => m[1] ?? "");
}

function isVerifierTurn(turn: { prompt: string }): boolean {
  return turn.prompt.includes("You are the verifier");
}

/** A verifier's answer: every asked criterion met except `unmet`. */
function verdicts(ids: readonly string[], unmet: readonly string[]) {
  return ids.map((id) => ({ id, met: !unmet.includes(id), evidence: `checked ${id} again` }));
}

interface Booted {
  store: GoalStore;
  manager: GoalManager;
  service: GoalService;
}

interface RecoveryScript {
  plan: unknown[];
  /** A worker's turn about `taskId`; completed when absent. */
  work?: (taskId: string, turn: TurnInfo) => TurnResult | "hold";
  /** The recovery Lead's turns, the decision and any correction. */
  recover: (turn: TurnInfo) => TurnResult | "hold";
}

describe("recovering a failed goal through its Lead", () => {
  let env: GoalTestEnv;
  /** Every prompt the recovery Leads were given, in order. */
  let recoveryPrompts: TurnInfo[];
  /** Every worker prompt, by task. */
  let workerPrompts: Map<string, string[]>;

  beforeEach(async () => {
    env = createGoalTestEnv();
    // Event times follow the fake clock, so the time limit can pass without waiting.
    env.logOptions.now = () => new Date(env.clock.now()).toISOString();
    await env.init();
    recoveryPrompts = [];
    workerPrompts = new Map();
  });
  afterEach(() => env.cleanup());

  function scriptRecovery(script: RecoveryScript): void {
    env.script(script.plan, (turn) => {
      const taskId = taskOf(turn.prompt);
      if (taskId) workerPrompts.set(taskId, [...(workerPrompts.get(taskId) ?? []), turn.prompt]);
      return taskId && script.work
        ? script.work(taskId, turn)
        : { outcome: "completed", text: "done" };
    });
    const base = env.harness.respond;
    const recoveryLeads = new Set<string>();
    env.harness.respond = (turn) => {
      if (turn.prompt.includes(RECOVERY_PROMPT)) recoveryLeads.add(turn.agentId);
      if (!recoveryLeads.has(turn.agentId)) return base?.(turn) ?? "hold";
      recoveryPrompts.push(turn);
      return script.recover(turn);
    };
  }

  const reply = (decision: Record<string, unknown>): TurnResult => ({
    outcome: "completed",
    text: env.fenced(JSON.stringify(decision)),
  });

  async function boot(): Promise<Booted> {
    const booted = await env.boot();
    booted.service.attachActivityProbe(booted.manager);
    return booted;
  }

  async function failedGoal(config: GoalConfig, booted: Booted): Promise<Goal> {
    await env.createGoal(booted.store, config);
    await env.settle(booted.manager);
    const goal = env.goalOf(booted.store);
    expect(goal.status).toBe("failed");
    return goal;
  }

  const recoveryLead = (store: GoalStore) => {
    const agentId = env.goalOf(store).recovery?.leadAgentId;
    const agent = env.harness.agents.find((a) => a.agentId === agentId);
    if (!agent) throw new Error("no recovery Lead");
    return agent;
  };

  test("a goal stopped by a question and past its time limit is recovered fresh with the person's guidance and the Lead's hint", async () => {
    // b195cf6f: t3 stopped on a hook's question every time, t5 and t6 waited on it, and the
    // time limit passed while the goal sat failed.
    scriptRecovery({
      plan: [
        task("t1"),
        task("t2"),
        task("t3"),
        task("t4"),
        task("t5", { dependsOn: ["t3"] }),
        task("t6", { dependsOn: ["t3"] }),
      ],
      work: (taskId, turn) =>
        taskId === "t3" && !turn.prompt.includes("answer the hook with yes")
          ? {
              outcome: "needs_permission",
              request: { kind: "question", tool: "request_user_input", text: "Trust this folder?" },
            }
          : { outcome: "completed", text: `${taskId} done` },
      recover: () =>
        reply({
          decision: "retry",
          reason: "t3 stopped on the hook's question; the person said how to answer it",
          hints: { t3: "The trust prompt comes from a user hook; answer it and carry on." },
        }),
    });
    const booted = await boot();
    const { store, manager, service } = booted;
    const failed = await failedGoal(
      {
        ...CONFIG,
        onPermissionRequest: "fail",
        originAgentId: "chat-1",
        limits: { retryBackoffSeconds: 0, goalTimeoutMinutes: 60 },
      },
      booted,
    );
    expect(failed.failureReason).toMatch(/Task t3 stopped on a request \(needs_permission\)/);
    expect(failed.tasks.map((t) => [t.id, t.status])).toEqual([
      ["t1", "succeeded"],
      ["t2", "succeeded"],
      ["t3", "failed"],
      ["t4", "succeeded"],
      ["t5", "pending"],
      ["t6", "pending"],
    ]);

    env.clock.advance(2 * 60 * 60_000);
    const guidance = { tasks: { t3: "answer the hook with yes" } };
    await expect(service.startRecovery("g1", guidance)).rejects.toThrow(/time limit has passed/);
    const started = await service.startRecovery("g1", { ...guidance, timeMode: "fresh" }, "rec-1");
    // A resend with the same eventId starts nothing more.
    await service.startRecovery("g1", { ...guidance, timeMode: "fresh" }, "rec-1");
    expect(started.recovery).toMatchObject({ status: "deciding", startedBy: "person" });
    expect(started.guidance).toEqual({ tasks: { t3: "answer the hook with yes" } });
    await env.settle(manager);

    const goal = env.goalOf(store);
    expect(goal.status).toBe("completed");
    expect(goal.recoveries).toBe(1);
    expect(goal.recovery).toMatchObject({ outcome: "applied", decision: { decision: "retry" } });
    // The recovery Lead was asked with the person's instruction and the diagnosis of t3.
    expect(recoveryPrompts).toHaveLength(1);
    expect(recoveryPrompts[0]?.prompt).toContain("For task t3: answer the hook with yes");
    expect(recoveryPrompts[0]?.prompt).toContain('"cause": "pending_request"');
    // It is a fresh Lead, labelled with the recovery, at the integration head.
    const lead = recoveryLead(store);
    expect(lead.labels).toMatchObject({
      "paseo.goal-role": "lead",
      [RECOVERY_LABEL]: goal.recovery?.id,
    });
    expect(lead.agentId).not.toBe(failed.leadAgentId);
    // t3 ran again with the person's instruction and the Lead's advice, framed as such.
    const t3 = workerPrompts.get("t3")?.at(-1) ?? "";
    expect(t3).toContain(
      "Instruction from the person for this task (authoritative):\nanswer the hook with yes",
    );
    expect(t3).toContain("Advice from the goal's Lead (another agent)");
    expect(t3).toContain("The trust prompt comes from a user hook");
    const events = await env.readEvents();
    const applied = events.find((e) => e.type === "recovery.resolved" && e.outcome === "applied");
    expect(applied).toMatchObject({ timeMode: "fresh" });
    expect(applied).not.toHaveProperty("activeMs");
    // The clock restarted when the recovery applied, not when it started.
    expect(goal.timeBaseAt).toBe(applied?.at);
    expect(goal.runs.filter((r) => r.taskId === "t3").map((r) => r.status)).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(goal.tasks.every((t) => t.status === "succeeded")).toBe(true);
  });

  const SPLIT_PLAN = [
    task("t1"),
    task("t2"),
    task("t3"),
    task("t4"),
    task("t5"),
    task("t6"),
    task("t7"),
    task("t8", { dependsOn: ["t7"] }),
    task("t9", { dependsOn: ["t8"] }),
    task("t10", { dependsOn: ["t9"] }),
  ];
  const SPLIT = {
    decision: "revise",
    reason: "t7 is too large for one run; split it",
    ops: [
      { op: "remove", taskId: "t7" },
      { op: "add", task: task("t7a") },
      { op: "add", task: task("t7b", { dependsOn: ["t7a"] }) },
      { op: "replace", task: task("t8", { dependsOn: ["t7b"] }) },
    ],
  };

  /** aff07ea6: t7 timed out on every attempt and t8 to t10 waited on it. */
  async function timedOutGoal(
    config: Partial<GoalConfig> = {},
  ): Promise<Booted & { failed: Goal }> {
    scriptRecovery({
      plan: SPLIT_PLAN,
      work: (taskId) =>
        taskId === "t7"
          ? { outcome: "failed", error: `${TURN_TIMEOUT_PREFIX} 90 minutes` }
          : { outcome: "completed", text: `${taskId} done` },
      recover: () => reply(SPLIT),
    });
    const booted = await boot();
    await env.createGoal(booted.store, { ...CONFIG, maxAttempts: 3, ...config });
    await env.settle(booted.manager);
    if (env.goalOf(booted.store).status === "awaiting_plan_approval") {
      await booted.service.approvePlan("g1");
      await env.settle(booted.manager);
    }
    const failed = env.goalOf(booted.store);
    expect(failed.status).toBe("failed");
    expect(failed.runs.filter((r) => r.taskId === "t7").map((r) => r.status)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
    return { ...booted, failed };
  }

  function expectSplitCompleted(goal: Goal, failed: Goal): void {
    expect(goal.status).toBe("completed");
    expect(goal.tasks.map((t) => t.id)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
      "t6",
      "t8",
      "t9",
      "t10",
      "t7a",
      "t7b",
    ]);
    expect(goal.tasks.every((t) => t.status === "succeeded")).toBe(true);
    // The revise is recorded as the Lead's plan revision under the recovery's id.
    expect(goal.planRevisions).toEqual([
      expect.objectContaining({
        id: goal.recovery?.id,
        source: "lead",
        status: "applied",
        interventionId: `recovery-${goal.recovery?.id}`,
      }),
    ]);
    // Work went on in the same integration worktree, from where it stood.
    expect(goal.integration?.branch).toBe(failed.integration?.branch);
    expect(goal.integration?.workspaceId).toBe(failed.integration?.workspaceId);
    const merged = goal.changeSets.filter((c) => c.status === "integrated").map((c) => c.taskId);
    expect(merged).toEqual(expect.arrayContaining(["t1", "t6", "t7a", "t7b", "t10"]));
    expect(goal.recoveries).toBe(1);
  }

  test("a goal whose task timed out three times is split by the Lead and completes on the same integration branch", async () => {
    const { store, manager, service, failed } = await timedOutGoal();
    await service.startRecovery("g1", {
      prompt: "Use screenshots to check the UI.",
      timeMode: "fresh",
    });
    await env.settle(manager);
    const goal = env.goalOf(store);
    expectSplitCompleted(goal, failed);
    expect(recoveryPrompts[0]?.prompt).toContain(
      "Instruction from the person (authoritative):\nUse screenshots to check the UI.",
    );
    expect(recoveryPrompts[0]?.prompt).toContain('"cause": "timeout"');
    // The person's instruction reached the new tasks' workers.
    expect(workerPrompts.get("t7a")?.[0]).toContain("Use screenshots to check the UI.");
  });

  test("without autoApprovePlan the Lead's split waits for the person, who approves it", async () => {
    const { store, manager, service, failed } = await timedOutGoal({ autoApprovePlan: false });
    const started = await service.startRecovery("g1", { timeMode: "fresh" });
    const recoveryId = started.recovery?.id ?? "";
    await until(
      () => env.goalOf(store).recovery?.status === "awaiting_approval",
      "the split to wait for approval",
    );
    const waiting = env.goalOf(store);
    expect(waiting.status).toBe("failed");
    expect(waiting.recovery?.decision?.ops).toHaveLength(4);
    // Nothing runs until the person decides.
    expect(waiting.tasks.find((t) => t.id === "t7a")).toBeUndefined();

    await expect(
      service.decideRecovery("g1", { recoveryId: "nope", approve: true }),
    ).rejects.toThrow(/Recovery nope not found/);
    await service.decideRecovery("g1", { recoveryId, approve: true }, "approve-1");
    await service.decideRecovery("g1", { recoveryId, approve: true }, "approve-1");
    await env.settle(manager);
    expectSplitCompleted(env.goalOf(store), failed);
  });

  test("a person who rejects the split leaves the goal failed, and the decision counts", async () => {
    const { store, manager, service } = await timedOutGoal({ autoApprovePlan: false });
    const started = await service.startRecovery("g1", { timeMode: "fresh" });
    await until(() => env.goalOf(store).recovery?.status === "awaiting_approval", "approval");
    const lead = recoveryLead(store);
    await service.decideRecovery("g1", {
      recoveryId: started.recovery?.id ?? "",
      approve: false,
      message: "split it differently",
    });
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.status).toBe("failed");
    expect(goal.failureReason).toBe("Recovery rejected: split it differently");
    expect(goal.recovery).toMatchObject({ status: "ended", outcome: "rejected" });
    expect(goal.recoveries).toBe(1);
    expect(env.harness.canceled).toContain(lead.agentId);
    expect(env.harness.archived).toContain(lead.workspaceId);
  });

  const RETRY = { decision: "retry", reason: "a failed on a flaky dependency; run it again" };
  const answerRetry = () => reply(RETRY);
  const isRecoveryLead = (agent: { labels: Record<string, string> }) =>
    agent.labels[RECOVERY_LABEL] !== undefined;

  /**
   * m succeeds and is merged; a fails until `fix` is called, which leaves b blocked, so the goal
   * fails with an integration worktree in place.
   */
  async function stuckGoal(
    config: GoalConfig,
    recover: RecoveryScript["recover"],
  ): Promise<Booted & { failed: Goal; fix(): void }> {
    let fixed = false;
    scriptRecovery({
      plan: [task("m"), task("a"), task("b", { dependsOn: ["a"] })],
      work: (taskId) =>
        taskId === "a" && !fixed
          ? { outcome: "failed", error: "boom" }
          : { outcome: "completed", text: `${taskId} done` },
      recover,
    });
    const booted = await boot();
    const failed = await failedGoal(config, booted);
    expect(failed.integration).toBeTruthy();
    return {
      ...booted,
      failed,
      fix: () => {
        fixed = true;
      },
    };
  }

  for (const [first, how] of [
    ["needs_person", "a recovery that ended for a person, then a plain retry"],
    ["retry", "an applied recovery"],
  ] as const) {
    test(`after ${how}, a new failure is diagnosed and recovered from its own reason`, async () => {
      // a fails with a worker error, then, once retried, on a question nobody can answer.
      let asking = false;
      let decision: Record<string, unknown> =
        first === "retry" ? RETRY : { decision: "needs_person", reason: "check the flake" };
      scriptRecovery({
        plan: [task("m"), task("a"), task("b", { dependsOn: ["a"] })],
        work: (taskId) => {
          if (taskId !== "a") return { outcome: "completed", text: `${taskId} done` };
          return asking
            ? {
                outcome: "needs_permission",
                request: { kind: "question", tool: "ask", text: "Why?" },
              }
            : { outcome: "failed", error: "boom" };
        },
        recover: () => reply(decision),
      });
      const booted = await boot();
      const { store, manager, service } = booted;
      const original = await failedGoal({ ...CONFIG, onPermissionRequest: "fail" }, booted);
      // Each failure happens at its own time, as on a real clock.
      env.clock.advance(60_000);
      await service.startRecovery("g1", {});
      asking = true;
      await env.settle(manager);
      if (first === "needs_person") {
        expect(env.goalOf(store).recovery).toMatchObject({
          status: "ended",
          outcome: "needs_person",
        });
        env.clock.advance(60_000);
        await service.retry("g1", undefined);
        await env.settle(manager);
      }
      const again = env.goalOf(store);
      expect(again.status).toBe("failed");
      expect(again.failureReason).toMatch(/Task a stopped on a request \(needs_permission\)/);
      expect(again.failureReason).not.toBe(original.failureReason);
      const diagnosis = diagnoseGoalFailure(again, { now: env.clock.now() });
      expect(diagnosis.failureReason).toBe(again.failureReason);
      expect(diagnosis.failedAt).toBe(again.failedAt);
      decision = { decision: "needs_person", reason: "answer the question" };
      const next = await service.startRecovery("g1", {});
      expect(next.recovery).toMatchObject({
        status: "deciding",
        failureReason: again.failureReason,
        failedAt: again.failedAt,
      });
      await env.settle(manager);
      // That recovery ended for a person: the cause it reports is still the question.
      const ended = env.goalOf(store);
      expect(ended.failureReason).toBe("Recovery needs a person: answer the question");
      expect(diagnoseGoalFailure(ended, { now: env.clock.now() }).failureReason).toBe(
        again.failureReason,
      );
    });
  }

  test("a dismissed goal whose recovery ends without applying asks for attention again and can be dismissed again", async () => {
    const { store, manager, service } = await stuckGoal(CONFIG, () =>
      reply({ decision: "needs_person", reason: "raise limits.maxRuns to 40" }),
    );
    await service.acknowledge("g1");
    expect(env.goalOf(store).acknowledgedAt).toBeTruthy();
    await service.startRecovery("g1", {});
    await env.settle(manager);
    const ended = env.goalOf(store);
    expect(ended.recovery).toMatchObject({ status: "ended", outcome: "needs_person" });
    expect(ended.acknowledgedAt).toBeNull();
    await service.acknowledge("g1", "ack-2");
    expect(env.goalOf(store).acknowledgedAt).toBeTruthy();
    const acks = (await env.readEvents()).filter((e) => e.type === "goal.acknowledged");
    expect(acks).toHaveLength(2);
  });

  test("a Lead that answers needs_person ends the recovery: the chat is told, the Lead is released, nothing stays armed", async () => {
    const { store, manager, service } = await stuckGoal(
      { ...CONFIG, originAgentId: "chat-1" },
      () => reply({ decision: "needs_person", reason: "raise limits.maxRuns to 40" }),
    );
    await service.startRecovery("g1", { prompt: "try again" });
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.status).toBe("failed");
    expect(goal.failureReason).toBe("Recovery needs a person: raise limits.maxRuns to 40");
    expect(goal.recovery).toMatchObject({
      status: "ended",
      outcome: "needs_person",
      counted: true,
    });
    expect(goal.recoveries).toBe(1);
    const lead = recoveryLead(store);
    expect(env.harness.canceled).toContain(lead.agentId);
    expect(env.harness.archived).toContain(lead.workspaceId);
    const toChat = env.harness.notified.filter((n) => n.agentId === "chat-1").map((n) => n.text);
    expect(toChat.at(-1)).toContain(
      "recovery ended: Recovery needs a person: raise limits.maxRuns to 40",
    );
    // Nothing is left armed: two days later the goal has recorded nothing more.
    const recorded = (await env.readEvents()).length;
    env.clock.advance(2 * 24 * 60 * 60_000);
    await env.settle(manager);
    expect(await env.readEvents()).toHaveLength(recorded);
  });

  test("a Lead that does not decide in time is replaced by a retry with the person's instruction only, not counted", async () => {
    const { store, manager, service, fix } = await stuckGoal(CONFIG, () => "hold");
    fix();
    await service.startRecovery("g1", { prompt: "PERSON-ONLY: the flake is fixed" });
    await until(() => recoveryPrompts.length === 1, "the recovery Lead's turn");
    env.clock.advance(RECOVERY_DECISION_MS);
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.status).toBe("completed");
    expect(goal.recoveries ?? 0).toBe(0);
    expect(goal.recovery?.decision).toMatchObject({ decision: "retry", fallback: true });
    expect(goal.recovery?.decision?.reason).toMatch(/did not decide within 20 minutes/);
    const prompt = workerPrompts.get("a")?.at(-1) ?? "";
    expect(prompt).toContain("PERSON-ONLY: the flake is fixed");
    expect(prompt).not.toContain("Advice from the goal's Lead");
  });

  test("a recovery Lead that cannot be started is a retry with the person's instruction only, not counted", async () => {
    const { store, manager, service, fix } = await stuckGoal(CONFIG, () => reply(RETRY));
    fix();
    env.harness.failNextCreate = new Error("provider down");
    const workspaces = env.harness.workspaces.length;
    await service.startRecovery("g1", {});
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.status).toBe("completed");
    expect(goal.recoveries ?? 0).toBe(0);
    expect(goal.recovery?.decision?.reason).toMatch(/could not be started \(provider down\)/);
    expect(recoveryPrompts).toEqual([]);
    // The worktree made for it is not stranded.
    expect(env.harness.archived).toContain(env.harness.workspaces[workspaces]?.workspaceId);
  });

  test("a person cancels a recovery while its Lead decides; the Lead is stopped and nothing counts", async () => {
    const { store, manager, service } = await stuckGoal(CONFIG, () => "hold");
    const started = await service.startRecovery("g1", {});
    const recoveryId = started.recovery?.id ?? "";
    await until(() => recoveryPrompts.length === 1, "the recovery Lead's turn");
    const lead = recoveryLead(store);
    await service.cancelRecovery("g1", { recoveryId }, "cancel-1");
    await service.cancelRecovery("g1", { recoveryId }, "cancel-1");
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.status).toBe("failed");
    expect(goal.failureReason).toBe("Recovery cancelled");
    expect(goal.recovery).toMatchObject({ status: "ended", outcome: "cancelled" });
    expect(goal.recoveries ?? 0).toBe(0);
    expect(goal.interventions?.at(-1)).toMatchObject({ status: "abandoned" });
    expect(env.harness.canceled).toContain(lead.agentId);
    expect(env.harness.archived).toContain(lead.workspaceId);
    await expect(service.cancelRecovery("g1", { recoveryId })).rejects.toThrow(
      /already ended \(cancelled\); there is nothing to cancel/,
    );
  });

  test("a person cancels a split waiting for approval; the Lead's decision does not count", async () => {
    const { store, manager, service } = await timedOutGoal({ autoApprovePlan: false });
    const started = await service.startRecovery("g1", { timeMode: "fresh" });
    await until(() => env.goalOf(store).recovery?.status === "awaiting_approval", "approval");
    // Delete and retry would race the recovery; both say how to stop it.
    await expect(service.delete("g1")).rejects.toThrow(
      /is waiting for approval; cancel the recovery first: paseo goal recover g1 --cancel/,
    );
    await expect(service.retry("g1", undefined)).rejects.toThrow(/cancel the recovery first/);
    await expect(service.startRecovery("g1", {})).rejects.toThrow(/cancel the recovery first/);
    await service.cancelRecovery("g1", { recoveryId: started.recovery?.id ?? "" });
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.recovery).toMatchObject({ status: "ended", outcome: "cancelled", counted: true });
    expect(goal.recoveries ?? 0).toBe(0);
    // Once it ended the goal can be deleted.
    await expect(service.delete("g1")).resolves.toMatchObject({ deleted: true });
  });

  test("a recovery being applied cannot be cancelled", async () => {
    let gated = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store, manager, service, fix } = await stuckGoal(CONFIG, () => {
      // The integration check of the apply waits until the test has tried to cancel.
      gated = true;
      return reply(RETRY);
    });
    fix();
    const git = env.harness.git;
    const head = git.head.bind(git);
    git.head = async (cwd?: string) => {
      if (gated) await gate;
      return head(cwd);
    };
    const started = await service.startRecovery("g1", {});
    await until(() => env.goalOf(store).recovery?.status === "decided", "the decision");
    await expect(
      service.cancelRecovery("g1", { recoveryId: started.recovery?.id ?? "" }),
    ).rejects.toThrow(/the recovery is being applied; cancel the goal after it reopens/);
    release();
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
  });

  test("recover right after a failure: the earlier cleanup stops the old Lead, never the recovery's", async () => {
    let fixed = false;
    scriptRecovery({
      plan: [task("m"), task("a"), task("b", { dependsOn: ["a"] })],
      work: (taskId) =>
        taskId === "a" && !fixed
          ? { outcome: "failed", error: "boom" }
          : { outcome: "completed", text: `${taskId} done` },
      recover: () => "hold",
    });
    const { store, manager, service } = await boot();
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    // From the failure on, cancels are slow: the failure's cleanup is still running below.
    store.subscribe((_goal, event) => {
      if (event.type === "goal.failed") env.harness.cancelHold = hold;
    });
    await env.createGoal(store, CONFIG);
    await until(() => env.goalOf(store).status === "failed", "the failure");
    const failed = env.goalOf(store);
    const oldLead = failed.leadAgentId as string;
    const oldWorkspace = failed.leadWorkspaceId as string;
    await until(() => env.harness.canceled.includes(oldLead), "the old Lead's cancel");

    fixed = true;
    await service.startRecovery("g1", {});
    await until(() => recoveryPrompts.length === 1, "the recovery Lead's turn");
    const lead = recoveryLead(store);
    expect(env.goalOf(store).leadAgentId).toBe(lead.agentId);
    // The failure's cleanup finishes only now, when the goal already has its new Lead.
    env.harness.cancelHold = null;
    release();
    await until(() => env.harness.archived.includes(oldWorkspace), "the old Lead's worktree");
    const turn = env.harness.turns.find((t) => t.agentId === lead.agentId);
    turn?.resolve(reply(RETRY));
    await env.settle(manager);

    expect(env.goalOf(store).status).toBe("completed");
    expect(env.harness.canceled).not.toContain(lead.agentId);
    expect(env.harness.archived).not.toContain(lead.workspaceId);
  });

  test("a recovery Lead under the wait policy waits for a person on a request instead of failing", async () => {
    const { store, manager, service } = await stuckGoal(
      { ...CONFIG, onPermissionRequest: "wait" },
      () => "hold",
    );
    const started = await service.startRecovery("g1", {});
    await until(() => recoveryPrompts.length === 1, "the recovery Lead's turn");
    const permission = env.harness.permissions.get(recoveryLead(store).agentId);
    const read = () => (typeof permission === "function" ? permission() : permission);
    expect(read()).toBe("wait");
    await service.cancelRecovery("g1", { recoveryId: started.recovery?.id ?? "" });
    await env.settle(manager);
    // Once the recovery ended, a request still waiting ends the turn.
    expect(read()).toBe("fail");
  });

  test("the recovery Lead's usage over a budget ends the recovery for a person, not counted", async () => {
    const { store, manager, service } = await stuckGoal(
      { ...CONFIG, limits: { retryBackoffSeconds: 0, maxTotalTokens: 1000 } },
      () => ({ ...reply(RETRY), usage: { inputTokens: 2500 } }),
    );
    await service.startRecovery("g1", {});
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.status).toBe("failed");
    expect(goal.recovery).toMatchObject({ status: "ended", outcome: "needs_person" });
    expect(goal.recovery?.decision).toMatchObject({ decision: "needs_person", fallback: true });
    expect(goal.recoveries ?? 0).toBe(0);
    expect(goal.failureReason).toMatch(
      /^Recovery needs a person: Token budget of 1000 reached .*Raise the budget with paseo goal config g1/,
    );
    const decided = (await env.readEvents()).filter((e) => e.type === "recovery.decided");
    expect(decided).toHaveLength(1);
  });

  const cases: [
    string,
    (cwd: string) => void,
    (cwd: string, head: string, branch: string) => string[],
  ][] = [
    [
      "dirty tracked files",
      (cwd) => env.harness.git.tracked.set(cwd, " M src/app.ts"),
      (cwd) => [
        `The integration worktree ${cwd} has uncommitted changes to tracked files:\n M src/app.ts\n`,
        `put them aside with git -C ${cwd} stash, then recover again.`,
      ],
    ],
    [
      "a missing worktree",
      (cwd) => env.harness.git.missing.add(cwd),
      (cwd, head, branch) => [
        `The integration worktree ${cwd} is missing.`,
        `git -C /repo worktree add ${cwd} ${branch}`,
        `rev-parse HEAD prints ${head}`,
      ],
    ],
    [
      "a head that moved",
      (cwd) => env.harness.git.heads.set(cwd, "elsewhere"),
      (cwd, head, branch) => [
        `The integration worktree ${cwd} is at elsewhere, but the goal recorded ${head} on ${branch}`,
        `git -C ${cwd} reset --hard ${head}`,
      ],
    ],
  ];
  for (const [name, breakIt, texts] of cases) {
    test(`the integration check: ${name} refuses the start, and ends a recovery the daemon resumes for a person, uncounted`, async () => {
      const { store, manager, service, failed } = await stuckGoal(CONFIG, answerRetry);
      const integration = failed.integration as NonNullable<Goal["integration"]>;
      breakIt(integration.cwd);
      const expected = texts(integration.cwd, integration.headCommit, integration.branch);
      // The service refuses before recording anything: no recovery, nothing counted.
      const refusal = service.startRecovery("g1", {});
      for (const text of expected) await expect(refusal).rejects.toThrow(text);
      expect(env.goalOf(store).recovery).toBeUndefined();
      // A recovery recorded anyway (the worktree broke after the check, or before a restart)
      // is checked by the daemon before its Lead is created.
      await store.dispatch("g1", {
        id: "g1:recovery:direct",
        goalId: "g1",
        type: "recovery.started",
        recoveryId: "rec-direct",
        startedBy: "person",
      });
      await env.settle(manager);
      const goal = env.goalOf(store);
      expect(goal.status).toBe("failed");
      expect(goal.recovery).toMatchObject({ status: "ended", outcome: "needs_person" });
      expect(goal.recoveries ?? 0).toBe(0);
      for (const text of expected) expect(goal.failureReason).toContain(text);
      // No Lead was started for it.
      expect(env.harness.agents.some(isRecoveryLead)).toBe(false);
    });
  }

  test("an approval whose integration check fails ends the recovery for a person, uncounted", async () => {
    const { store, manager, service, failed } = await timedOutGoal({ autoApprovePlan: false });
    const started = await service.startRecovery("g1", { timeMode: "fresh" });
    await until(() => env.goalOf(store).recovery?.status === "awaiting_approval", "approval");
    const cwd = failed.integration?.cwd as string;
    env.harness.git.tracked.set(cwd, " M package.json");
    const decided = await service.decideRecovery("g1", {
      recoveryId: started.recovery?.id ?? "",
      approve: true,
    });
    expect(decided.recovery).toMatchObject({
      status: "ended",
      outcome: "needs_person",
      counted: true,
    });
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.recoveries ?? 0).toBe(0);
    expect(goal.failureReason).toContain(`git -C ${cwd} stash`);
    expect(goal.tasks.find((t) => t.id === "t7a")).toBeUndefined();
  });

  /**
   * a's change set gets a review asking for changes; its rework fails until `fix` is called, so
   * the change set is rejected as `rework_failed` and the goal fails.
   */
  async function reworkFailedGoal(
    config: Partial<GoalConfig>,
    recover: RecoveryScript["recover"],
  ): Promise<Booted & { failed: Goal; fix(): void }> {
    let fixed = false;
    scriptRecovery({ plan: [task("a")], recover });
    const base = env.harness.respond;
    env.harness.respond = (turn) =>
      turn.prompt.includes("You are fixing your earlier work") && !fixed
        ? { outcome: "failed", error: "cannot fix" }
        : (base?.(turn) ?? "hold");
    let reviews = 0;
    env.stageReplies.review = () => {
      reviews += 1;
      const verdict =
        reviews === 1
          ? { verdict: "request_changes", findings: ["wrong"] }
          : { verdict: "approve", findings: [] };
      return { outcome: "completed", text: env.fenced(JSON.stringify(verdict)) };
    };
    const booted = await boot();
    const failed = await failedGoal({ ...CONFIG, ...config }, booted);
    expect(failed.changeSets[0]).toMatchObject({ id: "cs-a-a1", rejectionReason: "rework_failed" });
    return {
      ...booted,
      failed,
      fix: () => {
        fixed = true;
      },
    };
  }

  test("an applied recovery reworks a change set whose rework failed, and the goal completes", async () => {
    const { store, manager, service, fix } = await reworkFailedGoal({}, answerRetry);
    fix();
    await service.startRecovery("g1", {});
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.status).toBe("completed");
    expect(goal.changeSets.map((c) => c.status)).toEqual(["superseded", "integrated"]);
    const applied = (await env.readEvents()).find(
      (e) => e.type === "recovery.resolved" && e.outcome === "applied",
    );
    expect(applied).toMatchObject({ reworkChangeSetIds: ["cs-a-a1"] });
  });

  test("a rework worktree gone before the decision applies ends the recovery for a person, uncounted", async () => {
    let cwd = "";
    const { store, manager, service, failed } = await reworkFailedGoal({}, () => {
      // Archived while the Lead decided: the start's check passed, the apply's does not.
      env.harness.git.missing.add(cwd);
      return answerRetry();
    });
    cwd = failed.changeSets[0]?.cwd ?? "";
    await service.startRecovery("g1", {});
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.status).toBe("failed");
    expect(goal.recovery).toMatchObject({ status: "ended", outcome: "needs_person" });
    expect(goal.recoveries ?? 0).toBe(0);
    expect(goal.failureReason).toContain(`The rework worktree ${cwd} of cs-a-a1 is gone`);
    expect(goal.failureReason).toContain(`Its work is on branch ${failed.changeSets[0]?.branch}`);
  });

  test("an approval whose rework worktree is gone ends the recovery for a person, uncounted", async () => {
    const addCheck = {
      decision: "revise",
      reason: "add a check before the rework runs again",
      ops: [{ op: "add", task: task("extra") }],
    };
    const { store, manager, service, failed } = await reworkFailedGoal({}, () => reply(addCheck));
    // The Lead's plan change now waits for the person.
    await service.updateConfig("g1", { autoApprovePlan: false });
    const started = await service.startRecovery("g1", {});
    await until(() => env.goalOf(store).recovery?.status === "awaiting_approval", "approval");
    const cwd = failed.changeSets[0]?.cwd ?? "";
    env.harness.git.missing.add(cwd);
    const decided = await service.decideRecovery("g1", {
      recoveryId: started.recovery?.id ?? "",
      approve: true,
    });
    expect(decided.recovery).toMatchObject({ status: "ended", outcome: "needs_person" });
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.recoveries ?? 0).toBe(0);
    expect(goal.failureReason).toContain(`The rework worktree ${cwd} of cs-a-a1 is gone`);
    expect(goal.tasks.find((t) => t.id === "extra")).toBeUndefined();
  });

  test("a run limit a person lowered while the split waited refuses the approval without counting it", async () => {
    const { store, manager, service, failed } = await timedOutGoal({ autoApprovePlan: false });
    const started = await service.startRecovery("g1", { timeMode: "fresh" });
    await until(() => env.goalOf(store).recovery?.status === "awaiting_approval", "approval");
    await service.updateConfig("g1", { limits: { maxRuns: failed.runs.length } });
    const decided = await service.decideRecovery("g1", {
      recoveryId: started.recovery?.id ?? "",
      approve: true,
    });
    expect(decided.recovery).toMatchObject({ status: "ended", outcome: "needs_person" });
    expect(decided.failureReason).toMatch(/run limit of \d+ is used up/);
    await env.settle(manager);
    expect(env.goalOf(store).recoveries ?? 0).toBe(0);
  });

  test("an answer the Lead gives after the person cancelled is dropped", async () => {
    const { store, manager, service } = await stuckGoal(CONFIG, () => "hold");
    const started = await service.startRecovery("g1", {});
    await until(() => recoveryPrompts.length === 1, "the recovery Lead's turn");
    const lead = recoveryLead(store);
    env.harness.ignoreCancel = true;
    await service.cancelRecovery("g1", { recoveryId: started.recovery?.id ?? "" });
    // The provider ignored the cancel and answers anyway.
    env.harness.turns.find((t) => t.agentId === lead.agentId)?.resolve(answerRetry());
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.recovery).toMatchObject({ status: "ended", outcome: "cancelled" });
    expect((await env.readEvents()).some((e) => e.type === "recovery.decided")).toBe(false);
    // Once its Lead has stopped, nothing holds a new recovery back.
    await expect(service.startRecovery("g1", {})).resolves.toMatchObject({
      recovery: { status: "deciding" },
    });
    env.harness.ignoreCancel = false;
    await service.cancelRecovery("g1", { recoveryId: env.goalOf(store).recovery?.id ?? "" });
    await env.settle(manager);
  });

  test("guidance longer than the limit is refused on a recovery and on a retry", async () => {
    const { store, service } = await stuckGoal(CONFIG, answerRetry);
    const long = "x".repeat(MAX_GUIDANCE_CHARS + 1);
    await expect(service.startRecovery("g1", { prompt: long })).rejects.toThrow(
      `the guidance for the goal has ${MAX_GUIDANCE_CHARS + 1} characters; the limit is ${MAX_GUIDANCE_CHARS}`,
    );
    await expect(
      service.retry("g1", undefined, undefined, undefined, { tasks: { a: long } }),
    ).rejects.toThrow(`the guidance for task a has ${MAX_GUIDANCE_CHARS + 1} characters`);
    expect(env.goalOf(store).guidance).toBeUndefined();
  });

  test("an agent cannot start a recovery or give guidance with a retry", async () => {
    const { store, manager, service, fix } = await stuckGoal(CONFIG, () => reply(RETRY));
    await expect(service.startRecovery("g1", { agentId: "agent-x" })).rejects.toThrow(
      "Only a person can start a recovery; the request came from agent agent-x",
    );
    await expect(
      service.retry("g1", undefined, undefined, undefined, { prompt: "x", agentId: "agent-x" }),
    ).rejects.toThrow("Only a person can give guidance");
    expect(env.goalOf(store).recovery).toBeUndefined();
    // A person's guidance on a retry reaches the worker.
    fix();
    await service.retry("g1", undefined, "retry-1", undefined, { tasks: { a: "pin the version" } });
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
    expect(workerPrompts.get("a")?.at(-1)).toContain("pin the version");
  });

  test(`a goal is recovered at most ${MAX_RECOVERIES} times by its Lead`, async () => {
    const { store, manager, service } = await stuckGoal(CONFIG, () =>
      reply({ decision: "needs_person", reason: "raise limits.maxRuns" }),
    );
    for (let i = 1; i <= MAX_RECOVERIES; i += 1) {
      await service.startRecovery("g1", {});
      await env.settle(manager);
      expect(env.goalOf(store).recoveries).toBe(i);
    }
    await expect(service.startRecovery("g1", {})).rejects.toThrow(
      `the goal was already recovered ${MAX_RECOVERIES} times; the limit is ${MAX_RECOVERIES}`,
    );
  });

  test("a goal that failed verification is recovered by verifying again", async () => {
    scriptRecovery({
      plan: [task("a")],
      recover: () => reply({ decision: "retry", reason: "verify again" }),
    });
    let verifies = 0;
    env.stageReplies.verify = (turn) => {
      verifies += 1;
      const ids = [...turn.prompt.matchAll(/^- (\w+): /gm)].map((m) => m[1]);
      const criteria = ids.map((id) => ({ id, met: verifies > 1, evidence: `checked ${id}` }));
      return { outcome: "completed", text: env.fenced(JSON.stringify({ criteria })) };
    };
    const booted = await boot();
    const failed = await failedGoal(CONFIG, booted);
    expect(failed.failureReason).toMatch(/Acceptance criteria not met/);
    await booted.service.startRecovery("g1", {});
    await env.settle(booted.manager);
    const goal = env.goalOf(booted.store);
    expect(goal.status).toBe("completed");
    expect(verifies).toBe(2);
    expect(goal.runs.map((r) => r.taskId)).toEqual(["a"]);
  });

  // Goal b195cf6f: every task succeeded but c1 was not met.
  // The real log, anonymised (test-fixtures): c2 to c10 verified, c1 unmet (finding F-01),
  // two recoveries ended needs_person because a revise could not add work. One is left.
  const B195 = "b195cf6f-6f1c-4889-aff8-3f689db7ab15";
  const ADD_FIX = {
    decision: "revise",
    reason: "add a task that fixes F-01",
    ops: [{ op: "add", task: task("t7", { dependsOn: ["t5"] }) }],
  };
  /** Verifier prompts, each as the criterion ids it asked about. */
  let asked: string[][];

  async function b195(options: { unmet?: string[] } = {}): Promise<Booted & { failed: Goal }> {
    const text = await readFile(
      join(import.meta.dirname, "test-fixtures", "b195cf6f-verify.jsonl"),
      "utf8",
    );
    await writeFile(join(env.logDir(), `${B195}.jsonl`), text);
    scriptRecovery({ plan: [], recover: () => reply(ADD_FIX) });
    asked = [];
    env.stageReplies.verify = (turn) => {
      const ids = askedIds(turn.prompt);
      asked.push(ids);
      const criteria = verdicts(ids, options.unmet ?? []);
      return { outcome: "completed", text: env.fenced(JSON.stringify({ criteria })) };
    };
    const booted = await boot();
    const failed = env.goalOf(booted.store, B195);
    // The integration worktree sits at the commit the goal recorded.
    env.harness.git.headValue = failed.integration?.headCommit ?? "";
    return { ...booted, failed };
  }

  const verifiedIds = async (criterionId: string) =>
    (await env.readEvents(B195))
      .filter((e) => e.type === "criterion.verified" && e.criterionId === criterionId)
      .map((e) => e.id);

  test("the last recovery adds a fix task; verification restarts after its merge and checks every criterion", async () => {
    const { store, manager, service, failed } = await b195();
    expect(failed).toMatchObject({ status: "failed", recoveries: 2 });
    expect(failed.runs).toHaveLength(21);
    const before = diagnoseGoalFailure(failed, { now: env.clock.now() });
    expect(before.findings[0]).toMatchObject({ kind: "verification", personNeeded: "no" });
    expect(before.findings[0]?.remedy).toContain("the Lead can add fix tasks");
    expect(before.findings[0]?.remedy).toContain("This is the last recovery.");

    await service.startRecovery(B195, { timeMode: "fresh" });
    await env.settle(manager);

    const goal = env.goalOf(store, B195);
    expect(goal.status).toBe("completed");
    expect(goal.recoveries).toBe(3);
    expect(goal.verificationRound).toBe(1);
    expect(goal.tasks.at(-1)).toMatchObject({ id: "t7", status: "succeeded" });
    expect(goal.changeSets.find((c) => c.taskId === "t7")?.status).toBe("integrated");
    expect(goal.runs).toHaveLength(22);
    // The Lead saw c1 as not met and was offered fix tasks on its last recovery.
    const prompt = recoveryPrompts[0]?.prompt ?? "";
    expect(prompt).toContain("- [NOT MET] Criterion c1\n- [verified] Criterion c2");
    expect(prompt).toContain("add implement tasks with new ids");
    expect(prompt).toContain("This is the last recovery.");
    // One verification, after the merge, of every criterion.
    expect(asked).toEqual([goal.criteria.map((c) => c.id)]);
    const events = await env.readEvents(B195);
    const merged = events.findIndex(
      (e) => e.type === "changeset.transitioned" && e.to === "integrated" && e.seq > 216,
    );
    const firstVerified = events.findIndex((e) => e.type === "criterion.verified" && e.seq > 216);
    expect(merged).toBeGreaterThan(0);
    expect(firstVerified).toBeGreaterThan(merged);
    // Both rounds stay in the log: c2 was verified once in each, c1 only in round 1.
    expect(await verifiedIds("c2")).toEqual([`${B195}:verified:c2`, `${B195}:verified:c2:v1`]);
    expect(await verifiedIds("c1")).toEqual([`${B195}:verified:c1:v1`]);
    expect(goal.criteria.every((c) => c.evidence === `checked ${c.id} again`)).toBe(true);
  });

  test("a criterion that regresses in round 1 fails the goal with no recovery left, for a person", async () => {
    const { store, manager, service } = await b195({ unmet: ["c4"] });
    await service.startRecovery(B195, { timeMode: "fresh" });
    await env.settle(manager);
    const goal = env.goalOf(store, B195);
    expect(goal.status).toBe("failed");
    expect(goal.recoveries).toBe(3);
    expect(goal.failureReason).toBe("Acceptance criteria not met: Criterion c4 (checked c4 again)");
    expect(goal.criteria.filter((c) => !c.verifiedAt).map((c) => c.id)).toEqual(["c4"]);
    const finding = diagnoseGoalFailure(goal, { now: env.clock.now() }).findings[0];
    expect(finding).toMatchObject({ kind: "verification", personNeeded: "yes" });
    expect(finding?.remedy).toContain("Accept the goal as is or start a follow-up goal");
    await expect(service.startRecovery(B195, { timeMode: "fresh" })).rejects.toThrow(
      `already recovered ${MAX_RECOVERIES} times`,
    );
  });

  test("a restart during round-1 verification asks only what was not recorded yet", async () => {
    const first = await b195();
    // The first round-1 verifier turn never answers: the daemon stops mid-verification.
    let holdVerifier = true;
    const base = env.harness.respond;
    env.harness.respond = (turn) =>
      holdVerifier && turn.prompt.includes("You are the verifier")
        ? "hold"
        : (base?.(turn) ?? "hold");
    await first.service.startRecovery(B195, { timeMode: "fresh" });
    const verifierHeld = () => env.harness.turns.some(isVerifierTurn);
    await until(verifierHeld, "the round-1 verifier");
    // c2 was recorded for round 1 before the stop.
    const c2 = {
      id: `${B195}:verified:c2:v1`,
      goalId: B195,
      type: "criterion.verified" as const,
      criterionId: "c2",
      evidence: "checked c2 before the stop",
    };
    await first.store.dispatch(B195, c2);
    first.manager.stop();
    holdVerifier = false;

    const second = await boot();
    await env.settle(second.manager);
    const goal = env.goalOf(second.store, B195);
    expect(goal.status).toBe("completed");
    // The new verifier was asked about every criterion but c2.
    expect(asked).toEqual([goal.criteria.map((c) => c.id).filter((id) => id !== "c2")]);
    expect(goal.criteria.find((c) => c.id === "c2")?.evidence).toBe("checked c2 before the stop");
    // Recording c2 again under its round id is a duplicate; the round-0 id was already used.
    expect((await second.store.dispatch(B195, c2)).duplicate).toBe(true);
    expect(await verifiedIds("c2")).toEqual([`${B195}:verified:c2`, `${B195}:verified:c2:v1`]);
  });

  test("b195cf6f with no recovery left is accepted as is: completed with c1 waived", async () => {
    const { store, manager, service } = await b195();
    scriptRecovery({
      plan: [],
      recover: () => reply({ decision: "needs_person", reason: "c1 needs a person" }),
    });
    await service.startRecovery(B195, { timeMode: "fresh" });
    await env.settle(manager);
    const failed = env.goalOf(store, B195);
    expect(failed).toMatchObject({ status: "failed", recoveries: MAX_RECOVERIES });
    const finding = diagnoseGoalFailure(failed, { now: env.clock.now() }).findings[0];
    expect(finding).toMatchObject({ kind: "verification", personNeeded: "yes" });
    expect(finding?.remedy).toContain("Accept the goal as is or start a follow-up goal");

    // The goal's reason is the recovery's ending now; the audit record keeps the failure itself.
    const reason = failed.recovery?.failureReason;
    expect(reason).toMatch(/^Acceptance criteria not met: Criterion c1/);
    expect(failed.failureReason).not.toBe(reason);
    await service.accept(B195, { criterionIds: ["c1"], note: "UV-02 ships later", client: "app" });
    await env.settle(manager);
    const goal = env.goalOf(store, B195);
    expect(goal.status).toBe("completed");
    expect(goal.failureReason).toBeNull();
    expect(goal.accepted).toMatchObject({ note: "UV-02 ships later", from: reason, client: "app" });
    expect(goal.criteria.filter((c) => c.waived).map((c) => c.id)).toEqual(["c1"]);
    const accepted = (await env.readEvents(B195)).at(-1);
    expect(accepted).toMatchObject({
      type: "goal.accepted",
      criterionIds: ["c1"],
      acceptedFrom: reason,
      client: "app",
    });
  });

  test("an accept tells the chat under its own key, never the Lead, and only a person may accept", async () => {
    scriptRecovery({
      plan: [task("a")],
      recover: () => reply({ decision: "retry", reason: "verify again" }),
    });
    env.stageReplies.verify = (turn) => {
      const criteria = askedIds(turn.prompt).map((id) => ({ id, met: false, evidence: "no" }));
      return { outcome: "completed", text: env.fenced(JSON.stringify({ criteria })) };
    };
    const booted = await boot();
    const { store, manager, service } = booted;
    await failedGoal({ ...CONFIG, originAgentId: "chat-1" }, booted);
    // Two recoveries retry and verification fails again each time: the goal ends at reopens 2.
    for (let i = 0; i < 2; i += 1) {
      await service.startRecovery("g1", {});
      await env.settle(manager);
    }
    const failed = env.goalOf(store);
    expect(failed).toMatchObject({ status: "failed", reopens: 2 });
    const keys = () => (env.goalOf(store).notifications ?? []).map((n) => `${n.target}:${n.key}`);
    expect(keys()).toContain("origin:goal-ended-r2");
    const otherNotices = env.harness.notified.filter((n) => n.agentId !== "chat-1").length;

    await expect(
      service.accept("g1", { criterionIds: ["c1"], note: "fine", agentId: "agent-7" }),
    ).rejects.toThrow("Only a person can accept a goal as is; the request came from agent agent-7");
    expect(env.goalOf(store).status).toBe("failed");

    await service.accept("g1", { criterionIds: ["c1"], note: "fine", client: "cli" }, "acc-1");
    // A resend with the same eventId changes nothing.
    await service.accept("g1", { criterionIds: ["c1"], note: "fine", client: "cli" }, "acc-1");
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
    expect(keys()).toContain("origin:goal-accepted-r2");
    expect(keys()).not.toContain("lead:goal-completed");
    const toChat = env.harness.notified.filter((n) => n.agentId === "chat-1").map((n) => n.text);
    expect(toChat.at(-1)).toMatch(/completed: accepted as is by a person \(criteria waived: 1\)/);
    expect(env.harness.notified.filter((n) => n.agentId !== "chat-1")).toHaveLength(otherNotices);
    expect((await env.readEvents()).filter((e) => e.type === "goal.accepted")).toHaveLength(1);
  });

  test("an accept is refused while a recovery decides, and a recovery once the goal is accepted", async () => {
    let hold = true;
    scriptRecovery({
      plan: [task("a")],
      recover: () => (hold ? "hold" : reply({ decision: "needs_person", reason: "stop" })),
    });
    env.stageReplies.verify = (turn) => {
      const criteria = askedIds(turn.prompt).map((id) => ({ id, met: false, evidence: "no" }));
      return { outcome: "completed", text: env.fenced(JSON.stringify({ criteria })) };
    };
    const booted = await boot();
    const { store, manager, service } = booted;
    await failedGoal(CONFIG, booted);
    await service.startRecovery("g1", {});
    await expect(
      service.accept("g1", { criterionIds: ["c1"], note: "fine", client: "app" }),
    ).rejects.toThrow(/Recovery rec-\d+ of goal g1 is deciding/);
    await service.cancelRecovery("g1", { recoveryId: env.goalOf(store).recovery?.id ?? "" });
    await env.settle(manager);
    hold = false;
    await service.accept("g1", { criterionIds: ["c1"], note: "fine", client: "app" });
    await expect(service.startRecovery("g1", {})).rejects.toThrow(/completed/);
    expect(env.goalOf(store).status).toBe("completed");
  });

  test("a goal that failed before it had a plan cannot be accepted", async () => {
    scriptRecovery({
      plan: [task("a", { dependsOn: ["a"] })],
      recover: () => reply({ decision: "retry", reason: "-" }),
    });
    const booted = await boot();
    const failed = await failedGoal(CONFIG, booted);
    expect(failed.tasks).toHaveLength(0);
    await expect(
      booted.service.accept("g1", { criterionIds: ["c1"], note: "fine", client: "app" }),
    ).rejects.toThrow(/before it had a plan/);
  });
});
