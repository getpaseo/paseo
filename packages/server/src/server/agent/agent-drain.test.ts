import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { AgentManager } from "./agent-manager.js";
import { HostRestartingError } from "./host-restarting-error.js";
import { startAgentRun } from "./agent-prompt.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function setup(options?: { holdTurnFor?: (prompt: string) => Promise<void> | null }) {
  const manager = new AgentManager({
    clients: { claude: createTestAgentClient("claude", { holdTurnFor: options?.holdTurnFor }) },
    logger: createTestLogger(),
  });
  const agent = await manager.createAgent({ provider: "claude", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  return { manager, agent };
}

test("draining freezes prompt admission until draining is cleared", async () => {
  const { manager, agent } = await setup();
  try {
    expect(manager.isDraining()).toBe(false);
    expect(manager.assertAcceptingPrompts()).toBeUndefined();

    expect(manager.beginDraining()).toBeTruthy();
    expect(manager.isDraining()).toBe(true);
    expect(() => manager.assertAcceptingPrompts()).toThrow(HostRestartingError);

    // A second begin is a no-op: a caller must never start a second drain.
    expect(manager.beginDraining()).toBeNull();
    manager.endDraining();
    manager.endDraining();
    expect(manager.isDraining()).toBe(false);
    expect(manager.assertAcceptingPrompts()).toBeUndefined();
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("waitForAllIdle reports running agents, then resolves once the turn settles", async () => {
  const gate = deferred();
  const { manager, agent } = await setup({
    holdTurnFor: (prompt) => (prompt.includes("hold") ? gate.promise : null),
  });
  try {
    void startAgentRun(manager, agent.id, "hold this turn", createTestLogger());
    await vi.waitFor(() => expect(manager.hasInFlightRun(agent.id)).toBe(true));

    manager.beginDraining();
    const progress: string[][] = [];
    const wait = manager.waitForAllIdle({
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      onProgress: (state) => progress.push(state.agents.map((entry) => entry.agentId)),
    });

    // The wait must not resolve while the turn is still held.
    const settledEarly = await Promise.race([
      wait.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(settledEarly).toBe(false);
    expect(progress.some((ids) => ids.includes(agent.id))).toBe(true);

    gate.resolve();
    await expect(wait).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(manager.hasInFlightRun(agent.id)).toBe(false));
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("waitForAllIdle counts an in-progress prompt admission as drain work", async () => {
  const { manager, agent } = await setup();
  try {
    // A prompt passed the drain check and took a ticket just before the drain.
    const ticket = manager.beginAdmission();
    expect(manager.beginDraining()).toBeTruthy();

    // The drain rejects new prompts but admits the ticket holder, so the
    // pre-drain prompt runs instead of failing mid-receipt.
    expect(() => manager.assertAcceptingPrompts()).toThrow(HostRestartingError);
    expect(manager.assertAcceptingPrompts(ticket)).toBeUndefined();

    const progress: number[] = [];
    const wait = manager.waitForAllIdle({
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      onProgress: (state) => progress.push(state.pendingAdmissions),
    });
    const settledEarly = await Promise.race([
      wait.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(settledEarly).toBe(false);
    expect(progress.some((count) => count > 0)).toBe(true);

    await expect(
      startAgentRun(manager, agent.id, "pre-drain prompt", createTestLogger(), {
        admissionTicket: ticket,
      }),
    ).resolves.toBeDefined();

    manager.endAdmission(ticket);
    await expect(wait).resolves.toEqual({ ok: true });
  } finally {
    manager.endDraining();
    await manager.closeAgent(agent.id);
  }
});

test("permission follow-ups continue already-counted work during a drain", async () => {
  const { manager, agent } = await setup();
  try {
    manager.beginDraining();
    // The follow-up turn answering a human permission request is not a new
    // prompt; it must never be rejected by the drain.
    await expect(
      startAgentRun(manager, agent.id, "permission follow-up", createTestLogger(), {
        replaceRunning: true,
        permissionFollowUp: true,
      }),
    ).resolves.toBeDefined();
    // An ordinary prompt in the same state is still rejected.
    await expect(
      startAgentRun(manager, agent.id, "ordinary prompt", createTestLogger()),
    ).rejects.toBeInstanceOf(HostRestartingError);
  } finally {
    manager.endDraining();
    await manager.closeAgent(agent.id);
  }
});

test("waitForAllIdle returns the remaining agents after the deadline", async () => {
  const gate = deferred();
  const { manager, agent } = await setup({
    holdTurnFor: (prompt) => (prompt.includes("hold") ? gate.promise : null),
  });
  try {
    void startAgentRun(manager, agent.id, "hold this turn", createTestLogger());
    await vi.waitFor(() => expect(manager.hasInFlightRun(agent.id)).toBe(true));

    manager.beginDraining();
    const outcome = await manager.waitForAllIdle({ timeoutMs: 30, pollIntervalMs: 10 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.agents.map((entry) => entry.agentId)).toContain(agent.id);
      expect(outcome.pendingAdmissions).toBe(0);
    }
    gate.resolve();
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("waitForAllIdle cancels promptly when the requesting signal aborts", async () => {
  const gate = deferred();
  const { manager, agent } = await setup({
    holdTurnFor: (prompt) => (prompt.includes("hold") ? gate.promise : null),
  });
  try {
    void startAgentRun(manager, agent.id, "hold this turn", createTestLogger());
    await vi.waitFor(() => expect(manager.hasInFlightRun(agent.id)).toBe(true));

    manager.beginDraining();
    const controller = new AbortController();
    const wait = manager.waitForAllIdle({
      timeoutMs: 60_000,
      pollIntervalMs: 10,
      signal: controller.signal,
    });
    controller.abort();
    await expect(wait).rejects.toThrow("drain_canceled");
    manager.endDraining();
    expect(manager.isDraining()).toBe(false);
    gate.resolve();
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("endDraining aborts an active drain wait so a force restart owns the intent", async () => {
  const gate = deferred();
  const { manager, agent } = await setup({
    holdTurnFor: (prompt) => (prompt.includes("hold") ? gate.promise : null),
  });
  try {
    void startAgentRun(manager, agent.id, "hold this turn", createTestLogger());
    await vi.waitFor(() => expect(manager.hasInFlightRun(agent.id)).toBe(true));

    manager.beginDraining();
    const wait = manager.waitForAllIdle({ timeoutMs: 60_000, pollIntervalMs: 10 });
    manager.endDraining();
    await expect(wait).rejects.toThrow("drain_canceled");
    gate.resolve();
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("a superseded drain cannot end the newer drain that replaced it", async () => {
  const { manager, agent } = await setup();
  try {
    const ownerA = manager.beginDraining(60_000);
    expect(ownerA).not.toBeNull();

    // Force supersedes A globally, then B starts and owns the drain.
    manager.endDraining();
    const ownerB = manager.beginDraining(60_000);
    expect(ownerB).not.toBeNull();
    expect(manager.isDraining()).toBe(true);

    // A's cleanup must be a no-op while B owns the drain.
    manager.endDraining(ownerA!);
    expect(manager.isDraining()).toBe(true);
    expect(manager.getDrainDeadlineAt()).not.toBeNull();

    manager.endDraining(ownerB!);
    expect(manager.isDraining()).toBe(false);
  } finally {
    await manager.closeAgent(agent.id);
  }
});
