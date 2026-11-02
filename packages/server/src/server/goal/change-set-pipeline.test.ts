import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { GoalConfig } from "@getpaseo/protocol/goal/types";
import { CONFIG, createGoalTestEnv, task, type GoalTestEnv } from "./goal-test-env.js";
import type { GoalStore } from "./goal-store.js";

const REQUEST = (...findings: string[]) => JSON.stringify({ verdict: "request_changes", findings });

describe("change set pipeline", () => {
  let env: GoalTestEnv;

  beforeEach(async () => {
    env = createGoalTestEnv();
    await env.init();
  });
  afterEach(() => env.cleanup());

  const h = () => env.harness;
  const goal = (store: GoalStore) => env.goalOf(store);
  const setReview = (fn: (n: number, prompt: string) => string) => {
    let calls = 0;
    env.stageReplies.review = (turn) => {
      calls += 1;
      return { outcome: "completed", text: env.fenced(fn(calls, turn.prompt)) };
    };
  };
  const approve = JSON.stringify({ verdict: "approve", findings: [] });

  async function run(config: GoalConfig = CONFIG) {
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, config);
    await env.settle(manager);
    return { store, manager, service };
  }

  test("captures explicit commits, has an independent agent review them in the author's worktree, then integrates", async () => {
    env.script([task("a")]);
    const { store } = await run({ ...CONFIG, reviewProvider: "opencode" });

    const g = goal(store);
    expect(g.status).toBe("completed");
    const cs = g.changeSets[0];
    expect(cs).toMatchObject({
      id: "cs-a-a1",
      taskId: "a",
      round: 0,
      baseCommit: "base0",
      headCommit: "head-1",
      status: "integrated",
      integratedCommit: "merged-1",
    });
    expect(cs?.files).toEqual([{ status: "A", path: "file-1.txt" }]);

    const reviewer = h().agents.find((a) => a.labels["paseo.goal-role"] === "reviewer");
    expect(reviewer).toMatchObject({
      provider: "opencode",
      cwd: cs?.cwd,
      workspaceId: cs?.workspaceId,
    });
    const author = h().agents.find((a) => a.labels["paseo.goal-task"] === "a");
    expect(reviewer?.agentId).not.toBe(author?.agentId);

    expect(h().git.merges).toEqual([
      { cwd: g.integration?.cwd, commit: "head-1", message: expect.any(String) },
    ]);
    expect(g.integration?.headCommit).toBe("merged-1");
  });

  test("unreviewed work is never merged: requested changes go to rework in the same worktree", async () => {
    env.script([task("a")]);
    setReview((n) => (n === 1 ? REQUEST("handle empty input", "add a test") : approve));
    const { store } = await run();

    const g = goal(store);
    expect(g.status).toBe("completed");
    expect(g.changeSets.map((c) => [c.id, c.round, c.status])).toEqual([
      ["cs-a-a1", 0, "superseded"],
      ["cs-a-rw1-a1", 1, "integrated"],
    ]);
    expect(g.changeSets[0]?.findings).toBe("- handle empty input\n- add a test");
    expect(g.changeSets[1]?.supersedes).toBe("cs-a-a1");
    // Only the reviewed rework reached the integration branch.
    expect(h().git.merges.map((m) => m.commit)).toEqual(["head-2"]);

    const rework = g.tasks.find((t) => t.id === "a-rw1");
    expect(rework?.rework).toEqual({ changeSetId: "cs-a-a1", reason: "review", round: 1 });
    const reworkAgent = h().agents.find((a) => a.labels["paseo.goal-task"] === "a-rw1");
    expect(reworkAgent?.workspaceId).toBe(g.changeSets[0]?.workspaceId);
    // No extra worktree was cut for the rework: Lead, task a, integration.
    expect(h().workspaces.filter((w) => w.isolation === "worktree")).toHaveLength(3);
    // The reworked run is not archived with its worktree.
    expect(h().archived).not.toContain(g.changeSets[0]?.workspaceId);
  });

  test("rework prompts carry the findings", async () => {
    const prompts: string[] = [];
    env.script([task("a")], (turn) => {
      prompts.push(turn.prompt);
      return { outcome: "completed", text: "done" };
    });
    setReview((n) => (n === 1 ? REQUEST("rename the flag") : approve));
    await run();
    const reworkPrompt = prompts.find((p) => p.includes("You are fixing your earlier work"));
    expect(reworkPrompt).toContain("rename the flag");
  });

  test("the goal fails when a change is still rejected after the rework limit", async () => {
    env.script([task("a")]);
    setReview(() => REQUEST("still wrong"));
    const { store } = await run({ ...CONFIG, maxReworkRounds: 1 });

    const g = goal(store);
    expect(g.status).toBe("failed");
    expect(g.failureReason).toMatch(/rework rounds/);
    expect(g.changeSets.map((c) => c.status)).toEqual(["superseded", "rejected"]);
    // The rework limit is final.
    expect(g.changeSets[1]?.rejectionReason).toBe("rework_limit");
    expect(h().git.merges).toHaveLength(0);
  });

  test("a merge conflict is aborted and sent back to the author to resolve", async () => {
    env.script([task("a")]);
    h().git.mergeQueue.push({ ok: false, conflicts: ["src/app.ts"] });
    const { store } = await run();

    const g = goal(store);
    expect(g.status).toBe("completed");
    expect(g.changeSets[0]).toMatchObject({
      status: "superseded",
      error: "Conflicts in: src/app.ts",
    });
    expect(g.tasks.find((t) => t.id === "a-rw1")?.rework?.reason).toBe("conflict");
    expect(g.tasks.find((t) => t.id === "a-rw1")?.description).toContain("src/app.ts");
  });

  test("a failing test command resets the integration branch and triggers rework", async () => {
    env.script([task("a")]);
    h().git.commandQueue.push({ exitCode: 1, timedOut: false, output: "1 failing" });
    const { store } = await run({ ...CONFIG, testCommand: "npm test" });

    const g = goal(store);
    expect(g.status).toBe("completed");
    expect(g.changeSets[0]).toMatchObject({ status: "superseded", testSummary: "1 failing" });
    // Back to the pre-merge head after the failure, then to the tested merge after the retry.
    expect(h().git.resets).toEqual([
      { cwd: g.integration?.cwd, commit: "base0" },
      { cwd: g.integration?.cwd, commit: "merged-2" },
    ]);
    expect(g.tasks.find((t) => t.id === "a-rw1")?.rework?.reason).toBe("tests");
    expect(h().git.commands.map((c) => c.command)).toEqual(["npm test", "npm test"]);
    expect(g.changeSets[1]?.testSummary).toBe("ok");
  });

  test("a timed-out test command counts as a failure", async () => {
    env.script([task("a")]);
    h().git.commandQueue.push({ exitCode: null, timedOut: true, output: "" });
    const { store } = await run({ ...CONFIG, testCommand: "slow" });
    expect(goal(store).changeSets[0]?.error).toBe("Test command timed out");
  });

  test("approved change sets are merged one at a time", async () => {
    env.script([task("a"), task("b")]);
    let active = 0;
    let peak = 0;
    h().git.merge = async (input) => {
      active += 1;
      peak = Math.max(peak, active);
      h().git.merges.push(input);
      await new Promise((r) => setTimeout(r, 25));
      active -= 1;
      return { ok: true, headCommit: `merged-${h().git.merges.length}` };
    };
    const { store } = await run();
    expect(goal(store).changeSets.map((c) => c.status)).toEqual(["integrated", "integrated"]);
    expect(h().git.merges).toHaveLength(2);
    expect(peak).toBe(1);
  });

  test("a dependent implement task starts from the integration branch only after its dependency is integrated", async () => {
    env.script([task("a"), task("b", { dependsOn: ["a"] })]);
    const mergesWhenBStarted: number[] = [];
    const create = h().agentPort.createAgent;
    h().agentPort.createAgent = async (input) => {
      if (input.labels["paseo.goal-task"] === "b") mergesWhenBStarted.push(h().git.merges.length);
      return create(input);
    };
    const { store } = await run();

    expect(goal(store).status).toBe("completed");
    expect(mergesWhenBStarted).toEqual([1]);
    // It branches from the integrated commit, not from a branch name that may be renamed.
    const bWorkspace = h().workspaces.find((w) => w.title === "Task b");
    expect(bWorkspace?.baseRef).toBe("merged-1");
    // Independent first-level work branches from the repository, not an integration that does not exist yet.
    expect(h().workspaces.find((w) => w.title === "Task a")?.baseRef).toBeUndefined();
  });

  test("with human approval required, a reviewed change waits for a person", async () => {
    env.script([task("a")]);
    const { store, manager } = await run({ ...CONFIG, requireHumanApproval: true });
    expect(goal(store).status).toBe("executing");
    expect(goal(store).changeSets[0]?.status).toBe("awaiting_human");
    expect(h().git.merges).toHaveLength(0);

    await store.dispatch("g1", {
      id: "human",
      goalId: "g1",
      type: "changeset.transitioned",
      changeSetId: "cs-a-a1",
      to: "approved",
    });
    await env.settle(manager);
    expect(goal(store).status).toBe("completed");
    expect(h().git.merges).toHaveLength(1);
  });

  test("a goal whose criteria are not met fails instead of completing", async () => {
    env.script([task("a")]);
    env.stageReplies.verify = () => ({
      outcome: "completed",
      text: env.fenced(
        JSON.stringify({
          criteria: [{ id: "c1", met: false, evidence: "the endpoint returns 500" }],
        }),
      ),
    });
    const { store } = await run();

    const g = goal(store);
    expect(g.status).toBe("failed");
    expect(g.failureReason).toMatch(
      /Acceptance criteria not met: works \(the endpoint returns 500\)/,
    );
    expect(g.criteria[0]?.verifiedAt).toBeNull();
    expect(g.changeSets[0]?.status).toBe("integrated");
  });

  test("a verified criterion is recorded under the round-0 id older logs carry", async () => {
    env.script([task("a")]);
    await run();
    const verified = (await env.readEvents()).filter((e) => e.type === "criterion.verified");
    expect(verified).toEqual([expect.objectContaining({ id: "g1:verified:c1", round: 0 })]);
  });

  test("after a recovery adds work, the criterion is recorded under its round's id", async () => {
    env.script([task("a")]);
    const base = h().respond;
    const fix = { decision: "revise", reason: "fix c1", ops: [{ op: "add", task: task("fix") }] };
    h().respond = (turn) =>
      turn.prompt.includes("asked you to recover it")
        ? { outcome: "completed", text: env.fenced(JSON.stringify(fix)) }
        : (base?.(turn) ?? "hold");
    let verifies = 0;
    env.stageReplies.verify = () => {
      verifies += 1;
      const criteria = [{ id: "c1", met: verifies > 1, evidence: `round ${verifies - 1}` }];
      return { outcome: "completed", text: env.fenced(JSON.stringify({ criteria })) };
    };
    const { store, manager, service } = await run();
    expect(goal(store).status).toBe("failed");
    service.attachActivityProbe(manager);
    await service.startRecovery("g1", {});
    await env.settle(manager);
    expect(goal(store)).toMatchObject({ status: "completed", verificationRound: 1 });
    const verified = (await env.readEvents()).filter((e) => e.type === "criterion.verified");
    expect(verified).toEqual([
      expect.objectContaining({ id: "g1:verified:c1:v1", round: 1, evidence: "round 1" }),
    ]);
  });

  test("the verifier must answer every criterion", async () => {
    env.script([task("a")]);
    const prompts: string[] = [];
    env.stageReplies.verify = (turn) => {
      prompts.push(turn.prompt);
      const criteria =
        prompts.length === 1 ? [] : [{ id: "c1", met: true, evidence: "checked c1" }];
      return { outcome: "completed", text: env.fenced(JSON.stringify({ criteria })) };
    };
    const { store } = await run();
    expect(prompts[1]).toMatch(/Criteria not answered: c1/);
    expect(goal(store).status).toBe("completed");
  });

  test("an unusable review fails the change and the goal rather than skipping review", async () => {
    env.script([task("a")]);
    env.stageReplies.review = () => ({ outcome: "completed", text: "looks fine to me" });
    const { store } = await run();

    const g = goal(store);
    expect(g.status).toBe("failed");
    expect(g.changeSets[0]?.status).toBe("rejected");
    expect(h().git.merges).toHaveLength(0);
  });

  test("a task that changed nothing produces no change set and no review", async () => {
    env.script([task("a")]);
    h().git.captureQueue.push(null);
    const { store } = await run();

    expect(goal(store).status).toBe("completed");
    expect(goal(store).changeSets).toHaveLength(0);
    expect(h().agents.some((a) => a.labels["paseo.goal-role"] === "reviewer")).toBe(false);
  });

  test("review and read tasks make no change sets", async () => {
    env.script([task("a", { kind: "read" }), task("b", { kind: "review", dependsOn: ["a"] })]);
    const { store } = await run();
    expect(goal(store).status).toBe("completed");
    expect(goal(store).changeSets).toHaveLength(0);
    expect(goal(store).integration).toBeNull();
    expect(h().git.captured).toHaveLength(0);
  });

  test("a rework that adds no commits fails the goal", async () => {
    env.script([task("a")]);
    const same = { branch: "b", baseCommit: "base0", headCommit: "h1", files: [] };
    h().git.captureQueue.push(same, same);
    setReview((n) => (n === 1 ? REQUEST("fix it") : approve));
    const { store } = await run();

    expect(goal(store).status).toBe("failed");
    expect(goal(store).failureReason).toMatch(/changed nothing/);
    expect(h().git.merges).toHaveLength(0);
    // Its rework succeeded, so there is nothing to run again: the rejection stays final.
    expect(goal(store).changeSets[0]).toMatchObject({
      status: "rejected",
      error: "Rework added no commits",
    });
    expect(goal(store).changeSets[0]).not.toHaveProperty("rejectionReason");
  });

  test("after a restart in the middle of a merge, the branch is reset and the merge retried", async () => {
    env.script([task("a")]);
    const frozen = await env.boot();
    frozen.manager.stop();
    await env.createGoal(frozen.store);
    const d = (type: string, extra: Record<string, unknown> = {}) =>
      frozen.store.dispatch("g1", {
        id: `seed-${type}-${Math.random()}`,
        goalId: "g1",
        type,
        ...extra,
      } as never);
    await d("plan.proposed", { tasks: [task("a")] });
    await d("plan.approved");
    await d("task.started", { taskId: "a" });
    await d("run.started", { runId: "a-a1", taskId: "a", provider: "codex" });
    await d("run.attached", { runId: "a-a1", agentId: "agent-x", workspaceId: "ws-x" });
    await d("task.succeeded", { taskId: "a", summary: "built" });
    await d("run.finished", { runId: "a-a1", outcome: "succeeded" });
    await d("integration.prepared", {
      branch: "paseo-goal/integration",
      workspaceId: "ws-int",
      cwd: "/repo/ws-int",
      baseCommit: "base0",
    });
    await d("changeset.captured", {
      changeSetId: "cs-a-a1",
      taskId: "a",
      runId: "a-a1",
      round: 0,
      supersedes: null,
      workspaceId: "ws-x",
      cwd: "/repo/ws-x",
      branch: "task-branch",
      baseCommit: "base0",
      headCommit: "h1",
      files: [],
    });
    for (const to of ["in_review", "approved", "integrating"]) {
      await d("changeset.transitioned", { changeSetId: "cs-a-a1", to });
    }

    const second = await env.boot();
    await env.settle(second.manager);

    const g = goal(second.store);
    expect(g.status).toBe("completed");
    expect(h().git.resets).toEqual([
      { cwd: "/repo/ws-int", commit: "base0" },
      { cwd: "/repo/ws-int", commit: "merged-1" },
    ]);
    expect(h().git.merges.map((m) => m.commit)).toEqual(["h1"]);
    expect(g.changeSets[0]?.status).toBe("integrated");
  });

  // ---- regressions found by review --------------------------------------

  /** A goal frozen at a point a crash could have left it, ready to be recovered. */
  async function seed(config: GoalConfig = CONFIG) {
    const started = await env.boot();
    started.manager.stop();
    await env.createGoal(started.store, config);
    let n = 0;
    const d = (type: string, extra: Record<string, unknown> = {}) =>
      started.store.dispatch("g1", {
        id: `seed-${n++}-${type}`,
        goalId: "g1",
        type,
        ...extra,
      } as never);
    return { ...started, d };
  }

  const capturedEvent = (extra: Record<string, unknown> = {}) => ({
    changeSetId: "cs-a-a1",
    taskId: "a",
    runId: "a-a1",
    round: 0,
    supersedes: null,
    workspaceId: "ws-x",
    cwd: "/repo/ws-x",
    branch: "task-branch",
    baseCommit: "base0",
    headCommit: "h1",
    files: [],
    ...extra,
  });

  /** Task a ran in ws-x and succeeded; nothing after that was recorded. */
  async function seedSucceeded(withCwd: boolean) {
    const sd = await seed();
    await sd.d("plan.proposed", { tasks: [task("a")] });
    await sd.d("plan.approved");
    await sd.d("task.started", { taskId: "a" });
    await sd.d("run.started", { runId: "a-a1", taskId: "a", provider: "codex" });
    await sd.d("run.attached", {
      runId: "a-a1",
      agentId: "agent-x",
      workspaceId: "ws-x",
      ...(withCwd ? { cwd: "/repo/ws-x" } : {}),
    });
    await sd.d("task.succeeded", { taskId: "a", summary: "built" });
    await sd.d("run.finished", { runId: "a-a1", outcome: "succeeded" });
    return sd;
  }

  test("a crash after a task succeeded but before capture does not lose its work", async () => {
    env.script([task("a")]);
    await seedSucceeded(true);
    const second = await env.boot();
    await env.settle(second.manager);

    const g = goal(second.store);
    expect(h().git.captured.map((c) => c.cwd)).toEqual(["/repo/ws-x"]);
    expect(g.changeSets.map((c) => [c.taskId, c.status])).toEqual([["a", "integrated"]]);
    expect(g.status).toBe("completed");
  });

  test("work that cannot be found again fails the goal instead of completing without it", async () => {
    env.script([task("a")]);
    await seedSucceeded(false);
    const second = await env.boot();
    await env.settle(second.manager);

    expect(goal(second.store).status).toBe("failed");
    expect(goal(second.store).failureReason).toMatch(/Could not recover the work of task a/);
    expect(h().git.merges).toHaveLength(0);
  });

  test("one goal that cannot be recovered does not stop the daemon from starting", async () => {
    env.script([task("a")]);
    await seedSucceeded(true);
    h().git.capture = async () => {
      throw new Error("worktree is gone");
    };
    const second = await env.boot();
    await env.settle(second.manager);

    expect(goal(second.store).status).toBe("failed");
    expect(goal(second.store).failureReason).toMatch(/Recovery failed: worktree is gone/);
  });

  test("a task that changed nothing is recorded as captured, so a restart does not hunt for its work", async () => {
    env.script([task("a")]);
    h().git.captureQueue.push(null);
    const { store } = await run();
    expect(goal(store).tasks[0]?.captured).toBe(true);
    expect(goal(store).changeSets).toHaveLength(0);
  });

  test("a rework that fails for good fails the goal instead of leaving it waiting", async () => {
    env.script([task("a")], (turn) =>
      turn.prompt.includes("You are fixing your earlier work")
        ? { outcome: "failed", error: "cannot fix" }
        : { outcome: "completed", text: "done" },
    );
    setReview((n) => (n === 1 ? REQUEST("needs work") : approve));
    const { store } = await run();

    const g = goal(store);
    expect(g.status).toBe("failed");
    expect(g.failureReason).toBe("Rework a-rw1 failed after 2 attempts.");
    expect(g.changeSets[0]).toMatchObject({
      status: "rejected",
      rejectionReason: "rework_failed",
      error: "Rework a-rw1 failed: cannot fix",
    });
  });

  test("a rework whose worker reports it was blocked is not retried and fails the goal quoting the claim", async () => {
    env.script([task("a")], (turn) =>
      turn.prompt.includes("You are fixing your earlier work")
        ? { outcome: "completed", text: "Could not run.\nTASK_STATUS: blocked: disk full" }
        : { outcome: "completed", text: "done" },
    );
    setReview((n) => (n === 1 ? REQUEST("needs work") : approve));
    const { store } = await run();

    const g = goal(store);
    expect(g.status).toBe("failed");
    expect(g.failureReason).toBe(
      'Task a-rw1 stopped: the worker reported it was blocked: "disk full". Fix what it names and retry. Rework a-rw1 failed.',
    );
    expect(g.changeSets[0]).toMatchObject({
      status: "rejected",
      rejectionReason: "rework_failed",
      error: "Rework a-rw1 failed: Worker reported it was blocked: disk full",
    });
    expect(g.runs.filter((r) => r.taskId === "a-rw1")).toHaveLength(1);
  });

  test("a retry reworks a change set whose rework failed, and the rework supersedes it", async () => {
    let fixing = false;
    env.script([task("a")], (turn) =>
      turn.prompt.includes("You are fixing your earlier work") && !fixing
        ? { outcome: "failed", error: "cannot fix" }
        : { outcome: "completed", text: "done" },
    );
    setReview((n) => (n === 1 ? REQUEST("needs work") : approve));
    const { store, manager, service } = await run();
    expect(goal(store).changeSets[0]?.rejectionReason).toBe("rework_failed");

    fixing = true;
    service.attachActivityProbe(manager);
    await service.retry("g1", undefined);
    await env.settle(manager);
    const g = goal(store);
    expect(g.status).toBe("completed");
    expect(g.changeSets.map((c) => [c.id, c.round, c.status])).toEqual([
      ["cs-a-a1", 0, "superseded"],
      ["cs-a-rw1-a3", 1, "integrated"],
    ]);
    // The reopen added no second rework for the change set.
    expect(g.tasks.map((t) => t.id)).toEqual(["a", "a-rw1"]);
  });

  test("a second round of changes after a reworked rework hits the rework limit, which stays final", async () => {
    let fixing = false;
    env.script([task("a")], (turn) =>
      turn.prompt.includes("You are fixing your earlier work") && !fixing
        ? { outcome: "failed", error: "cannot fix" }
        : { outcome: "completed", text: "done" },
    );
    setReview(() => REQUEST("still wrong"));
    const { store, manager, service } = await run({ ...CONFIG, maxReworkRounds: 1 });
    expect(goal(store).changeSets[0]?.rejectionReason).toBe("rework_failed");

    fixing = true;
    service.attachActivityProbe(manager);
    await service.retry("g1", undefined);
    await env.settle(manager);
    const g = goal(store);
    expect(g.status).toBe("failed");
    expect(g.failureReason).toMatch(/after 1 rework rounds/);
    expect(g.changeSets.map((c) => [c.id, c.status, c.rejectionReason])).toEqual([
      ["cs-a-a1", "superseded", undefined],
      ["cs-a-rw1-a3", "rejected", "rework_limit"],
    ]);
    await expect(service.retry("g1", undefined)).rejects.toThrow(/no failed or cancelled task/);
  });

  test("a rework stopped on a request fails the goal with the needs-permission text", async () => {
    const request =
      'Agent is waiting for permission to use Bash: "git commit" and the goal\'s permission policy (fail) cannot grant it. Change the policy to wait or auto, then retry.';
    env.script([task("a")], (turn) =>
      turn.prompt.includes("You are fixing your earlier work")
        ? { outcome: "failed", error: request }
        : { outcome: "completed", text: "done" },
    );
    setReview((n) => (n === 1 ? REQUEST("needs work") : approve));
    const { store } = await run({ ...CONFIG, onPermissionRequest: "fail" });

    const g = goal(store);
    expect(g.status).toBe("failed");
    expect(g.failureReason).toBe(
      `Rework a-rw1 failed after 1 attempts. Task a-rw1 stopped on a request (needs_permission): ${request}`,
    );
    expect(g.changeSets[0]?.rejectionReason).toBe("rework_failed");
  });

  test("recovery keeps the worktree a rework run was using", async () => {
    env.script([task("a")]);
    const sd = await seed();
    await sd.d("plan.proposed", { tasks: [task("a")] });
    await sd.d("plan.approved");
    await sd.d("task.started", { taskId: "a" });
    await sd.d("run.started", { runId: "a-a1", taskId: "a", provider: "codex" });
    await sd.d("task.succeeded", { taskId: "a" });
    await sd.d("run.finished", { runId: "a-a1", outcome: "succeeded" });
    await sd.d("integration.prepared", {
      branch: "paseo-goal/integration",
      workspaceId: "ws-int",
      cwd: "/repo/ws-int",
      baseCommit: "base0",
    });
    await sd.d("changeset.captured", capturedEvent());
    await sd.d("changeset.transitioned", { changeSetId: "cs-a-a1", to: "in_review" });
    await sd.d("changeset.transitioned", {
      changeSetId: "cs-a-a1",
      to: "changes_requested",
      findings: "- fix it",
    });
    await sd.d("task.added", {
      task: { ...task("a-rw1"), title: "Rework" },
      rework: { changeSetId: "cs-a-a1", reason: "review", round: 1 },
    });
    await sd.d("task.started", { taskId: "a-rw1" });
    await sd.d("run.started", { runId: "a-rw1-a1", taskId: "a-rw1", provider: "codex" });
    await sd.d("run.attached", {
      runId: "a-rw1-a1",
      agentId: "agent-y",
      workspaceId: "ws-x",
      cwd: "/repo/ws-x",
    });

    const second = await env.boot();
    await env.settle(second.manager);

    expect(h().archived).not.toContain("ws-x");
    const reworkAgents = h().agents.filter((a) => a.labels["paseo.goal-task"] === "a-rw1");
    expect(reworkAgents.map((a) => a.workspaceId)).toEqual(["ws-x"]);
    expect(goal(second.store).status).toBe("completed");
  });

  test("a plan cannot use ids reserved for rework tasks", async () => {
    const prompts: string[] = [];
    let calls = 0;
    h().respond = (turn) => {
      if (turn.prompt.includes("You are the Lead") || turn.prompt.includes("could not be used")) {
        prompts.push(turn.prompt);
        calls += 1;
        const id = calls === 1 ? "a-rw1" : "a";
        return {
          outcome: "completed",
          text: env.fenced(JSON.stringify({ tasks: [task(id)] })),
        };
      }
      if (turn.prompt.includes("independent reviewer")) return env.stageReplies.review(turn);
      if (turn.prompt.includes("You are the verifier")) return env.stageReplies.verify(turn);
      return { outcome: "completed", text: "done" };
    };
    const { store, manager } = await env.boot();
    await env.createGoal(store);
    await env.settle(manager);

    expect(prompts[1]).toMatch(/reserved for rework tasks/);
    expect(goal(store).tasks.map((t) => t.id)).toEqual(["a"]);
  });

  test("a managed goal needs at least one acceptance criterion", async () => {
    const { service } = await env.boot();
    await expect(
      service.create({ title: "T", objective: "", criteria: [], config: CONFIG }),
    ).rejects.toThrow(/at least one acceptance criterion/);
    await expect(
      service.create({ title: "Manual", objective: "", criteria: [] }),
    ).resolves.toMatchObject({ config: null });
  });

  test("a verifier that changes the integration branch has its verdict discarded", async () => {
    env.script([task("a")]);
    const answer = env.stageReplies.verify;
    env.stageReplies.verify = (turn) => {
      h().git.dirty = true;
      return answer(turn);
    };
    const { store } = await run();

    const g = goal(store);
    expect(g.status).toBe("failed");
    expect(g.failureReason).toMatch(/verifier changed the integration branch/);
    expect(g.criteria[0]?.verifiedAt).toBeNull();
    expect(h().git.resets.at(-1)).toEqual({ cwd: g.integration?.cwd, commit: "merged-1" });
  });

  test("a merge that throws leaves the branch where it was and fails the goal", async () => {
    env.script([task("a")]);
    h().git.merge = async () => {
      throw new Error("disk full");
    };
    const { store } = await run();

    const g = goal(store);
    expect(g.status).toBe("failed");
    expect(g.changeSets[0]).toMatchObject({ status: "rejected" });
    expect(g.changeSets[0]?.error).toMatch(/disk full/);
    expect(h().git.resets).toEqual([{ cwd: g.integration?.cwd, commit: "base0" }]);
  });

  test("a failed integration setup does not strand its worktree", async () => {
    env.script([task("a")]);
    h().git.currentBranch = async () => {
      throw new Error("no such branch");
    };
    const { store } = await run();

    expect(goal(store).status).toBe("failed");
    const integrationWorkspace = h().workspaces.find((w) => w.branchName === "paseo-goal/g1");
    expect(h().archived).toContain(integrationWorkspace?.workspaceId);
  });

  test("a person can send a held change set back to its author, then approve the rework", async () => {
    env.script([task("a")]);
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, { ...CONFIG, requireHumanApproval: true });
    await env.settle(manager);
    expect(goal(store).changeSets[0]?.status).toBe("awaiting_human");

    await service.requestChanges("g1", "cs-a-a1", "use the new API");
    await env.settle(manager);
    const g = goal(store);
    expect(g.tasks.find((t) => t.id === "a-rw1")?.description).toContain("use the new API");
    expect(g.changeSets.map((c) => c.status)).toEqual(["superseded", "awaiting_human"]);
    expect(h().git.merges).toHaveLength(0);

    await service.approveChangeSet("g1", "cs-a-a1-rework-placeholder").catch(() => undefined);
    await service.approveChangeSet("g1", g.changeSets[1]?.id ?? "");
    await env.settle(manager);
    expect(goal(store).status).toBe("completed");
  });

  test("only a change set held for approval can be approved or sent back", async () => {
    env.script([task("a")]);
    const { store, service } = await run();
    await expect(service.approveChangeSet("g1", "cs-a-a1")).rejects.toThrow(
      /only a reviewed change set/,
    );
    await expect(service.requestChanges("g1", "cs-a-a1", "x")).rejects.toThrow(/held for approval/);
    await expect(service.approveChangeSet("g1", "nope")).rejects.toThrow(/not found/);
    expect(goal(store).status).toBe("completed");
  });

  test("setup output left in the integration worktree is cleared before the first merge", async () => {
    env.script([task("a")]);
    // The first cleanliness check is the one made right after the worktree is set up.
    h().git.dirtyNext = 1;
    const { store } = await run();
    const g = goal(store);
    expect(h().git.resets[0]).toEqual({ cwd: g.integration?.cwd, commit: "base0" });
    expect(g.status).toBe("completed");
  });

  test("the integration worktree keeps its branch name", async () => {
    env.script([task("a")]);
    await run();
    const integration = h().workspaces.find((w) => w.branchName === "paseo-goal/g1");
    expect(integration?.keepBranchName).toBe(true);
    expect(h().workspaces.filter((w) => w.keepBranchName)).toHaveLength(1);
  });
});
