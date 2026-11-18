import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { GoalEventInput, TaskSpec } from "@getpaseo/protocol/goal/types";
import { GoalEventLog, GoalEventLogCorruptionError } from "./event-log.js";
import { GoalTransitionError } from "./goal-reducer.js";
import { GoalStore } from "./goal-store.js";

function task(id: string, dependsOn: string[] = []): TaskSpec {
  return { id, title: id, description: "", kind: "implement", dependsOn };
}

const created: GoalEventInput = {
  id: "ev-created",
  goalId: "g1",
  type: "goal.created",
  title: "Ship it",
  objective: "obj",
  criteria: [{ id: "c1", text: "tests pass" }],
};

describe("goal event log and store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-goal-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function open() {
    const log = new GoalEventLog({ dir });
    return { log, store: new GoalStore(log) };
  }

  test("assigns contiguous seq numbers and persists across a restart", async () => {
    const first = open();
    await first.store.dispatch("g1", created);
    await first.store.dispatch("g1", {
      id: "ev-plan",
      goalId: "g1",
      type: "plan.proposed",
      tasks: [task("a")],
    });

    const second = open();
    await second.store.recover();
    expect(second.store.get("g1")).toMatchObject({
      status: "awaiting_plan_approval",
      lastSeq: 2,
    });
    expect(second.store.list().map((g) => g.id)).toEqual(["g1"]);
  });

  test("a repeated event id is a no-op", async () => {
    const { store, log } = open();
    await store.dispatch("g1", created);
    const again = await store.dispatch("g1", created);
    expect(again.duplicate).toBe(true);
    expect(again.goal.lastSeq).toBe(1);
    expect(await log.read("g1")).toHaveLength(1);
  });

  test("duplicate delivery is still detected after a restart", async () => {
    await open().store.dispatch("g1", created);
    const { store } = open();
    await store.recover();
    expect((await store.dispatch("g1", created)).duplicate).toBe(true);
  });

  test("an illegal event is rejected and never written", async () => {
    const { store, log } = open();
    await store.dispatch("g1", created);
    await expect(
      store.dispatch("g1", { id: "ev-bad", goalId: "g1", type: "plan.approved" }),
    ).rejects.toThrow(GoalTransitionError);
    expect(await log.read("g1")).toHaveLength(1);
    expect(store.get("g1")?.lastSeq).toBe(1);
  });

  test("concurrent dispatches serialize into a gapless sequence", async () => {
    const { store, log } = open();
    await store.dispatch("g1", created);
    await store.dispatch("g1", {
      id: "ev-plan",
      goalId: "g1",
      type: "plan.proposed",
      tasks: [task("a"), task("b"), task("c")],
    });
    await store.dispatch("g1", { id: "ev-ok", goalId: "g1", type: "plan.approved" });
    await Promise.all(
      ["a", "b", "c"].map((taskId) =>
        store.dispatch("g1", {
          id: `ev-start-${taskId}`,
          goalId: "g1",
          type: "task.started",
          taskId,
        }),
      ),
    );
    expect((await log.read("g1")).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("a torn final line is truncated on load and appends continue", async () => {
    await open().store.dispatch("g1", created);
    await appendFile(join(dir, "g1.jsonl"), '{"id":"half","goalId":"g1","seq":2,"ty');

    const { store } = open();
    await store.recover();
    expect(store.get("g1")?.lastSeq).toBe(1);

    await store.dispatch("g1", {
      id: "ev-plan",
      goalId: "g1",
      type: "plan.proposed",
      tasks: [task("a")],
    });
    const lines = (await readFile(join(dir, "g1.jsonl"), "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? "").seq).toBe(2);
  });

  test("a corrupt log makes only that goal unavailable and does not abort recovery", async () => {
    const setup = open();
    await setup.store.dispatch("g1", created);
    await setup.store.dispatch("g2", { ...created, id: "g2:created", goalId: "g2" });
    await appendFile(join(dir, "g1.jsonl"), "not json\n");
    // A stray file in the directory is not a goal log.
    await appendFile(join(dir, "notes.backup.jsonl"), "whatever\n");

    const { store } = open();
    await store.recover();
    expect(store.get("g1")).toBeUndefined();
    expect(store.get("g2")?.id).toBe("g2");
    expect([...store.unreadable.keys()]).toEqual(["g1"]);
    expect(store.unreadable.get("g1")).toBeInstanceOf(GoalEventLogCorruptionError);
  });

  test("a gap in seq is reported as corruption", async () => {
    const { log } = open();
    await log.append("g1", created);
    const line = JSON.stringify({
      id: "x",
      goalId: "g1",
      seq: 3,
      at: "2026-01-01T00:00:00.000Z",
      type: "plan.approved",
    });
    await appendFile(join(dir, "g1.jsonl"), `${line}\n`);
    await expect(open().log.read("g1")).rejects.toThrow(/seq 3/);
  });

  test("rejects goal ids that could escape the log directory", async () => {
    const { log } = open();
    await expect(log.append("../evil", created)).rejects.toThrow(/Invalid goal id/);
  });

  test("a removed goal's log is tombstoned in one step and survives a restart as deleted", async () => {
    const first = open();
    await first.store.dispatch("g1", created);
    expect(await first.store.remove("g1")).toMatchObject({ id: "g1" });
    // Removing again finds nothing and writes nothing.
    expect(await first.store.remove("g1")).toBeNull();
    expect(await first.log.listGoalIds()).toEqual([]);
    expect(await first.log.listTombstones()).toEqual(["g1"]);
    // A torn line at the end of the tombstone is ignored, as on a live log.
    await appendFile(join(dir, "g1.jsonl.deleted"), '{"partial":');

    const second = open();
    await second.store.recover();
    expect(second.store.get("g1")).toBeUndefined();
    expect(second.store.pendingDeletions.get("g1")).toMatchObject({ id: "g1", title: "Ship it" });
    await second.store.removeTombstone("g1");
    expect(await second.log.listTombstones()).toEqual([]);
  });

  test("a guard can refuse a removal after queued events are applied", async () => {
    const { store, log } = open();
    await store.dispatch("g1", created);
    await expect(
      store.remove("g1", () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(store.get("g1")).toBeDefined();
    expect(await log.listGoalIds()).toEqual(["g1"]);
  });
});
