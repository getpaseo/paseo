import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { GoalConfig } from "@getpaseo/protocol/goal/types";
import { watchTurn } from "./goal-ports.js";
import { CONFIG, createGoalTestEnv, task, type GoalTestEnv } from "./goal-test-env.js";
import type { AgentManagerEvent } from "../agent/agent-manager.js";

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/** Regressions for the findings Codex's review of the upstream pull request raised. */
describe("codex review findings", () => {
  let env: GoalTestEnv;

  beforeEach(async () => {
    env = createGoalTestEnv();
    await env.init();
  });
  afterEach(() => env.cleanup());

  const h = () => env.harness;
  const cfg = (extra: Partial<GoalConfig> = {}): GoalConfig => ({ ...CONFIG, ...extra });

  test("a follow-up turn after an answered question decides the outcome and adds its usage", () => {
    const listeners: ((e: AgentManagerEvent) => void)[] = [];
    const subscribe = (l: (e: AgentManagerEvent) => void) => {
      listeners.push(l);
      return () => {};
    };
    const emit = (event: object) =>
      listeners.forEach((l) => l({ type: "agent_stream", agentId: "a", event } as never));
    const watcher = watchTurn(subscribe);

    emit({ type: "turn_started", provider: "p" });
    emit({
      type: "turn_completed",
      provider: "p",
      usage: { turnTotals: { inputTokens: 10, outputTokens: 5, costUsd: 0.1 } },
    });
    expect(watcher.end()).toEqual({ type: "turn_completed" });

    // The answer starts a second turn of the same run, and the person cancels it.
    emit({ type: "turn_started", provider: "p" });
    expect(watcher.end()).toBeNull();
    emit({ type: "usage_updated", provider: "p", usage: { turnTotals: { inputTokens: 4 } } });
    emit({ type: "turn_canceled", provider: "p", reason: "stopped" });
    expect(watcher.end()).toEqual({ type: "turn_canceled" });
    expect(watcher.usage()).toEqual({ inputTokens: 14, outputTokens: 5, costUsd: 0.1 });
  });

  test("a reviewer created after the goal was cancelled never starts a turn", async () => {
    let release: () => void = () => {};
    h().createHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    env.script([task("a")]);
    // Held reviewer turns are recorded, so a turn that should never start shows up.
    const answer = h().respond;
    h().respond = (turn) =>
      turn.prompt.includes("independent reviewer") ? "hold" : (answer?.(turn) ?? "hold");
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, cfg());
    await tick(150);
    expect(h().agents.some((a) => a.labels["paseo.goal-role"] === "reviewer")).toBe(false);

    await service.cancel("g1");
    release();
    await env.settle(manager).catch(() => undefined);
    await tick(100);

    const reviewer = h().agents.find((a) => a.labels["paseo.goal-role"] === "reviewer");
    expect(h().turns.filter((t) => t.agentId === reviewer?.agentId)).toHaveLength(0);
  });

  test("a verifier that edits its scratch worktree has its verdict discarded", async () => {
    env.script([task("a", { kind: "read" })]);
    env.stageReplies.verify = (turn) => {
      const scratch = h().workspaces.find((w) => w.title === "Ship (verify)");
      if (scratch) h().git.tracked.set(`${scratch.cwd}/${scratch.workspaceId}`, " M src/lib.rs");
      return {
        outcome: "completed",
        text: `\`\`\`json\n${JSON.stringify({
          criteria: [...turn.prompt.matchAll(/^- (\w+): /gm)].map((m) => ({
            id: m[1],
            met: true,
            evidence: "looked fine",
          })),
        })}\n\`\`\``,
      };
    };
    const { store, manager } = await env.boot();
    await env.createGoal(store, cfg({ baseCommit: "start-sha", maxAttempts: 1 }));
    await env.settle(manager).catch(() => undefined);
    const goal = env.goalOf(store);
    expect(goal.status).not.toBe("completed");
    expect(JSON.stringify(goal)).toMatch(/changed the scratch worktree/);
  });

  test("a pause that lands after the pump started launches nothing more", async () => {
    env.script([task("a"), task("b")], () => "hold");
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, cfg({ maxParallel: 1 }));
    await tick();
    expect(h().turns).toHaveLength(1);
    await service.pause("g1");

    // Whatever the pump still held a snapshot of, the reducer refuses a start while paused.
    await expect(
      store.dispatch("g1", { id: "late-start", goalId: "g1", type: "task.started", taskId: "b" }),
    ).rejects.toThrow(/paused/);
    expect(env.goalOf(store).tasks.find((t) => t.id === "b")?.status).toBe("pending");
    manager.stop();
  });
});
