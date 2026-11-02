import { describe, expect, it } from "vitest";

import {
  ensureWorkspaceServicePortPlan,
  refreshWorkspaceServicePort,
  releaseWorkspaceServicePortPlan,
} from "./workspace-service-port-registry.js";

describe("ensureWorkspaceServicePortPlan", () => {
  it("allocates ports for all declared services in declaration order", async () => {
    let nextPort = 4100;
    let allocationCount = 0;
    const allocatedServices: string[] = [];

    const plan = await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-order-workspace",
      services: [{ scriptName: "api" }, { scriptName: "web" }, { scriptName: "worker" }],
      allocatePort: async ({ scriptName }) => {
        allocationCount += 1;
        allocatedServices.push(scriptName);
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
    expect(allocatedServices).toEqual(["api", "web", "worker"]);
  });

  it("extends the existing plan with newly declared services without reallocating peers", async () => {
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

    expect(Array.from(secondPlan.entries())).toEqual([
      ...firstPlan.entries(),
      ["new-service", 4300],
    ]);
    expect(allocationCount).toBe(3);
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

  it("extends a pending plan for a concurrent caller with another service", async () => {
    const allocation = createDeferredPort();
    const workspaceId = "registry-concurrent-extension-workspace";
    const firstPlan = ensureWorkspaceServicePortPlan({
      workspaceId,
      services: [{ scriptName: "backend-dev" }],
      allocatePort: async () => allocation.promise,
    });
    let allocations = 0;
    const secondPlan = ensureWorkspaceServicePortPlan({
      workspaceId,
      services: [{ scriptName: "backend-dev" }, { scriptName: "web" }],
      allocatePort: async () => {
        allocations += 1;
        return 6101;
      },
    });
    allocation.resolve(6100);
    expect(Array.from((await firstPlan).entries())).toEqual([["backend-dev", 6100]]);
    expect(Array.from((await secondPlan).entries())).toEqual([
      ["backend-dev", 6100],
      ["web", 6101],
    ]);
    expect(allocations).toBe(1);
    releaseWorkspaceServicePortPlan(workspaceId);
  });

  it("keeps the previous plan and reservations when an extension fails", async () => {
    const workspaceId = "registry-failed-extension-workspace";
    await ensureWorkspaceServicePortPlan({
      workspaceId,
      services: [{ scriptName: "backend-dev" }],
      allocatePort: async () => 6200,
    });
    let allocations = 0;
    await expect(
      ensureWorkspaceServicePortPlan({
        workspaceId,
        services: [{ scriptName: "backend-dev" }, { scriptName: "web" }, { scriptName: "worker" }],
        allocatePort: async () => {
          allocations += 1;
          if (allocations === 1) return 6201;
          throw new Error("Allocation failed");
        },
      }),
    ).rejects.toThrow("Allocation failed");
    const priorPlan = await ensureWorkspaceServicePortPlan({
      workspaceId,
      services: [{ scriptName: "backend-dev" }],
      allocatePort: async () => {
        throw new Error("Existing port must survive");
      },
    });
    expect(Array.from(priorPlan.entries())).toEqual([["backend-dev", 6200]]);
    const otherWorkspace = "registry-failed-extension-other-workspace";
    const reusedPlan = await ensureWorkspaceServicePortPlan({
      workspaceId: otherWorkspace,
      services: [{ scriptName: "web" }],
      allocatePort: async ({ reservedPorts }) => {
        expect(reservedPorts.has(6200)).toBe(true);
        expect(reservedPorts.has(6201)).toBe(false);
        return 6201;
      },
    });
    expect(reusedPlan.get("web")).toBe(6201);
    releaseWorkspaceServicePortPlan(workspaceId);
    releaseWorkspaceServicePortPlan(otherWorkspace);
  });

  it("rejects a new explicit port that collides with an existing service", async () => {
    const workspaceId = "registry-extension-explicit-collision-workspace";
    await ensureWorkspaceServicePortPlan({
      workspaceId,
      services: [{ scriptName: "backend-dev" }],
      allocatePort: async () => 6300,
    });
    await expect(
      ensureWorkspaceServicePortPlan({
        workspaceId,
        services: [{ scriptName: "backend-dev" }, { scriptName: "web", port: 6300 }],
        allocatePort: async () => 6301,
      }),
    ).rejects.toThrow("Service 'web' has a duplicate port 6300");
    const plan = await ensureWorkspaceServicePortPlan({
      workspaceId,
      services: [{ scriptName: "backend-dev" }, { scriptName: "web", port: 6301 }],
      allocatePort: async () => {
        throw new Error("No allocation needed");
      },
    });
    expect(Array.from(plan.entries())).toEqual([
      ["backend-dev", 6300],
      ["web", 6301],
    ]);
    releaseWorkspaceServicePortPlan(workspaceId);
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

  it("retries dynamic allocation when a port is already planned", async () => {
    const ports = [4400, 4400, 4401];

    const plan = await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-retry-duplicate-workspace",
      services: [{ scriptName: "api" }, { scriptName: "web" }],
      allocatePort: async () => {
        const port = ports.shift();
        if (port === undefined) throw new Error("Expected another allocated port");
        return port;
      },
    });

    expect(Array.from(plan.entries())).toEqual([
      ["api", 4400],
      ["web", 4401],
    ]);
  });

  it("rejects duplicate explicit ports", async () => {
    await expect(
      ensureWorkspaceServicePortPlan({
        workspaceId: "registry-duplicate-explicit-port-workspace",
        services: [
          { scriptName: "api", port: 4400 },
          { scriptName: "web", port: 4400 },
        ],
        allocatePort: async () => 4401,
      }),
    ).rejects.toThrow("Service 'web' has a duplicate port 4400");
  });

  it("reserves later explicit ports before allocating dynamic services", async () => {
    const plan = await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-later-explicit-port-workspace",
      services: [{ scriptName: "web" }, { scriptName: "api", port: 5500 }],
      allocatePort: async ({ reservedPorts }) => (reservedPorts.has(5500) ? 5501 : 5500),
    });

    expect(Array.from(plan.entries())).toEqual([
      ["web", 5501],
      ["api", 5500],
    ]);
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

  it("does not reserve the same dynamic port for separate workspaces", async () => {
    const firstPlan = await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-daemon-reservation-workspace-a",
      services: [{ scriptName: "api" }],
      allocatePort: async () => 5200,
    });
    const candidatePorts = [5200, 5201];
    const secondPlan = await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-daemon-reservation-workspace-b",
      services: [{ scriptName: "api" }],
      allocatePort: async () => {
        const port = candidatePorts.shift();
        if (port === undefined) throw new Error("Expected another allocated port");
        return port;
      },
    });

    expect(firstPlan.get("api")).toBe(5200);
    expect(secondPlan.get("api")).toBe(5201);
  });

  it("releases dynamic reservations with the workspace plan", async () => {
    await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-release-workspace-a",
      services: [{ scriptName: "api" }],
      allocatePort: async () => 5300,
    });

    releaseWorkspaceServicePortPlan("registry-release-workspace-a");

    const reusedPlan = await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-release-workspace-b",
      services: [{ scriptName: "api" }],
      allocatePort: async () => 5300,
    });
    expect(reusedPlan.get("api")).toBe(5300);
  });

  it("rolls back a plan released while allocation is pending", async () => {
    const allocation = createDeferredPort();
    const pendingPlan = ensureWorkspaceServicePortPlan({
      workspaceId: "registry-pending-release-workspace",
      services: [{ scriptName: "api" }],
      allocatePort: async () => await allocation.promise,
    });

    releaseWorkspaceServicePortPlan("registry-pending-release-workspace");
    allocation.resolve(5350);

    await expect(pendingPlan).rejects.toThrow("Workspace service port plan was released");

    const reusedPlan = await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-after-pending-release-workspace",
      services: [{ scriptName: "api" }],
      allocatePort: async () => 5350,
    });
    expect(reusedPlan.get("api")).toBe(5350);
  });

  it("rolls back dynamic reservations when plan creation fails", async () => {
    let allocationCount = 0;
    await expect(
      ensureWorkspaceServicePortPlan({
        workspaceId: "registry-failed-plan-workspace",
        services: [{ scriptName: "api" }, { scriptName: "web" }],
        allocatePort: async () => {
          allocationCount += 1;
          if (allocationCount === 1) return 5400;
          throw new Error("Allocation failed");
        },
      }),
    ).rejects.toThrow("Allocation failed");

    const recoveredPlan = await ensureWorkspaceServicePortPlan({
      workspaceId: "registry-after-failed-plan-workspace",
      services: [{ scriptName: "api" }],
      allocatePort: async () => 5400,
    });
    expect(recoveredPlan.get("api")).toBe(5400);
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

  it("preserves a concurrent service addition while refreshing a stopped service", async () => {
    const workspaceId = "registry-refresh-and-extend-workspace";
    await ensureWorkspaceServicePortPlan({
      workspaceId,
      services: [{ scriptName: "backend-dev" }],
      allocatePort: async () => 6400,
    });
    const allocation = createDeferredPort();
    const refreshing = refreshWorkspaceServicePort({
      workspaceId,
      service: { scriptName: "backend-dev" },
      allocatePort: async () => allocation.promise,
    });
    const extending = ensureWorkspaceServicePortPlan({
      workspaceId,
      services: [{ scriptName: "backend-dev" }, { scriptName: "web", port: 6402 }],
      allocatePort: async () => {
        throw new Error("Explicit addition needs no allocation");
      },
    });
    allocation.resolve(6401);
    expect(await refreshing).toBe(6401);
    await extending;
    const plan = await ensureWorkspaceServicePortPlan({
      workspaceId,
      services: [],
      allocatePort: async () => {
        throw new Error("No allocation needed");
      },
    });
    expect(Array.from(plan.entries())).toEqual([
      ["backend-dev", 6401],
      ["web", 6402],
    ]);
    releaseWorkspaceServicePortPlan(workspaceId);
  });

  it.each(["reused port", "allocation failure"])(
    "cancels a pending refresh and its waiter after workspace release (%s)",
    async (outcome) => {
      const workspaceId = "registry-cancelled-refresh-workspace";
      await ensureWorkspaceServicePortPlan({
        workspaceId,
        services: [{ scriptName: "api" }],
        allocatePort: async () => 6500,
      });
      const allocation = createDeferredPort();
      const refreshing = refreshWorkspaceServicePort({
        workspaceId,
        service: { scriptName: "api" },
        allocatePort: async () => {
          const port = await allocation.promise;
          if (outcome === "allocation failure") throw new Error("Allocation failed");
          return port;
        },
      });
      const waiting = refreshWorkspaceServicePort({
        workspaceId,
        service: { scriptName: "web", port: 6501 },
        allocatePort: async () => 6501,
      });
      const assertions = Promise.all([
        expect(refreshing).rejects.toThrow("Workspace service port plan was released"),
        expect(waiting).rejects.toThrow("Workspace service port plan was released"),
      ]);
      releaseWorkspaceServicePortPlan(workspaceId);
      allocation.resolve(6500);
      await assertions;
      const reusedPlan = await ensureWorkspaceServicePortPlan({
        workspaceId: "registry-after-cancelled-refresh-workspace",
        services: [{ scriptName: "api" }],
        allocatePort: async () => 6500,
      });
      expect(reusedPlan.get("api")).toBe(6500);
      releaseWorkspaceServicePortPlan("registry-after-cancelled-refresh-workspace");
    },
  );

  it("lets a waiting service restart allocate after another service's restart fails", async () => {
    const workspaceId = "registry-independent-refresh-failure-workspace";
    await ensureWorkspaceServicePortPlan({
      workspaceId,
      services: [{ scriptName: "api" }, { scriptName: "web" }],
      allocatePort: createSequentialPortAllocator(6600),
    });
    const allocation = createDeferredPort();
    const failedRefresh = refreshWorkspaceServicePort({
      workspaceId,
      service: { scriptName: "api" },
      allocatePort: async () => {
        await allocation.promise;
        throw new Error("API port script failed");
      },
    });
    const failedAssertion = expect(failedRefresh).rejects.toThrow("API port script failed");
    const waitingRefresh = refreshWorkspaceServicePort({
      workspaceId,
      service: { scriptName: "web" },
      allocatePort: async () => 6602,
    });
    allocation.resolve(0);
    await failedAssertion;
    expect(await waitingRefresh).toBe(6602);
    const plan = await ensureWorkspaceServicePortPlan({
      workspaceId,
      services: [],
      allocatePort: async () => {
        throw new Error("No allocation needed");
      },
    });
    expect(Array.from(plan.entries())).toEqual([
      ["api", 6600],
      ["web", 6602],
    ]);
    releaseWorkspaceServicePortPlan(workspaceId);
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
