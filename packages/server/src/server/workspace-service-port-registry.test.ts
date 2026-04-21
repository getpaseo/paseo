import { describe, expect, it } from "vitest";

import {
  ensureWorkspaceServicePortPlan,
  refreshWorkspaceServicePort,
} from "./workspace-service-port-registry.js";

describe("ensureWorkspaceServicePortPlan", () => {
  it("allocates ports for all declared services in declaration order", async () => {
    let nextPort = 4100;
    let allocationCount = 0;

    const plan = await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-order-workspace",
      services: [{ scriptName: "api" }, { scriptName: "web" }, { scriptName: "worker" }],
      allocatePort: async () => {
        allocationCount += 1;
        const port = nextPort;
        nextPort += 1;
        return port;
      },
    });

    expect(Array.from(plan.entries())).toEqual([
      ["api", 4100],
      ["web", 4101],
      ["worker", 4102],
    ]);
    expect(allocationCount).toBe(3);
  });

  it("returns the existing plan without calling the allocator on later calls", async () => {
    let allocationCount = 0;

    const firstPlan = await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-first-wins-workspace",
      services: [{ scriptName: "api" }, { scriptName: "web" }],
      allocatePort: async () => {
        allocationCount += 1;
        return 4200 + allocationCount;
      },
    });

    const secondPlan = await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-first-wins-workspace",
      services: [{ scriptName: "new-service" }],
      allocatePort: async () => {
        allocationCount += 1;
        return 4300;
      },
    });

    expect(Array.from(secondPlan.entries())).toEqual(Array.from(firstPlan.entries()));
    expect(secondPlan.has("new-service")).toBe(false);
    expect(allocationCount).toBe(2);
  });

  it("shares one first-plan build across concurrent callers", async () => {
    let allocationCount = 0;
    const firstAllocation = createDeferredPort();
    const secondAllocation = createDeferredPort();

    const firstPlanPromise = ensureWorkspaceServicePortPlan({
      workspaceId: "registry-concurrent-first-plan-workspace",
      services: [{ scriptName: "api" }, { scriptName: "web" }],
      allocatePort: async () => {
        allocationCount += 1;
        if (allocationCount === 1) {
          return await firstAllocation.promise;
        }
        return await secondAllocation.promise;
      },
    });
    const secondPlanPromise = ensureWorkspaceServicePortPlan({
      workspaceId: "registry-concurrent-first-plan-workspace",
      services: [{ scriptName: "api" }, { scriptName: "web" }],
      allocatePort: async () => {
        allocationCount += 1;
        return 4300 + allocationCount;
      },
    });

    await Promise.resolve();
    expect(allocationCount).toBe(1);
    firstAllocation.resolve(4301);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(allocationCount).toBe(2);
    secondAllocation.resolve(4302);

    const [firstPlan, secondPlan] = await Promise.all([firstPlanPromise, secondPlanPromise]);

    expect(Array.from(firstPlan.entries())).toEqual([
      ["api", 4301],
      ["web", 4302],
    ]);
    expect(Array.from(secondPlan.entries())).toEqual(Array.from(firstPlan.entries()));
    expect(allocationCount).toBe(2);
  });

  it("uses explicit configured ports without calling the allocator", async () => {
    let allocationCount = 0;

    const plan = await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-explicit-port-workspace",
      services: [
        { scriptName: "api", port: 4410 },
        { scriptName: "web", port: 4411 },
      ],
      allocatePort: async () => {
        allocationCount += 1;
        return 4400;
      },
    });

    expect(Array.from(plan.entries())).toEqual([
      ["api", 4410],
      ["web", 4411],
    ]);
    expect(allocationCount).toBe(0);
  });

  it("keeps workspace plans independent", async () => {
    const firstPlan = await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-independent-workspace-a",
      services: [{ scriptName: "api" }],
      allocatePort: async () => 4500,
    });

    const secondPlan = await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-independent-workspace-b",
      services: [{ scriptName: "api" }],
      allocatePort: async () => 4600,
    });

    expect(firstPlan.get("api")).toBe(4500);
    expect(secondPlan.get("api")).toBe(4600);
  });

  it("returns defensive snapshots", async () => {
    const first = await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-defensive-snapshot-workspace",
      services: [{ scriptName: "api" }],
      allocatePort: async () => 4700,
    });

    const second = await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-defensive-snapshot-workspace",
      services: [],
      allocatePort: async () => 4701,
    });

    expect(first).not.toBe(second);
    expect(Array.from(first.entries())).toEqual([["api", 4700]]);
    expect(Array.from(second.entries())).toEqual(Array.from(first.entries()));
  });
});

describe("refreshWorkspaceServicePort", () => {
  it("reallocates only the named service", async () => {
    await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-refresh-workspace",
      services: [{ scriptName: "api" }, { scriptName: "web" }],
      allocatePort: createSequentialPortAllocator(4800),
    });

    const refreshedPort = await refreshWorkspaceServicePort({
      workspaceId: "registry-refresh-workspace",
      service: { scriptName: "api" },
      allocatePort: async () => 4900,
    });

    const snapshot = await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-refresh-workspace",
      services: [],
      allocatePort: async () => 4901,
    });

    expect(refreshedPort).toBe(4900);
    expect(Array.from(snapshot.entries())).toEqual([
      ["api", 4900],
      ["web", 4801],
    ]);
  });

  it("uses an explicit configured port without calling the allocator", async () => {
    let allocationCount = 0;

    await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-refresh-explicit-workspace",
      services: [{ scriptName: "api" }],
      allocatePort: async () => 5000,
    });

    const refreshedPort = await refreshWorkspaceServicePort({
      workspaceId: "registry-refresh-explicit-workspace",
      service: { scriptName: "api", port: 5100 },
      allocatePort: async () => {
        allocationCount += 1;
        return 5001;
      },
    });

    expect(refreshedPort).toBe(5100);
    expect(allocationCount).toBe(0);
  });
});

function createSequentialPortAllocator(startPort: number): () => Promise<number> {
  let nextPort = startPort;

  return async function allocatePort(): Promise<number> {
    const port = nextPort;
    nextPort += 1;
    return port;
  };
}

interface DeferredPort {
  promise: Promise<number>;
  resolve: (port: number) => void;
}

function createDeferredPort(): DeferredPort {
  let resolvePort: (port: number) => void = () => {};
  const promise = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });

  return {
    promise,
    resolve: resolvePort,
  };
}
