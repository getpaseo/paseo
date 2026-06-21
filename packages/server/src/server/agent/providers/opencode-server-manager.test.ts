import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";

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

describe("OpenCodeServerManager generations", () => {
  test("rotation creates a new current server without killing a referenced old server", async () => {
    const { manager, runtime } = createTestManager([4101, 4102]);

    const oldAcquisition = await manager.acquire({ force: false });
    const newAcquisition = await manager.acquire({ force: true });

    expect(oldAcquisition.server.url).toBe("http://127.0.0.1:4101");
    expect(newAcquisition.server.url).toBe("http://127.0.0.1:4102");
    expect(runtime.terminatedPorts).toEqual([]);

    newAcquisition.release();
    oldAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4101]);
  });

  test("new acquisitions after rotation use the new server", async () => {
    const { manager, runtime } = createTestManager([4201, 4202]);

    const oldAcquisition = await manager.acquire({ force: false });
    const rotatedAcquisition = await manager.acquire({ force: true });
    rotatedAcquisition.release();

    const nextAcquisition = await manager.acquire({ force: false });

    expect(nextAcquisition.server.url).toBe("http://127.0.0.1:4202");
    expect(runtime.terminatedPorts).toEqual([]);

    nextAcquisition.release();
    oldAcquisition.release();
  });

  test("concurrent forced acquisitions share one fresh generation", async () => {
    const { manager, runtime } = createTestManager([4251, 4252, 4253]);

    const initialAcquisition = await manager.acquire({ force: false });
    initialAcquisition.release();

    const [modelsAcquisition, modesAcquisition] = await Promise.all([
      manager.acquire({ force: true }),
      manager.acquire({ force: true }),
    ]);

    expect(modelsAcquisition.server.url).toBe("http://127.0.0.1:4252");
    expect(modesAcquisition.server.url).toBe("http://127.0.0.1:4252");
    expect(runtime.launchedPorts).toEqual([4251, 4252]);

    modesAcquisition.release();
    modelsAcquisition.release();
  });

  test("release is idempotent", async () => {
    const { manager, runtime } = createTestManager([4301, 4302]);

    const oldAcquisition = await manager.acquire({ force: false });
    const newAcquisition = await manager.acquire({ force: true });
    newAcquisition.release();

    oldAcquisition.release();
    oldAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4301]);
  });

  test("shutdown kills current and retired servers", async () => {
    const { manager, runtime } = createTestManager([4401, 4402]);

    await manager.acquire({ force: false });
    await manager.acquire({ force: true });

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4402, 4401]);
  });

  test("shutdown still signals a process after an earlier kill signal if it has not exited", async () => {
    const { manager, runtime } = createTestManager([4451]);

    await manager.acquire({ force: false });
    runtime.processForPort(4451).markKillSignalSent();

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4451]);
  });

  test("repeated rotations leave zero unreferenced retired servers", async () => {
    const { manager, runtime } = createTestManager([4501, 4502, 4503]);

    const firstAcquisition = await manager.acquire({ force: false });
    const secondAcquisition = await manager.acquire({ force: true });
    secondAcquisition.release();
    const thirdAcquisition = await manager.acquire({ force: true });
    thirdAcquisition.release();
    firstAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4502, 4501]);
  });
});

describe("OpenCodeServerManager managed process ledger", () => {
  test("records helper server starts and removes the record on process exit", async () => {
    const { manager, runtime } = createTestManager([4601]);

    await manager.acquire({ force: false });

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

    await manager.acquire({ force: false });

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4602]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });
});

function createTestManager(ports: number[]): {
  manager: OpenCodeServerManager;
  runtime: FakeOpenCodeServerRuntime;
} {
  const runtime = new FakeOpenCodeServerRuntime(ports);
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
  private readonly ports: number[];
  private readonly processesByChild = new Map<ChildProcess, FakeOpenCodeProcess>();
  private readonly processesByPort = new Map<number, FakeOpenCodeProcess>();

  constructor(ports: number[]) {
    this.ports = [...ports];
  }

  get launchedPorts(): number[] {
    return Array.from(this.processesByPort.keys());
  }

  readonly allocatePort: OpenCodePortAllocator = async () => {
    const port = this.ports.shift();
    if (!port) {
      throw new Error("No fake OpenCode port available");
    }
    return port;
  };

  readonly resolveCommandPrefix: OpenCodeCommandPrefixResolver = async () => ({
    command: "opencode",
    args: [],
  });

  readonly spawnServerProcess: OpenCodeServerProcessSpawner = (command, args) => {
    const port = Number(args.at(-1));
    const process = new FakeOpenCodeProcess({ port, pid: 10_000 + port });
    this.processesByChild.set(process.child, process);
    this.processesByPort.set(port, process);
    queueMicrotask(() => process.announceListening());
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
