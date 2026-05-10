import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeServerManager, type OpenCodeServerGeneration } from "./opencode/server-manager.js";

type FakeServerProcess = EventEmitter & {
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

type FakeGeneration = OpenCodeServerGeneration & { process: FakeServerProcess };

describe("OpenCodeServerManager generations", () => {
  test("rotation creates a new current server without killing a referenced old server", async () => {
    const manager = createTestManager();
    const first = createGeneration(4101);
    const second = createGeneration(4102);
    stubGenerations(manager, [first, second]);

    const oldAcquisition = await manager.acquire({ force: false });
    const newAcquisition = await manager.acquire({ force: true });

    expect(oldAcquisition.server.url).toBe("http://127.0.0.1:4101");
    expect(newAcquisition.server.url).toBe("http://127.0.0.1:4102");
    expect(first.process.kill).not.toHaveBeenCalled();
    expect(second.process.kill).not.toHaveBeenCalled();

    newAcquisition.release();
    oldAcquisition.release();

    expect(first.process.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("new acquisitions after rotation use the new server", async () => {
    const manager = createTestManager();
    const first = createGeneration(4201);
    const second = createGeneration(4202);
    stubGenerations(manager, [first, second]);

    const oldAcquisition = await manager.acquire({ force: false });
    const rotatedAcquisition = await manager.acquire({ force: true });
    rotatedAcquisition.release();

    const nextAcquisition = await manager.acquire({ force: false });

    expect(nextAcquisition.server.url).toBe("http://127.0.0.1:4202");
    expect(first.process.kill).not.toHaveBeenCalled();

    nextAcquisition.release();
    oldAcquisition.release();
  });

  test("concurrent forced acquisitions share one fresh generation", async () => {
    const manager = createTestManager();
    const first = createGeneration(4251);
    const second = createGeneration(4252);
    const third = createGeneration(4253);
    const startServer = stubGenerations(manager, [first, second, third]);

    const initialAcquisition = await manager.acquire({ force: false });
    initialAcquisition.release();

    const [modelsAcquisition, modesAcquisition] = await Promise.all([
      manager.acquire({ force: true }),
      manager.acquire({ force: true }),
    ]);

    expect(modelsAcquisition.server.url).toBe("http://127.0.0.1:4252");
    expect(modesAcquisition.server.url).toBe("http://127.0.0.1:4252");
    expect(startServer).toHaveBeenCalledTimes(2);

    modesAcquisition.release();
    modelsAcquisition.release();
  });

  test("release is idempotent", async () => {
    const manager = createTestManager();
    const first = createGeneration(4301);
    const second = createGeneration(4302);
    stubGenerations(manager, [first, second]);

    const oldAcquisition = await manager.acquire({ force: false });
    const newAcquisition = await manager.acquire({ force: true });
    newAcquisition.release();

    oldAcquisition.release();
    oldAcquisition.release();

    expect(first.refCount).toBe(0);
    expect(first.process.kill).toHaveBeenCalledTimes(1);
  });

  test("shutdown kills current and retired servers", async () => {
    const manager = createTestManager();
    const first = createGeneration(4401);
    const second = createGeneration(4402);
    stubGenerations(manager, [first, second]);

    await manager.acquire({ force: false });
    await manager.acquire({ force: true });

    await manager.shutdown();

    expect(first.process.kill).toHaveBeenCalledWith("SIGTERM");
    expect(second.process.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("repeated rotations leave zero unreferenced retired servers", async () => {
    const manager = createTestManager();
    const first = createGeneration(4501);
    const second = createGeneration(4502);
    const third = createGeneration(4503);
    stubGenerations(manager, [first, second, third]);

    const firstAcquisition = await manager.acquire({ force: false });
    const secondAcquisition = await manager.acquire({ force: true });
    secondAcquisition.release();
    const thirdAcquisition = await manager.acquire({ force: true });
    thirdAcquisition.release();
    firstAcquisition.release();

    const retiredServers = (manager as unknown as { retiredServers: Set<FakeGeneration> })
      .retiredServers;
    expect(Array.from(retiredServers).filter((server) => server.refCount === 0)).toHaveLength(0);
    expect(first.process.kill).toHaveBeenCalledTimes(1);
    expect(second.process.kill).toHaveBeenCalledTimes(1);
  });
});

function createTestManager(): OpenCodeServerManager {
  const ManagerConstructor = OpenCodeServerManager as unknown as {
    new (logger: ReturnType<typeof createTestLogger>): OpenCodeServerManager;
  };
  return new ManagerConstructor(createTestLogger());
}

function stubGenerations(
  manager: OpenCodeServerManager,
  generations: FakeGeneration[],
): ReturnType<typeof vi.fn> {
  const startServer = vi.fn(async () => {
    const generation = generations.shift();
    if (!generation) {
      throw new Error("No fake OpenCode server generation available");
    }
    return generation;
  });
  (manager as unknown as { startServer: typeof startServer }).startServer = startServer;
  return startServer;
}

function createGeneration(port: number): FakeGeneration {
  const process = new EventEmitter() as FakeServerProcess;
  process.killed = false;
  process.kill = vi.fn((signal?: NodeJS.Signals) => {
    process.killed = true;
    process.emit("exit", signal ?? "SIGTERM");
    return true;
  });
  return {
    process,
    port,
    url: `http://127.0.0.1:${port}`,
    refCount: 0,
    retired: false,
  };
}
