import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type {
  ManagedProcessRecord,
  ManagedProcessRecordInput,
  ManagedProcessRegistry,
  ManagedProcessReapResult,
} from "../../../managed-processes/managed-processes.js";
import type { ProcessTerminator, TreeKillTarget } from "../../../utils/tree-kill.js";
import {
  buildBasicAuthHeader,
  OpenCodeV2ServerManager,
  type OpenCodeV2CommandPrefixResolver,
  type OpenCodeV2EventSourceInput,
  type OpenCodeV2PortAllocator,
  type OpenCodeV2ServerProcessSpawner,
} from "./server-manager.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenCodeV2ServerManager generations", () => {
  test("spawns opencode2 serve with OPENCODE_PASSWORD and waits for the v2 readiness line", async () => {
    const { manager, runtime } = createTestManager([4001]);

    const acquisition = await manager.acquireCurrent();

    expect(runtime.spawnCalls).toEqual([
      expect.objectContaining({
        command: "opencode2",
        args: ["serve", "--port", "4001"],
        options: expect.objectContaining({
          cwd: expect.stringContaining("opencode2-home"),
          envOverlay: expect.objectContaining({
            OPENCODE_PASSWORD: acquisition.server.password,
          }),
        }),
      }),
    ]);
    expect(acquisition.server.url).toBe("http://127.0.0.1:4001");
    expect(acquisition.server.port).toBe(4001);
    await acquisition.release();
  });

  test("exposes the Basic auth header built from the generated password", async () => {
    const { manager, runtime } = createTestManager([4002]);

    const acquisition = await manager.acquireCurrent();

    expect(acquisition.server.password).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    expect(acquisition.server.authorization).toBe(
      buildBasicAuthHeader(acquisition.server.password),
    );
    expect(acquisition.server.authorization).toBe(
      `Basic ${Buffer.from(`opencode:${acquisition.server.password}`, "utf8").toString("base64")}`,
    );
    expect(runtime.spawnCalls[0]?.options.envOverlay.OPENCODE_PASSWORD).toBe(
      acquisition.server.password,
    );
    await acquisition.release();
  });

  test("runs the server from an isolated opencode2 home, not the user home", async () => {
    const { manager, runtime } = createTestManager([4003]);

    const acquisition = await manager.acquireCurrent();

    const spawn = runtime.spawnCalls[0]!;
    expect(spawn.options.cwd).toContain("opencode2-home");
    expect(spawn.options.envOverlay.HOME).toBe(spawn.options.cwd);
    expect(spawn.options.envOverlay.XDG_CONFIG_HOME).toBe(path.join(spawn.options.cwd, ".config"));
    expect(spawn.options.envOverlay.XDG_DATA_HOME).toBe(
      path.join(spawn.options.cwd, ".local", "share"),
    );
    expect(spawn.options.envOverlay.XDG_CACHE_HOME).toBe(path.join(spawn.options.cwd, ".cache"));
    await acquisition.release();
  });

  test("shares one server across acquisitions until the last release", async () => {
    const { manager, runtime } = createTestManager([4004]);

    const first = await manager.acquireCurrent();
    const second = await manager.acquireCurrent();

    expect(first.server.url).toBe(second.server.url);
    expect(runtime.launchedPorts).toEqual([4004]);

    await first.release();
    expect(runtime.terminatedPorts).toEqual([]);

    await second.release();
    expect(runtime.terminatedPorts).toEqual([4004]);
  });

  test("release is idempotent", async () => {
    const { manager, runtime } = createTestManager([4005]);

    const acquisition = await manager.acquireCurrent();
    await acquisition.release();
    await acquisition.release();

    expect(runtime.terminatedPorts).toEqual([4005]);
  });

  test("rotation creates a new current server without killing a referenced old server", async () => {
    const { manager, runtime } = createTestManager([4006, 4007]);

    const oldAcquisition = await manager.acquireCurrent();
    const newAcquisition = await manager.acquireNew();

    expect(oldAcquisition.server.url).toBe("http://127.0.0.1:4006");
    expect(newAcquisition.server.url).toBe("http://127.0.0.1:4007");
    expect(runtime.terminatedPorts).toEqual([]);

    await newAcquisition.release();
    await oldAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4007, 4006]);
  });

  test("concurrent new-server acquisitions share one fresh generation", async () => {
    const { manager, runtime } = createTestManager([4008, 4009]);

    const initialAcquisition = await manager.acquireCurrent();
    await initialAcquisition.release();

    const [modelsAcquisition, modesAcquisition] = await Promise.all([
      manager.acquireNew(),
      manager.acquireNew(),
    ]);

    expect(modelsAcquisition.server.url).toBe("http://127.0.0.1:4009");
    expect(modesAcquisition.server.url).toBe("http://127.0.0.1:4009");
    expect(runtime.launchedPorts).toEqual([4008, 4009]);

    await modesAcquisition.release();
    await modelsAcquisition.release();
  });

  test("shutdown kills current and retired servers", async () => {
    const { manager, runtime } = createTestManager([4010, 4011]);

    await manager.acquireCurrent();
    await manager.acquireNew();

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4011, 4010]);
  });

  test("startup timeout kills the spawned server and removes its managed-process record", async () => {
    vi.useFakeTimers();
    const { manager, runtime } = createTestManager([4012], { autoAnnounce: false });

    const acquisition = manager.acquireCurrent();
    const failure = expect(acquisition).rejects.toThrow("OpenCode 2 server startup timeout");
    await runtime.settle();

    await vi.advanceTimersByTimeAsync(30_000);

    await failure;
    expect(runtime.terminatedPorts).toEqual([4012]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("startup failure surfaces a clear error when the process exits before ready", async () => {
    const { manager, runtime } = createTestManager([4013], { autoAnnounce: false });

    const acquisition = manager.acquireCurrent();
    await runtime.settle();
    runtime.processForPort(4013).exitNormally();

    await expect(acquisition).rejects.toThrow("OpenCode 2 server exited with code 0");
    expect(runtime.terminatedPorts).toEqual([]);
  });

  test("aborted acquisition transfers no reference and leaves startup reusable", async () => {
    const { manager, runtime } = createTestManager([4014], { autoAnnounce: false });
    const controller = new AbortController();

    const abortedAcquisition = manager.acquireCurrent(controller.signal);
    await runtime.settle();
    controller.abort(new Error("catalog refresh expired"));

    await expect(abortedAcquisition).rejects.toThrow("catalog refresh expired");
    runtime.processForPort(4014).announceListening();

    const nextAcquisition = await manager.acquireCurrent();
    expect(nextAcquisition.server.url).toBe("http://127.0.0.1:4014");
    expect(runtime.launchedPorts).toEqual([4014]);

    await nextAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([4014]);
  });

  test("dedicated server startup is protected from retired cleanup", async () => {
    const { manager, runtime } = createTestManager([4015, 4016], { autoAnnounce: false });

    const currentStart = manager.acquireCurrent();
    await runtime.settle();
    runtime.processForPort(4015).announceListening();
    const currentAcquisition = await currentStart;

    const dedicatedStart = manager.acquireDedicated({ TEST_ENV: "custom" });
    await runtime.settle();

    await currentAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([4015]);

    runtime.processForPort(4016).announceListening();
    const dedicatedAcquisition = await dedicatedStart;

    expect(dedicatedAcquisition.server.url).toBe("http://127.0.0.1:4016");

    await dedicatedAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([4015, 4016]);
  });

  test("acquireExisting keeps a retired dedicated server alive until every reference releases", async () => {
    const { manager, runtime } = createTestManager([4017]);

    const dedicatedAcquisition = await manager.acquireDedicated({ PASEO_AGENT_ID: "parent" });
    const existingAcquisition = manager.acquireExisting(dedicatedAcquisition.server.url);

    expect(existingAcquisition?.server.url).toBe("http://127.0.0.1:4017");

    await dedicatedAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([]);

    await existingAcquisition?.release();
    expect(runtime.terminatedPorts).toEqual([4017]);
  });

  test("acquireExisting returns null for unknown or dead server urls", async () => {
    const { manager, runtime } = createTestManager([4018]);

    const acquisition = await manager.acquireDedicated({ PASEO_AGENT_ID: "parent" });
    const url = acquisition.server.url;

    expect(manager.acquireExisting("http://127.0.0.1:9999")).toBe(null);

    await acquisition.release();
    expect(runtime.terminatedPorts).toEqual([4018]);
    expect(manager.acquireExisting(url)).toBe(null);
  });
});

describe("OpenCodeV2ServerManager server-exit detection", () => {
  test("publishes server-exited when the server process exits mid-session", async () => {
    const { manager, runtime } = createTestManager([4021]);

    const acquisition = await manager.acquireCurrent();
    const received: OpenCodeV2EventSourceInput[] = [];
    acquisition.events.subscribe((input) => received.push(input));

    runtime.processForPort(4021).exitNormally();
    await runtime.settle();

    expect(received).toEqual([
      {
        type: "server-exited",
        error: expect.objectContaining({ message: "OpenCode 2 server exited with code 0" }),
      },
    ]);
  });

  test("close stops publishing server-exited", async () => {
    const { manager, runtime } = createTestManager([4022]);

    const acquisition = await manager.acquireCurrent();
    const received: OpenCodeV2EventSourceInput[] = [];
    acquisition.events.subscribe((input) => received.push(input));

    await acquisition.events.close();
    runtime.processForPort(4022).exitNormally();
    await runtime.settle();

    expect(received).toEqual([]);
    await acquisition.release();
  });
});

describe("OpenCodeV2ServerManager managed process ledger", () => {
  test("records helper server starts and removes the record on process exit", async () => {
    const { manager, runtime } = createTestManager([4031]);

    await manager.acquireCurrent();

    expect(await runtime.managedProcesses.list()).toEqual([
      {
        id: "managed-process-1",
        owner: { provider: "opencode-v2", kind: "helper-server" },
        pid: 14031,
        command: "opencode2",
        args: ["serve", "--port", "4031"],
        metadata: { port: 4031 },
        identity: { commandLine: null, startedAt: null },
        createdAt: "test-created-at",
      },
    ]);

    runtime.processForPort(4031).exitNormally();
    await runtime.settle();

    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("removes helper server records on shutdown", async () => {
    const { manager, runtime } = createTestManager([4032]);

    await manager.acquireCurrent();

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4032]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("starts helper server from the isolated opencode2 home", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "opencode-v2-server-home-"));
    const opencodeV2HomeDir = path.join(tempDir, "opencode2-home");
    try {
      const { manager, runtime } = createTestManager([4033], { opencodeV2HomeDir });

      const acquisition = await manager.acquireCurrent();

      expect(runtime.spawnCalls).toEqual([
        expect.objectContaining({
          command: "opencode2",
          args: ["serve", "--port", "4033"],
          options: expect.objectContaining({ cwd: opencodeV2HomeDir }),
        }),
      ]);

      await acquisition.release();
      await manager.shutdown();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function createTestManager(
  ports: number[],
  options: {
    autoAnnounce?: boolean;
    opencodeV2HomeDir?: string;
  } = {},
): {
  manager: OpenCodeV2ServerManager;
  runtime: FakeOpenCodeV2ServerRuntime;
} {
  const { opencodeV2HomeDir } = options;
  const runtime = new FakeOpenCodeV2ServerRuntime(ports, {
    autoAnnounce: options.autoAnnounce ?? true,
  });
  return {
    manager: new OpenCodeV2ServerManager({
      logger: createTestLogger(),
      managedProcesses: runtime.managedProcesses,
      portAllocator: runtime.allocatePort,
      resolveCommandPrefix: runtime.resolveCommandPrefix,
      ...(opencodeV2HomeDir ? { resolveHomeDir: () => opencodeV2HomeDir } : {}),
      spawnServerProcess: runtime.spawnServerProcess,
      terminateProcess: runtime.terminateProcess,
    }),
    runtime,
  };
}

class FakeOpenCodeV2ServerRuntime {
  readonly managedProcesses = new FakeManagedProcesses();
  readonly terminatedPorts: number[] = [];
  readonly spawnCalls: Array<{
    command: string;
    args: string[];
    options: Parameters<OpenCodeV2ServerProcessSpawner>[2];
  }> = [];
  private readonly ports: number[];
  private readonly autoAnnounce: boolean;
  private readonly processesByChild = new Map<ChildProcess, FakeOpenCodeV2Process>();
  private readonly processesByPort = new Map<number, FakeOpenCodeV2Process>();

  constructor(ports: number[], options: { autoAnnounce: boolean }) {
    this.ports = [...ports];
    this.autoAnnounce = options.autoAnnounce;
  }

  get launchedPorts(): number[] {
    return Array.from(this.processesByPort.keys());
  }

  readonly allocatePort: OpenCodeV2PortAllocator = async () => {
    const port = this.ports.shift();
    if (!port) {
      throw new Error("No fake opencode2 port available");
    }
    return port;
  };

  readonly resolveCommandPrefix: OpenCodeV2CommandPrefixResolver = async () => ({
    command: "opencode2",
    args: [],
  });

  readonly spawnServerProcess: OpenCodeV2ServerProcessSpawner = (command, args, options) => {
    this.spawnCalls.push({ command, args, options });
    const port = Number(args.at(-1));
    const process = new FakeOpenCodeV2Process({ port, pid: 10_000 + port });
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

  processForPort(port: number): FakeOpenCodeV2Process {
    const process = this.processesByPort.get(port);
    if (!process) {
      throw new Error(`No fake opencode2 process for port ${port}`);
    }
    return process;
  }

  async settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  private processForChild(child: ChildProcess): FakeOpenCodeV2Process {
    const process = this.processesByChild.get(child);
    if (!process) {
      throw new Error("Unknown fake opencode2 process");
    }
    return process;
  }
}

class FakeOpenCodeV2Process extends EventEmitter {
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
    this.stdout.emit("data", Buffer.from(`server listening on http://127.0.0.1:${this.port}`));
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
