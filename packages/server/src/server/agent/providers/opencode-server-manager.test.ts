import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type {
  ManagedProcessRecord,
  ManagedProcessRecordInput,
  ManagedProcessRegistry,
  ManagedProcessReapResult,
} from "../../managed-processes/managed-processes.js";
import type { ProcessTerminator, TreeKillTarget } from "../../../utils/tree-kill.js";
import {
  OpenCodeServerManager,
  type OpenCodeCommandPrefixResolver,
  type OpenCodePortAllocator,
  type OpenCodeServerProcessSpawner,
} from "./opencode/server-manager.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenCodeServerManager generations", () => {
  test("rotation creates a new current server without killing a referenced old server", async () => {
    const { manager, runtime } = createTestManager([4101, 4102]);

    const oldAcquisition = await manager.acquireCurrent();
    const newAcquisition = await manager.acquireNew();

    expect(oldAcquisition.server.url).toBe("http://127.0.0.1:4101");
    expect(newAcquisition.server.url).toBe("http://127.0.0.1:4102");
    expect(runtime.terminatedPorts).toEqual([]);

    newAcquisition.release();
    oldAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4101]);
  });

  test("new acquisitions after rotation use the new server", async () => {
    const { manager, runtime } = createTestManager([4201, 4202]);

    const oldAcquisition = await manager.acquireCurrent();
    const rotatedAcquisition = await manager.acquireNew();
    rotatedAcquisition.release();

    const nextAcquisition = await manager.acquireCurrent();

    expect(nextAcquisition.server.url).toBe("http://127.0.0.1:4202");
    expect(runtime.terminatedPorts).toEqual([]);

    nextAcquisition.release();
    oldAcquisition.release();
  });

  test("current acquisitions use cwd-specific helper servers", async () => {
    const { manager, runtime } = createTestManager([4211, 4212]);

    const firstAcquisition = await manager.acquireCurrent({ cwd: "/workspace/one" });
    const secondAcquisition = await manager.acquireCurrent({ cwd: "/workspace/two" });

    expect(firstAcquisition.server.url).toBe("http://127.0.0.1:4211");
    expect(secondAcquisition.server.url).toBe("http://127.0.0.1:4212");
    expect(runtime.launches).toEqual([
      { port: 4211, cwd: "/workspace/one" },
      { port: 4212, cwd: "/workspace/two" },
    ]);
    expect(runtime.terminatedPorts).toEqual([]);

    secondAcquisition.release();
    firstAcquisition.release();

    const firstAgain = await manager.acquireCurrent({ cwd: "/workspace/one" });
    expect(firstAgain.server.url).toBe("http://127.0.0.1:4211");
    firstAgain.release();
    expect(runtime.terminatedPorts).toEqual([]);
  });

  test("concurrent current acquisitions for different cwd do not retire each other", async () => {
    const { manager, runtime } = createTestManager([4221, 4222], { autoAnnounce: false });

    const firstStart = manager.acquireCurrent({ cwd: "/workspace/one" });
    await runtime.settle();
    const secondStart = manager.acquireCurrent({ cwd: "/workspace/two" });
    await runtime.settle();

    expect(runtime.launches).toEqual([
      { port: 4221, cwd: "/workspace/one" },
      { port: 4222, cwd: "/workspace/two" },
    ]);
    expect(runtime.terminatedPorts).toEqual([]);

    runtime.processForPort(4221).announceListening();
    runtime.processForPort(4222).announceListening();
    const [firstAcquisition, secondAcquisition] = await Promise.all([firstStart, secondStart]);

    expect(firstAcquisition.server.url).toBe("http://127.0.0.1:4221");
    expect(secondAcquisition.server.url).toBe("http://127.0.0.1:4222");
    expect(runtime.terminatedPorts).toEqual([]);

    firstAcquisition.release();
    secondAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([]);
  });

  test("concurrent new-server acquisitions share one fresh generation", async () => {
    const { manager, runtime } = createTestManager([4251, 4252, 4253]);

    const initialAcquisition = await manager.acquireCurrent();
    initialAcquisition.release();

    const [modelsAcquisition, modesAcquisition] = await Promise.all([
      manager.acquireNew(),
      manager.acquireNew(),
    ]);

    expect(modelsAcquisition.server.url).toBe("http://127.0.0.1:4252");
    expect(modesAcquisition.server.url).toBe("http://127.0.0.1:4252");
    expect(runtime.launchedPorts).toEqual([4251, 4252]);

    modesAcquisition.release();
    modelsAcquisition.release();
  });

  test("new acquisitions for the same cwd coalesce before the fresh helper is listening", async () => {
    const { manager, runtime } = createTestManager([4261, 4262], { autoAnnounce: false });

    const firstStart = manager.acquireNew({ cwd: "/workspace/repo" });
    await runtime.settle();
    const secondStart = manager.acquireNew({ cwd: "/workspace/repo" });
    await runtime.settle();

    expect(runtime.launches).toEqual([{ port: 4261, cwd: "/workspace/repo" }]);
    expect(runtime.terminatedPorts).toEqual([]);

    runtime.processForPort(4261).announceListening();
    const [firstAcquisition, secondAcquisition] = await Promise.all([firstStart, secondStart]);

    expect(firstAcquisition.server.url).toBe("http://127.0.0.1:4261");
    expect(secondAcquisition.server.url).toBe("http://127.0.0.1:4261");
    expect(runtime.terminatedPorts).toEqual([]);

    secondAcquisition.release();
    firstAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([]);
  });

  test("release is idempotent", async () => {
    const { manager, runtime } = createTestManager([4301, 4302]);

    const oldAcquisition = await manager.acquireCurrent();
    const newAcquisition = await manager.acquireNew();
    newAcquisition.release();

    oldAcquisition.release();
    oldAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4301]);
  });

  test("shutdown kills current and retired servers", async () => {
    const { manager, runtime } = createTestManager([4401, 4402]);

    await manager.acquireCurrent();
    await manager.acquireNew();

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4402, 4401]);
  });

  test("shutdown still signals a process after an earlier kill signal if it has not exited", async () => {
    const { manager, runtime } = createTestManager([4451]);

    await manager.acquireCurrent();
    runtime.processForPort(4451).markKillSignalSent();

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4451]);
  });

  test("startup timeout kills the spawned server and removes its managed-process record", async () => {
    vi.useFakeTimers();
    const { manager, runtime } = createTestManager([4471], { autoAnnounce: false });

    const acquisition = manager.acquireCurrent();
    const failure = expect(acquisition).rejects.toThrow("OpenCode server startup timeout");
    await runtime.settle();

    await vi.advanceTimersByTimeAsync(30_000);

    await failure;
    expect(runtime.terminatedPorts).toEqual([4471]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("shutdown kills a server that is still starting", async () => {
    const { manager, runtime } = createTestManager([4472], { autoAnnounce: false });

    const acquisition = manager.acquireCurrent();
    await runtime.settle();

    await manager.shutdown();

    await expect(acquisition).rejects.toThrow("OpenCode server exited with code null");
    expect(runtime.terminatedPorts).toEqual([4472]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("shutdown kills a server whose launch is still pending", async () => {
    const { manager, runtime } = createTestManager([4475], {
      autoAnnounce: false,
      deferFirstPort: true,
    });

    const acquisition = manager.acquireCurrent({ cwd: "/workspace/repo" });
    await runtime.settle();
    const shutdown = manager.shutdown();
    await runtime.settle();

    runtime.releaseNextPort();
    await shutdown;
    if (runtime.terminatedPorts.length === 0) {
      runtime.processForPort(4475).announceListening();
    }

    await expect(acquisition).rejects.toThrow("OpenCode server exited with code null");
    expect(runtime.terminatedPorts).toEqual([4475]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("shutdown kills a dedicated server whose launch is still pending", async () => {
    const { manager, runtime } = createTestManager([4476], {
      autoAnnounce: false,
      deferFirstPort: true,
    });

    const acquisition = manager.acquireDedicated(
      { TEST_ENV: "custom" },
      { cwd: "/workspace/repo" },
    );
    const acquisitionFailure = expect(acquisition).rejects.toThrow(
      "OpenCode server exited with code null",
    );
    await runtime.settle();
    const shutdown = manager.shutdown();
    await runtime.settle();

    runtime.releaseNextPort();
    await shutdown;

    await acquisitionFailure;
    expect(runtime.terminatedPorts).toEqual([4476]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("dedicated server startup is protected from retired cleanup", async () => {
    const { manager, runtime } = createTestManager([4473, 4474], { autoAnnounce: false });

    const currentStart = manager.acquireCurrent();
    await runtime.settle();
    runtime.processForPort(4473).announceListening();
    const currentAcquisition = await currentStart;

    const dedicatedStart = manager.acquireDedicated({ TEST_ENV: "custom" });
    await runtime.settle();

    currentAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([]);

    runtime.processForPort(4474).announceListening();
    const dedicatedAcquisition = await dedicatedStart;

    expect(dedicatedAcquisition.server.url).toBe("http://127.0.0.1:4474");

    dedicatedAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([4474]);
  });

  test("repeated rotations leave zero unreferenced retired servers", async () => {
    const { manager, runtime } = createTestManager([4501, 4502, 4503]);

    const firstAcquisition = await manager.acquireCurrent();
    const secondAcquisition = await manager.acquireNew();
    secondAcquisition.release();
    const thirdAcquisition = await manager.acquireNew();
    thirdAcquisition.release();
    firstAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4502, 4501]);
  });
});

describe("OpenCodeServerManager managed process ledger", () => {
  test("launches dedicated helpers from the requested cwd and records attribution metadata", async () => {
    const { manager, runtime } = createTestManager([4599]);

    await manager.acquireDedicated(
      { PASEO_AGENT_ID: "agent-1", PASEO_TEST_FLAG: "true" },
      { cwd: "/workspace/repo", agentId: "agent-1" },
    );

    expect(runtime.launches).toEqual([{ port: 4599, cwd: "/workspace/repo" }]);
    expect(await runtime.managedProcesses.list()).toEqual([
      {
        id: "managed-process-1",
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 14599,
        command: "opencode",
        args: ["serve", "--port", "4599"],
        metadata: { port: 4599, cwd: "/workspace/repo", agentId: "agent-1" },
        identity: { commandLine: null, startedAt: null },
        createdAt: "test-created-at",
      },
    ]);
  });

  test("records helper server starts and removes the record on process exit", async () => {
    const { manager, runtime } = createTestManager([4601]);

    await manager.acquireCurrent();

    expect(await runtime.managedProcesses.list()).toEqual([
      {
        id: "managed-process-1",
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 14601,
        command: "opencode",
        args: ["serve", "--port", "4601"],
        metadata: { port: 4601 },
        identity: { commandLine: null, startedAt: null },
        createdAt: "test-created-at",
      },
    ]);

    runtime.processForPort(4601).exitNormally();
    await runtime.settle();

    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("removes helper server records on shutdown", async () => {
    const { manager, runtime } = createTestManager([4602]);

    await manager.acquireCurrent();

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4602]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });
});

function createTestManager(
  ports: number[],
  options: { autoAnnounce?: boolean; deferFirstPort?: boolean } = {},
): {
  manager: OpenCodeServerManager;
  runtime: FakeOpenCodeServerRuntime;
} {
  const runtime = new FakeOpenCodeServerRuntime(ports, {
    autoAnnounce: options.autoAnnounce ?? true,
    deferFirstPort: options.deferFirstPort ?? false,
  });
  return {
    manager: new OpenCodeServerManager({
      logger: createTestLogger(),
      managedProcesses: runtime.managedProcesses,
      portAllocator: runtime.allocatePort,
      resolveCommandPrefix: runtime.resolveCommandPrefix,
      spawnServerProcess: runtime.spawnServerProcess,
      terminateProcess: runtime.terminateProcess,
    }),
    runtime,
  };
}

class FakeOpenCodeServerRuntime {
  readonly managedProcesses = new FakeManagedProcesses();
  readonly terminatedPorts: number[] = [];
  readonly launches: Array<{ port: number; cwd: string | undefined }> = [];
  private readonly ports: number[];
  private readonly autoAnnounce: boolean;
  private deferNextPort: boolean;
  private readonly pendingPortResolvers: Array<() => void> = [];
  private readonly processesByChild = new Map<ChildProcess, FakeOpenCodeProcess>();
  private readonly processesByPort = new Map<number, FakeOpenCodeProcess>();

  constructor(ports: number[], options: { autoAnnounce: boolean; deferFirstPort: boolean }) {
    this.ports = [...ports];
    this.autoAnnounce = options.autoAnnounce;
    this.deferNextPort = options.deferFirstPort;
  }

  get launchedPorts(): number[] {
    return Array.from(this.processesByPort.keys());
  }

  readonly allocatePort: OpenCodePortAllocator = async () => {
    if (this.deferNextPort) {
      this.deferNextPort = false;
      await new Promise<void>((resolve) => {
        this.pendingPortResolvers.push(resolve);
      });
    }
    const port = this.ports.shift();
    if (!port) {
      throw new Error("No fake OpenCode port available");
    }
    return port;
  };

  releaseNextPort(): void {
    const resolve = this.pendingPortResolvers.shift();
    if (!resolve) {
      throw new Error("No deferred port allocation pending");
    }
    resolve();
  }

  readonly resolveCommandPrefix: OpenCodeCommandPrefixResolver = async () => ({
    command: "opencode",
    args: [],
  });

  readonly spawnServerProcess: OpenCodeServerProcessSpawner = (command, args, options) => {
    const port = Number(args.at(-1));
    this.launches.push({
      port,
      cwd: typeof options.cwd === "string" ? options.cwd : undefined,
    });
    const process = new FakeOpenCodeProcess({ port, pid: 10_000 + port });
    this.processesByChild.set(process.child, process);
    this.processesByPort.set(port, process);
    if (this.autoAnnounce) {
      queueMicrotask(() => process.announceListening());
    }
    return process.child;
  };

  readonly terminateProcess: ProcessTerminator = async (target: TreeKillTarget) => {
    const process = this.processForChild(target as ChildProcess);
    this.terminatedPorts.push(process.port);
    process.exitBySignal("SIGTERM");
    return "terminated";
  };

  processForPort(port: number): FakeOpenCodeProcess {
    const process = this.processesByPort.get(port);
    if (!process) {
      throw new Error(`No fake OpenCode process for port ${port}`);
    }
    return process;
  }

  async settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  private processForChild(child: ChildProcess): FakeOpenCodeProcess {
    const process = this.processesByChild.get(child);
    if (!process) {
      throw new Error("Unknown fake OpenCode process");
    }
    return process;
  }
}

class FakeOpenCodeProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly child: ChildProcess;
  readonly port: number;
  readonly pid: number;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(options: { port: number; pid: number }) {
    super();
    this.port = options.port;
    this.pid = options.pid;
    this.child = this as unknown as ChildProcess;
  }

  announceListening(): void {
    this.stdout.emit("data", Buffer.from("listening on"));
  }

  exitNormally(): void {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }

  exitBySignal(signal: NodeJS.Signals): void {
    this.killed = true;
    this.signalCode = signal;
    this.emit("exit", null, signal);
  }

  markKillSignalSent(): void {
    this.killed = true;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.exitBySignal(signal ?? "SIGTERM");
    return true;
  }
}

class FakeManagedProcesses implements ManagedProcessRegistry {
  private records: ManagedProcessRecord[] = [];

  async record(input: ManagedProcessRecordInput): Promise<ManagedProcessRecord> {
    const record: ManagedProcessRecord = {
      id: `managed-process-${this.records.length + 1}`,
      ...input,
      metadata: input.metadata ?? {},
      identity: { commandLine: null, startedAt: null },
      createdAt: "test-created-at",
    };
    this.records.push(record);
    return record;
  }

  async remove(id: string): Promise<void> {
    this.records = this.records.filter((record) => record.id !== id);
  }

  async list(): Promise<ManagedProcessRecord[]> {
    return this.records;
  }

  async reapStale(): Promise<ManagedProcessReapResult> {
    return {
      checked: 0,
      dead: 0,
      mismatched: 0,
      removed: 0,
      terminated: 0,
      errors: [],
    };
  }
}
