import { describe, expect, test, vi } from "vitest";

import {
  LifecycleMutationBusyError,
  LifecycleMutationCoordinator,
  LifecycleMutationDeadlineError,
  LifecycleMutationReentrancyError,
  LifecycleMutationShuttingDownError,
  LifecycleMutationStaleError,
} from "./lifecycle-mutation-coordinator.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function noop(): Promise<void> {}

function appendOrder(order: string[], value: string): () => Promise<void> {
  return async function append(): Promise<void> {
    order.push(value);
  };
}

async function runDetachedMutation(
  coordinator: LifecycleMutationCoordinator,
  gate: Promise<void>,
  order: string[],
): Promise<void> {
  await gate;
  await coordinator.run({ workspaceIds: ["workspace-1"] }, appendOrder(order, "detached"));
}

async function observeDrain(drain: Promise<void>, state: { drained: boolean }): Promise<void> {
  await drain;
  state.drained = true;
}

describe("LifecycleMutationCoordinator", () => {
  test("runs same-workspace mutations in admission order", async () => {
    const coordinator = new LifecycleMutationCoordinator();
    const firstBlocked = deferred();
    const firstStarted = deferred();
    const order: string[] = [];

    const first = coordinator.run({ workspaceIds: ["workspace-1"] }, async () => {
      order.push("first-start");
      firstStarted.resolve();
      await firstBlocked.promise;
      order.push("first-end");
    });
    await firstStarted.promise;

    const second = coordinator.run({ workspaceIds: ["workspace-1"] }, async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);

    firstBlocked.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  test("rejects admission when a workspace queue is full", async () => {
    const coordinator = new LifecycleMutationCoordinator({ maxPendingPerWorkspace: 1 });
    const activeBlocked = deferred();
    const activeStarted = deferred();

    const active = coordinator.run({ workspaceIds: ["workspace-1"] }, async () => {
      activeStarted.resolve();
      await activeBlocked.promise;
    });
    await activeStarted.promise;
    const accepted = coordinator.run({ workspaceIds: ["workspace-1"] }, async () => {});

    await expect(
      coordinator.run({ workspaceIds: ["workspace-1"] }, async () => {}),
    ).rejects.toBeInstanceOf(LifecycleMutationBusyError);

    activeBlocked.resolve();
    await Promise.all([active, accepted]);
  });

  test("uses a monotonic deadline and never starts expired queued work", async () => {
    let now = 100;
    const coordinator = new LifecycleMutationCoordinator({ now: () => now });
    const activeBlocked = deferred();
    const activeStarted = deferred();
    const expiredOperation = vi.fn(async () => {});

    const active = coordinator.run({ workspaceIds: ["workspace-1"] }, async () => {
      activeStarted.resolve();
      await activeBlocked.promise;
    });
    await activeStarted.promise;
    const expired = coordinator.run(
      { workspaceIds: ["workspace-1"], timeoutMs: 10 },
      expiredOperation,
    );

    now = 111;
    activeBlocked.resolve();
    await active;
    await expect(expired).rejects.toBeInstanceOf(LifecycleMutationDeadlineError);
    expect(expiredOperation).not.toHaveBeenCalled();
  });

  test("validates exact lifecycle identity after waiting in the lane", async () => {
    const coordinator = new LifecycleMutationCoordinator();
    const activeBlocked = deferred();
    const activeStarted = deferred();
    let current = {
      workspaceId: "workspace-1",
      agentId: "agent-1",
      incarnation: "incarnation-1",
      revision: 4,
    };
    const operation = vi.fn(async () => {});

    const active = coordinator.run({ workspaceIds: ["workspace-1"] }, async () => {
      activeStarted.resolve();
      await activeBlocked.promise;
    });
    await activeStarted.promise;
    const stale = coordinator.run(
      {
        workspaceIds: ["workspace-1"],
        validation: {
          expected: current,
          readCurrent: async () => current,
        },
      },
      operation,
    );

    current = { ...current, incarnation: "incarnation-2", revision: 5 };
    activeBlocked.resolve();
    await active;
    await expect(stale).rejects.toBeInstanceOf(LifecycleMutationStaleError);
    expect(operation).not.toHaveBeenCalled();
  });

  test("allows a mutation to reenter a workspace it already owns", async () => {
    const coordinator = new LifecycleMutationCoordinator({ maxPendingPerWorkspace: 0 });
    const order: string[] = [];

    await coordinator.run({ workspaceIds: ["workspace-1"] }, async () => {
      order.push("outer-start");
      await coordinator.run({ workspaceIds: ["workspace-1"] }, appendOrder(order, "inner"));
      order.push("outer-end");
    });

    expect(order).toEqual(["outer-start", "inner", "outer-end"]);
  });

  test("rejects nested acquisition of an additional workspace", async () => {
    const coordinator = new LifecycleMutationCoordinator();

    await coordinator.run({ workspaceIds: ["workspace-1"] }, async () => {
      await expect(
        coordinator.run({ workspaceIds: ["workspace-1", "workspace-2"] }, noop),
      ).rejects.toBeInstanceOf(LifecycleMutationReentrancyError);
    });
  });

  test("does not let detached async work retain lane ownership", async () => {
    const coordinator = new LifecycleMutationCoordinator();
    const detachedGate = deferred();
    const activeGate = deferred();
    const activeStarted = deferred();
    const order: string[] = [];
    let detached: Promise<void> | null = null;

    await coordinator.run({ workspaceIds: ["workspace-1"] }, async () => {
      detached = runDetachedMutation(coordinator, detachedGate.promise, order);
    });

    const active = coordinator.run({ workspaceIds: ["workspace-1"] }, async () => {
      order.push("active-start");
      activeStarted.resolve();
      await activeGate.promise;
      order.push("active-end");
    });
    await activeStarted.promise;
    detachedGate.resolve();
    await Promise.resolve();
    expect(order).toEqual(["active-start"]);

    activeGate.resolve();
    await Promise.all([active, detached]);
    expect(order).toEqual(["active-start", "active-end", "detached"]);
  });

  test("acquires multiple workspaces as one deterministic turn", async () => {
    const coordinator = new LifecycleMutationCoordinator();
    const firstBlocked = deferred();
    const firstStarted = deferred();
    const order: string[] = [];

    const first = coordinator.run({ workspaceIds: ["workspace-b"] }, async () => {
      order.push("b-start");
      firstStarted.resolve();
      await firstBlocked.promise;
      order.push("b-end");
    });
    await firstStarted.promise;
    const both = coordinator.run(
      { workspaceIds: ["workspace-b", "workspace-a", "workspace-a"] },
      async () => {
        order.push("both");
      },
    );
    const a = coordinator.run({ workspaceIds: ["workspace-a"] }, async () => {
      order.push("a");
    });

    await Promise.resolve();
    expect(order).toEqual(["b-start"]);
    firstBlocked.resolve();
    await Promise.all([first, both, a]);
    expect(order).toEqual(["b-start", "b-end", "both", "a"]);
  });

  test("closing admission drains accepted work without preempting an active side effect", async () => {
    const coordinator = new LifecycleMutationCoordinator();
    const activeBlocked = deferred();
    const activeStarted = deferred();
    const queuedOperation = vi.fn(async () => {});

    const active = coordinator.run({ workspaceIds: ["workspace-1"] }, async () => {
      activeStarted.resolve();
      await activeBlocked.promise;
    });
    await activeStarted.promise;
    const queued = coordinator.run({ workspaceIds: ["workspace-1"] }, queuedOperation);
    coordinator.closeAdmission();

    await expect(
      coordinator.run({ workspaceIds: ["workspace-2"] }, async () => {}),
    ).rejects.toBeInstanceOf(LifecycleMutationShuttingDownError);

    const drainState = { drained: false };
    const drain = observeDrain(coordinator.drain(), drainState);
    await Promise.resolve();
    expect(drainState.drained).toBe(false);
    expect(queuedOperation).not.toHaveBeenCalled();

    activeBlocked.resolve();
    await Promise.all([active, queued, drain]);
    expect(queuedOperation).toHaveBeenCalledOnce();
    expect(drainState.drained).toBe(true);
  });
});
