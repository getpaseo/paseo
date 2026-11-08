import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Goal, GoalEvent } from "@getpaseo/protocol/goal/types";
import { GoalEventLog } from "./event-log.js";
import { applyGoalEvent, replayGoal } from "./goal-reducer.js";
import { GoalService, matchesGoalFilter } from "./goal-service.js";
import { GoalStore } from "./goal-store.js";
import { CONFIG, createGoalTestEnv, task, type GoalTestEnv } from "./goal-test-env.js";

const AT = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";

let counter = 0;
function ev(goal: Goal | null, partial: Record<string, unknown>, at = AT): GoalEvent {
  counter += 1;
  return {
    id: `e${counter}`,
    goalId: "g1",
    seq: (goal?.lastSeq ?? 0) + 1,
    at,
    ...partial,
  } as GoalEvent;
}

function run(events: Record<string, unknown>[], start: Goal | null = null, at = AT): Goal {
  let goal = start;
  for (const partial of events) goal = applyGoalEvent(goal, ev(goal, partial, at));
  if (!goal) throw new Error("no events");
  return goal;
}

const created = (extra: Record<string, unknown> = {}) => ({
  type: "goal.created",
  title: "Ship it",
  objective: "Make the build green",
  criteria: [{ id: "c1", text: "works" }],
  ...extra,
});

describe("goal management events in the reducer", () => {
  test("a goal can be renamed and reprioritised while it runs and after it ended", () => {
    const live = run([created(), { type: "goal.renamed", title: "Ship it now" }]);
    expect(live.title).toBe("Ship it now");
    expect(live.priority).toBeUndefined();

    const ended = run([{ type: "goal.cancelled" }, { type: "goal.renamed", title: "Old" }], live);
    expect(ended.title).toBe("Old");
    const high = run([{ type: "goal.priority_set", priority: "high" }], ended);
    expect(high.priority).toBe("high");
    expect(high.status).toBe("cancelled");
  });

  test("priority given at creation is kept; absent means normal", () => {
    expect(run([created({ priority: "low" })]).priority).toBe("low");
    expect(run([created()]).priority).toBeUndefined();
  });

  test("only an ended goal can be archived, once, and unarchived only when archived", () => {
    const live = run([created()]);
    expect(() => applyGoalEvent(live, ev(live, { type: "goal.archived" }))).toThrow(
      /only an ended goal can be archived/,
    );
    const ended = run([{ type: "goal.cancelled" }], live);
    expect(() => applyGoalEvent(ended, ev(ended, { type: "goal.unarchived" }))).toThrow(
      /not archived/,
    );
    const archived = run([{ type: "goal.archived" }], ended, LATER);
    expect(archived.archivedAt).toBe(LATER);
    expect(() => applyGoalEvent(archived, ev(archived, { type: "goal.archived" }))).toThrow(
      /already archived/,
    );
    const back = run([{ type: "goal.unarchived" }], archived);
    expect(back.archivedAt).toBeNull();
  });

  test("an archived failed goal cannot be reopened until it is unarchived", () => {
    const failed = run([
      created({ config: CONFIG }),
      { type: "plan.proposed", tasks: [{ ...task("a"), kind: "implement" }] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
      { type: "run.finished", runId: "a-a1", outcome: "failed", error: "boom" },
      { type: "task.failed", taskId: "a", error: "boom" },
      { type: "goal.failed", reason: "stuck" },
      { type: "goal.archived" },
    ]);
    const retry = { type: "goal.retried", taskIds: ["a"], reopen: true };
    expect(() => applyGoalEvent(failed, ev(failed, retry))).toThrow(/archived; unarchive it/);
    const unarchived = run([{ type: "goal.unarchived" }], failed);
    expect(run([retry], unarchived).status).toBe("executing");
  });

  test("replaying the log gives the same labels", () => {
    const events: GoalEvent[] = [];
    let goal: Goal | null = null;
    for (const partial of [
      created({ priority: "high" }),
      { type: "goal.renamed", title: "Renamed" },
      { type: "goal.cancelled" },
      { type: "goal.archived" },
      { type: "goal.priority_set", priority: "low" },
    ]) {
      const event = ev(goal, partial);
      events.push(event);
      goal = applyGoalEvent(goal, event);
    }
    expect(replayGoal(events)).toEqual(goal);
    expect(goal).toMatchObject({ title: "Renamed", priority: "low", archivedAt: AT });
  });
});

describe("goal list filters", () => {
  const base = run([created({ config: CONFIG })]);
  const manual = run([created({ title: "Docs pass", objective: "Write docs" })]);
  const archived = run([{ type: "goal.cancelled" }, { type: "goal.archived" }], manual);

  test("archived goals are hidden unless asked for", () => {
    expect(matchesGoalFilter(archived, {})).toBe(false);
    expect(matchesGoalFilter(archived, { archived: "include" })).toBe(true);
    expect(matchesGoalFilter(archived, { archived: "only" })).toBe(true);
    expect(matchesGoalFilter(base, { archived: "only" })).toBe(false);
  });

  test("query matches title, objective or id, ignoring case", () => {
    expect(matchesGoalFilter(base, { query: "SHIP" })).toBe(true);
    expect(matchesGoalFilter(base, { query: "build green" })).toBe(true);
    expect(matchesGoalFilter(base, { query: "g1" })).toBe(true);
    expect(matchesGoalFilter(base, { query: "docs" })).toBe(false);
    expect(matchesGoalFilter(base, { query: "  " })).toBe(true);
  });

  test("status, priority and project filters combine", () => {
    expect(matchesGoalFilter(base, { status: ["planning", "executing"] })).toBe(true);
    expect(matchesGoalFilter(base, { status: ["completed"] })).toBe(false);
    // No priority reads as normal.
    expect(matchesGoalFilter(base, { priority: ["normal"] })).toBe(true);
    expect(matchesGoalFilter(base, { priority: ["high"] })).toBe(false);
    expect(matchesGoalFilter(base, { cwd: CONFIG.cwd })).toBe(true);
    expect(matchesGoalFilter(manual, { cwd: CONFIG.cwd })).toBe(false);
    expect(matchesGoalFilter(base, { cwd: CONFIG.cwd, status: ["completed"] })).toBe(false);
  });
});

describe("goal management in the service and store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-goal-mgmt-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function open() {
    const log = new GoalEventLog({ dir });
    const store = new GoalStore(log);
    await store.recover();
    return { log, store, service: new GoalService(store, log) };
  }

  async function manualGoal(service: GoalService, goalId: string, title = "Manual") {
    return service.create({ goalId, title, objective: "", criteria: [] });
  }

  test("rename trims, refuses an empty title, and a resend with the same eventId is a no-op", async () => {
    const { service, log } = await open();
    await manualGoal(service, "g1");
    expect((await service.rename("g1", "  New name  ", "r1")).title).toBe("New name");
    await service.rename("g1", "Other", "r1");
    expect((await service.inspect("g1")).goal.title).toBe("New name");
    await expect(service.rename("g1", "   ")).rejects.toThrow(/cannot be empty/);
    // The same title again writes nothing.
    const before = (await log.read("g1")).length;
    await service.rename("g1", "New name");
    expect(await log.read("g1")).toHaveLength(before);
  });

  test("priority is set at creation or later; setting the current one writes nothing", async () => {
    const { service, log } = await open();
    const goal = await service.create({
      goalId: "g1",
      title: "T",
      objective: "",
      criteria: [],
      priority: "high",
    });
    expect(goal.priority).toBe("high");
    await manualGoal(service, "g2");
    const before = (await log.read("g2")).length;
    await service.setPriority("g2", "normal");
    expect(await log.read("g2")).toHaveLength(before);
    expect((await service.setPriority("g2", "low")).priority).toBe("low");
  });

  test("list puts higher priority first, then older, and hides archived goals", async () => {
    const { service } = await open();
    await manualGoal(service, "a1");
    await manualGoal(service, "b2");
    await manualGoal(service, "c3");
    await service.setPriority("c3", "high");
    await service.setPriority("a1", "low");
    expect(service.list().map((g) => g.id)).toEqual(["c3", "b2", "a1"]);

    await expect(service.archive("b2")).rejects.toThrow(/planning; stop it before/);
    await service.cancel("b2");
    await service.archive("b2");
    // Archiving twice returns the goal unchanged.
    expect((await service.archive("b2")).archivedAt).toBeTruthy();
    expect(service.list().map((g) => g.id)).toEqual(["c3", "a1"]);
    expect(service.list({ archived: "only" }).map((g) => g.id)).toEqual(["b2"]);
    // Archived goals stay inspectable by id.
    expect((await service.inspect("b2")).goal.archivedAt).toBeTruthy();
    await service.unarchive("b2");
    expect(service.list().map((g) => g.id)).toEqual(["c3", "b2", "a1"]);
  });

  test("delete refuses a live goal and removes an ended one with its log", async () => {
    const { service, store, log } = await open();
    await manualGoal(service, "g1");
    await expect(service.delete("g1")).rejects.toThrow(/planning; stop it before/);
    await service.cancel("g1");
    const removed: string[] = [];
    store.subscribeRemoved((goal) => removed.push(goal.id));
    expect(await service.delete("g1")).toEqual({ goalId: "g1", deleted: true, retained: [] });
    expect(removed).toEqual(["g1"]);
    expect(store.get("g1")).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
    expect(await log.listTombstones()).toEqual([]);
    await expect(service.inspect("g1")).rejects.toThrow(/not found/);
  });

  test("deleting again, or deleting an unknown goal, succeeds with deleted: false", async () => {
    const { service } = await open();
    await manualGoal(service, "g1");
    await service.cancel("g1");
    const [first, second] = await Promise.all([service.delete("g1"), service.delete("g1")]);
    expect(first.deleted).toBe(true);
    expect(second).toEqual({ goalId: "g1", deleted: false, retained: [] });
    expect(await service.delete("missing")).toEqual({
      goalId: "missing",
      deleted: false,
      retained: [],
    });
  });

  test("a goal tombstoned before a crash stays deleted and is reported for cleanup", async () => {
    const first = await open();
    await manualGoal(first.service, "g1");
    await manualGoal(first.service, "g2");
    await first.service.cancel("g1");
    // Crash after the tombstone, before resources are released and the tombstone removed.
    await first.store.remove("g1");

    const second = await open();
    expect(second.store.get("g1")).toBeUndefined();
    expect(second.store.list().map((g) => g.id)).toEqual(["g2"]);
    expect(second.store.pendingDeletions.get("g1")).toMatchObject({
      id: "g1",
      status: "cancelled",
    });
    await second.store.removeTombstone("g1");
    // Removing it twice is not an error.
    await second.store.removeTombstone("g1");
    expect(await second.log.listTombstones()).toEqual([]);
  });

  test("a goal id can be used again after its goal was deleted", async () => {
    const { service } = await open();
    await manualGoal(service, "g1", "First");
    await service.cancel("g1");
    await service.delete("g1");
    const again = await manualGoal(service, "g1", "Second");
    expect(again).toMatchObject({ title: "Second", status: "planning", lastSeq: 1 });
  });
});

describe("goal management in the Manager", () => {
  let env: GoalTestEnv;

  beforeEach(async () => {
    env = createGoalTestEnv();
    await env.init();
  });
  afterEach(() => env.cleanup());

  const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

  test("deleting a completed goal removes its worktrees and keeps its branches", async () => {
    env.script([task("a")]);
    const { store, manager, service } = await env.boot();
    service.attachActivityProbe(manager);
    await env.createGoal(store);
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.status).toBe("completed");
    const integration = goal.integration?.workspaceId;
    const changeSetWorkspace = goal.changeSets[0]?.workspaceId;

    const result = await service.delete("g1");
    expect(result.deleted).toBe(true);
    expect(env.harness.archived).toEqual(
      expect.arrayContaining([integration, changeSetWorkspace, goal.leadWorkspaceId]),
    );
    expect(result.retained).toEqual(
      expect.arrayContaining([
        { kind: "branch", name: goal.integration?.branch, reason: "Branches are never deleted" },
        { kind: "branch", name: goal.changeSets[0]?.branch, reason: "Branches are never deleted" },
      ]),
    );
    expect(result.retained.filter((r) => r.kind === "worktree")).toEqual([]);
  });

  test("a worktree with uncommitted changes is left in place and reported", async () => {
    const repo = await mkdtemp(join(tmpdir(), "paseo-goal-repo-"));
    try {
      env.script([task("a")]);
      const { store, manager, service } = await env.boot();
      service.attachActivityProbe(manager);
      await env.createGoal(store, { ...CONFIG, cwd: repo });
      await env.settle(manager);
      const integration = env.goalOf(store).integration;
      if (!integration) throw new Error("no integration");
      await mkdir(integration.cwd, { recursive: true });
      env.harness.git.dirty = true;

      const result = await service.delete("g1");
      expect(result.retained).toContainEqual({
        kind: "worktree",
        name: integration.cwd,
        reason: "It has uncommitted changes",
      });
      expect(env.harness.archived).not.toContain(integration.workspaceId);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("a deletion interrupted by a crash is finished at the next start", async () => {
    env.script([task("a")]);
    const first = await env.boot();
    await env.createGoal(first.store);
    await env.settle(first.manager);
    const integration = env.goalOf(first.store).integration?.workspaceId;
    await first.store.remove("g1");
    first.manager.stop();
    env.harness.archived = [];

    const second = await env.boot();
    expect(env.harness.archived).toContain(integration);
    expect(second.store.pendingDeletions.size).toBe(0);
    expect(await new GoalEventLog({ dir: env.logDir() }).listTombstones()).toEqual([]);
    expect(second.store.get("g1")).toBeUndefined();
  });

  test("a live goal cannot be deleted or archived", async () => {
    env.script([task("a")], () => "hold");
    const { store, manager, service } = await env.boot();
    service.attachActivityProbe(manager);
    await env.createGoal(store);
    await tick();
    await expect(service.delete("g1")).rejects.toThrow(/executing; stop it before/);
    await expect(service.archive("g1")).rejects.toThrow(/executing; stop it before/);
    await service.cancel("g1");
    await env.settle(manager);
    expect((await service.archive("g1")).archivedAt).toBeTruthy();
    expect((await service.delete("g1")).deleted).toBe(true);
  });

  test("when the run cap is full, a freed slot goes to the higher-priority goal", async () => {
    env.script([task("a")], () => "hold");
    const { store, service } = await env.boot(1);
    await env.createGoal(store, CONFIG, "g1");
    await tick();
    const workerOf = (goalId: string) =>
      env.harness.agents.filter(
        (a) => a.labels["paseo.goal-id"] === goalId && a.labels["paseo.goal-task"],
      );
    expect(workerOf("g1")).toHaveLength(1);

    // g2 is older than g3 and sorts first by id, so only priority puts g3 ahead.
    await service.create({
      goalId: "g2",
      title: "Low",
      objective: "",
      criteria: ["x"],
      config: CONFIG,
      priority: "low",
    });
    await tick(5);
    await service.create({
      goalId: "g3",
      title: "High",
      objective: "",
      criteria: ["x"],
      config: CONFIG,
      priority: "high",
    });
    await tick();
    expect(env.goalOf(store, "g2").status).toBe("executing");
    expect(env.goalOf(store, "g3").status).toBe("executing");
    expect(workerOf("g2")).toHaveLength(0);
    expect(workerOf("g3")).toHaveLength(0);

    const g1Worker = workerOf("g1")[0]?.agentId;
    env.harness.turns
      .find((t) => t.agentId === g1Worker)
      ?.resolve({ outcome: "completed", text: "done" });
    await tick();
    expect(workerOf("g3")).toHaveLength(1);
    expect(workerOf("g2")).toHaveLength(0);
  });
});
