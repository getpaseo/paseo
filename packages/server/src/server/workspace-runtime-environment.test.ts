import net from "node:net";
import { describe, expect, it } from "vitest";
import { WorkspaceRuntimeEnvironmentService } from "./workspace-runtime-environment.js";

describe("WorkspaceRuntimeEnvironmentService", () => {
  it("shares one stable Compose name and port block across workspace commands", async () => {
    const [firstPort, secondPort] = await getFreePortPair();
    const service = new WorkspaceRuntimeEnvironmentService();
    const allocation = {
      range: `${Math.min(firstPort, secondPort)}-${Math.max(firstPort, secondPort)}`,
      blockSize: 1,
    };

    const first = await service.ensure({
      workspaceId: "workspace-one",
      cwd: process.cwd(),
      branchName: "feature/one",
      allocation,
    });
    const repeated = await service.ensure({
      workspaceId: "workspace-one",
      cwd: process.cwd(),
      branchName: "feature/one",
      allocation,
    });
    const second = await service.ensure({
      workspaceId: "workspace-two",
      cwd: process.cwd(),
      branchName: "feature/two",
      allocation,
    });

    expect(repeated.portBase).toBe(first.portBase);
    expect(repeated.composeProjectName).toBe(first.composeProjectName);
    expect(second.portBase).not.toBe(first.portBase);
    expect(first.env).toMatchObject({
      PASEO_WORKSPACE_ID: "workspace-one",
      PASEO_PORT_BASE: String(first.portBase),
      PASEO_PORT_END: String(first.portEnd),
      PASEO_PORT_COUNT: "1",
      PASEO_COMPOSE_PROJECT_NAME: first.composeProjectName,
      COMPOSE_PROJECT_NAME: first.composeProjectName,
    });

    service.release("workspace-one");
    service.release("workspace-two");
  });

  it("keeps explicit service ports outside the workspace block", async () => {
    const [firstPort, secondPort] = await getFreePortPair();
    const service = new WorkspaceRuntimeEnvironmentService();

    const environment = await service.ensure({
      workspaceId: "workspace-with-explicit-service",
      cwd: process.cwd(),
      branchName: "feature/explicit-service",
      allocation: { range: `${firstPort}-${secondPort}`, blockSize: 1 },
      excludedPorts: new Set([firstPort]),
    });

    expect(environment.portBase).toBe(secondPort);
    service.release("workspace-with-explicit-service");
  });

  it("serializes concurrent port block allocation across workspaces", async () => {
    const service = new WorkspaceRuntimeEnvironmentService({
      random: () => 0,
      checkPortAvailable: async () => true,
    });
    const allocation = { range: "40000-40001", blockSize: 1 };

    const [first, second] = await Promise.all([
      service.ensure({
        workspaceId: "workspace-concurrent-one",
        cwd: process.cwd(),
        branchName: "feature/concurrent-one",
        allocation,
      }),
      service.ensure({
        workspaceId: "workspace-concurrent-two",
        cwd: process.cwd(),
        branchName: "feature/concurrent-two",
        allocation,
      }),
    ]);

    expect([first.portBase, second.portBase].sort((left, right) => left - right)).toEqual([
      40000, 40001,
    ]);
    service.release("workspace-concurrent-one");
    service.release("workspace-concurrent-two");
  });

  it("does not resurrect a released environment after allocation is already in flight", async () => {
    const allocationStarted = createDeferred();
    const continueAllocation = createDeferred();
    let waitForFirstAvailabilityCheck = true;
    const service = new WorkspaceRuntimeEnvironmentService({
      checkPortAvailable: async () => {
        if (waitForFirstAvailabilityCheck) {
          waitForFirstAvailabilityCheck = false;
          allocationStarted.resolve();
          await continueAllocation.promise;
        }
        return true;
      },
    });
    const allocation = { range: "41000-41000", blockSize: 1 };
    const released = service.ensure({
      workspaceId: "workspace-released-during-allocation",
      cwd: process.cwd(),
      branchName: "feature/released",
      allocation,
    });

    await allocationStarted.promise;
    service.release("workspace-released-during-allocation");
    continueAllocation.resolve();

    await expect(released).rejects.toThrow("released during allocation");
    expect(service.get("workspace-released-during-allocation")).toBeNull();

    const replacement = await service.ensure({
      workspaceId: "workspace-reuses-released-block",
      cwd: process.cwd(),
      branchName: "feature/replacement",
      allocation,
    });
    expect(replacement.portBase).toBe(41000);
    service.release("workspace-reuses-released-block");
  });

  it("skips ephemeral candidates that cannot contain the requested port block", async () => {
    const candidates = [65500, 42000];
    const service = new WorkspaceRuntimeEnvironmentService({
      findFreePort: async () => {
        const candidate = candidates.shift();
        if (candidate === undefined) {
          throw new Error("Expected another ephemeral port candidate");
        }
        return candidate;
      },
      checkPortAvailable: async () => true,
    });

    const environment = await service.ensure({
      workspaceId: "workspace-ephemeral-retry",
      cwd: process.cwd(),
      branchName: "feature/ephemeral-retry",
      allocation: { blockSize: 100 },
    });

    expect(environment).toMatchObject({ portBase: 42000, portEnd: 42099, portCount: 100 });
    service.release("workspace-ephemeral-retry");
  });
});

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function getFreePortPair(): Promise<[number, number]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const first = await getFreePort();
    if (first === 65_535) continue;
    const firstServer = net.createServer();
    const secondServer = net.createServer();
    try {
      await listen(firstServer, first);
      await listen(secondServer, first + 1);
      return [first, first + 1];
    } catch {
      // Try a fresh ephemeral port when the adjacent one is occupied.
    } finally {
      await close(firstServer);
      await close(secondServer);
    }
  }
  throw new Error("Failed to reserve a free adjacent TCP port pair");
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to obtain free TCP port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return address.port;
}

async function listen(server: net.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

async function close(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
