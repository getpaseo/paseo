import { describe, expect, test } from "vitest";

import { AgentRunState } from "./agent-run-state.js";

function track(promise: Promise<void>): { readonly resolved: boolean } {
  const state = { resolved: false };
  void (async () => {
    await promise;
    state.resolved = true;
  })();
  return state;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("waitForForegroundStart", () => {
  test("resolves once the starting turn has an id", async () => {
    const runs = new AgentRunState();
    const run = runs.createPendingRun("agent");
    const wait = track(runs.waitForForegroundStart("agent"));

    await flushMicrotasks();
    expect(wait.resolved).toBe(false);

    runs.settleForegroundStart(run, { status: "started", turnId: "turn-1" });
    await flushMicrotasks();
    expect(wait.resolved).toBe(true);
  });

  test("waits for a failed start's run to be cleared", async () => {
    const runs = new AgentRunState();
    const run = runs.createPendingRun("agent");
    const wait = track(runs.waitForForegroundStart("agent"));

    runs.settleForegroundStart(run, { status: "failed", error: "start failed" });
    await flushMicrotasks();
    expect(wait.resolved).toBe(false);
    expect(runs.hasPendingRun("agent")).toBe(true);

    runs.settleForegroundRun("agent", run.token);
    await flushMicrotasks();
    expect(wait.resolved).toBe(true);
  });

  test("resolves at once when no turn is starting", async () => {
    const runs = new AgentRunState();
    await expect(runs.waitForForegroundStart("agent")).resolves.toBeUndefined();
  });
});
