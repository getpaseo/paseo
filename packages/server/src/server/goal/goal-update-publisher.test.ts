import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoalSummary } from "@getpaseo/protocol/goal/types";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GoalEventLog } from "./event-log.js";
import type { Clock } from "./goal-limits.js";
import { GoalService } from "./goal-service.js";
import { GoalStore } from "./goal-store.js";
import { GoalUpdatePublisher } from "./goal-update-publisher.js";

/** A clock that only moves when the test advances it. */
function manualClock(): Clock & { advance(ms: number): void } {
  let now = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const timer = { at: now + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    advance(ms) {
      now += ms;
      for (const timer of timers) {
        if (timer.live && timer.at <= now) {
          timer.live = false;
          timer.fn();
        }
      }
    },
  };
}

const task = (id: string) => ({
  id,
  title: id,
  description: "",
  kind: "implement" as const,
  dependsOn: [],
});

describe("GoalUpdatePublisher", () => {
  let dir: string;
  let service: GoalService;
  let clock: ReturnType<typeof manualClock>;
  let pushed: GoalSummary[];
  let deleted: GoalSummary[];
  let publisher: GoalUpdatePublisher;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-goal-updates-"));
    const log = new GoalEventLog({ dir });
    service = new GoalService(new GoalStore(log), log);
    await service.start();
    clock = manualClock();
    pushed = [];
    deleted = [];
    publisher = new GoalUpdatePublisher({
      subscribe: (listener) => service.subscribe(listener),
      subscribeRemoved: (listener) => service.subscribeRemoved(listener),
      publish: (goal, options) => (options?.deleted ? deleted : pushed).push(goal),
      clock,
      windowMs: 250,
    });
  });
  afterEach(async () => {
    publisher.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("sends a change at once, then folds a burst into one push of the latest state", async () => {
    await service.create({ goalId: "g1", title: "T", objective: "", criteria: [] });
    expect(pushed.map((g) => g.status)).toEqual(["planning"]);
    expect(pushed[0]?.progress).toEqual({
      tasksTotal: 0,
      tasksDone: 0,
      tasksFailed: 0,
      tasksRunning: 0,
    });

    await service.proposePlan("g1", [task("a"), task("b")]);
    await service.approvePlan("g1");
    await service.cancel("g1");
    expect(pushed).toHaveLength(1);

    clock.advance(249);
    expect(pushed).toHaveLength(1);
    clock.advance(1);
    expect(pushed.map((g) => g.status)).toEqual(["planning", "cancelled"]);
    expect(pushed[1]?.progress?.tasksTotal).toBe(2);
    expect(pushed[1]?.lastSeq).toBe(4);

    // A quiet window has passed, so the next change goes out at once again.
    clock.advance(1_000);
    await service.acknowledge("g1");
    expect(pushed.map((g) => g.acknowledgedAt ?? null)).toEqual([null, null, expect.any(String)]);
  });

  test("each goal has its own window", async () => {
    await service.create({ goalId: "g1", title: "T", objective: "", criteria: [] });
    await service.create({ goalId: "g2", title: "T", objective: "", criteria: [] });
    expect(pushed.map((g) => g.id)).toEqual(["g1", "g2"]);
  });

  test("stops pushing once stopped, including a push waiting out its window", async () => {
    await service.create({ goalId: "g1", title: "T", objective: "", criteria: [] });
    await service.cancel("g1");
    publisher.stop();
    clock.advance(1_000);
    await service.acknowledge("g1");
    expect(pushed).toHaveLength(1);
  });

  test("a publish that throws does not stop later pushes", async () => {
    publisher.stop();
    let calls = 0;
    publisher = new GoalUpdatePublisher({
      subscribe: (listener) => service.subscribe(listener),
      publish: () => {
        calls += 1;
        throw new Error("socket closed");
      },
      clock,
    });
    await service.create({ goalId: "g1", title: "T", objective: "", criteria: [] });
    clock.advance(1_000);
    await service.cancel("g1");
    expect(calls).toBe(2);
  });

  test("every management change is pushed, and a deletion is pushed once with deleted set", async () => {
    await service.create({ goalId: "g1", title: "T", objective: "", criteria: [] });
    clock.advance(250);
    await service.rename("g1", "Renamed");
    clock.advance(250);
    await service.setPriority("g1", "high");
    clock.advance(250);
    await service.cancel("g1");
    clock.advance(250);
    await service.archive("g1");
    expect(pushed.map((g) => [g.title, g.priority, Boolean(g.archivedAt), g.status])).toEqual([
      ["T", undefined, false, "planning"],
      ["Renamed", undefined, false, "planning"],
      ["Renamed", "high", false, "planning"],
      ["Renamed", "high", false, "cancelled"],
      ["Renamed", "high", true, "cancelled"],
    ]);
    await service.unarchive("g1");
    // The unarchive is still waiting out its window when the goal is deleted; it is dropped.
    await service.delete("g1");
    clock.advance(250);
    expect(pushed).toHaveLength(5);
    expect(deleted.map((g) => g.id)).toEqual(["g1"]);
  });
});
