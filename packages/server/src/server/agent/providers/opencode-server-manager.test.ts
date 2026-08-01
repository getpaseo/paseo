import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { findExecutable } from "../../../executable-resolution/executable-resolution.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type {
  ManagedProcessRecord,
  ManagedProcessRecordInput,
  ManagedProcessRegistry,
  ManagedProcessReapResult,
} from "../../managed-processes/managed-processes.js";
import type {
  ProcessTerminator,
  TerminateWithTreeKillResult,
  TreeKillTarget,
} from "../../../utils/tree-kill.js";
import {
  OpenCodeServerManager,
  type OpenCodeCommandPrefixResolver,
  type OpenCodeProcessIdentityVerifier,
  type OpenCodeProcessGroupIdentityVerifier,
  type OpenCodePortAllocator,
  type OpenCodeServerProcessSpawner,
} from "./opencode/server-manager.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenCodeServerManager generations", () => {
  test("uses an explicit base environment for the server process", async () => {
    const baseEnv = { HOME: "/isolated/home", PATH: "/isolated/bin" };
    const { manager, runtime } = createTestManager([4091], { baseEnv });

    const acquisition = await manager.acquireCurrent();

    expect(runtime.spawnCalls[0]?.options.baseEnv).toEqual(baseEnv);
    await acquisition.release();
  });

  test("rotation creates a new current server without killing a referenced old server", async () => {
    const { manager, runtime } = createTestManager([4101, 4102]);

    const oldAcquisition = await manager.acquireCurrent();
    const newAcquisition = await manager.acquireNew();

    expect(oldAcquisition.server.url).toBe("http://127.0.0.1:4101");
    expect(newAcquisition.server.url).toBe("http://127.0.0.1:4102");
    expect(runtime.terminatedPorts).toEqual([]);

    await newAcquisition.release();
    await oldAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4102, 4101]);
  });

  test("new acquisitions after rotation use the new server", async () => {
    const { manager, runtime } = createTestManager([4201, 4202]);

    const oldAcquisition = await manager.acquireCurrent();
    const rotatedAcquisition = await manager.acquireNew();
    const nextAcquisition = await manager.acquireCurrent();

    expect(nextAcquisition.server.url).toBe("http://127.0.0.1:4202");
    expect(runtime.terminatedPorts).toEqual([]);

    await rotatedAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([]);
    await nextAcquisition.release();
    await oldAcquisition.release();
  });

  test("concurrent new-server acquisitions share one fresh generation", async () => {
    const { manager, runtime } = createTestManager([4251, 4252, 4253]);

    const initialAcquisition = await manager.acquireCurrent();
    await initialAcquisition.release();

    const [modelsAcquisition, modesAcquisition] = await Promise.all([
      manager.acquireNew(),
      manager.acquireNew(),
    ]);

    expect(modelsAcquisition.server.url).toBe("http://127.0.0.1:4252");
    expect(modesAcquisition.server.url).toBe("http://127.0.0.1:4252");
    expect(runtime.launchedPorts).toEqual([4251, 4252]);

    await modesAcquisition.release();
    await modelsAcquisition.release();
  });

  test("release is idempotent", async () => {
    const { manager, runtime } = createTestManager([4301, 4302]);

    const oldAcquisition = await manager.acquireCurrent();
    const newAcquisition = await manager.acquireNew();
    await newAcquisition.release();

    await oldAcquisition.release();
    await oldAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4302, 4301]);
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

    await expect(acquisition).rejects.toThrow("OpenCode server terminated during startup");
    expect(runtime.terminatedPorts).toEqual([4472]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("shutdown invalidates readiness while exec confirmation is pending", async () => {
    const { manager, runtime } = createTestManager([4479], {
      autoAnnounce: false,
      managedProcessConfirmationPending: true,
    });
    const acquisition = manager.acquireCurrent();
    const failure = expect(acquisition).rejects.toThrow(
      "OpenCode server terminated during startup",
    );
    await runtime.settle();
    runtime.processForPort(4479).announceListening();
    await runtime.managedProcesses.waitForConfirmation();

    await manager.shutdown();
    await failure;

    runtime.managedProcesses.releaseConfirmation();
    await runtime.settle();
    expect(runtime.terminatedPorts).toEqual([4479]);
  });

  test.runIf(process.platform !== "win32")(
    "shutdown awaits process-group cleanup already started by leader exit",
    async () => {
      const { manager, runtime } = createTestManager([4480], {
        processGroupInspectionPending: true,
      });
      await manager.acquireCurrent();
      runtime.processForPort(4480).exitNormally();
      await runtime.waitForProcessGroupInspection();
      let shutdownComplete = false;

      const shutdown = manager.shutdown().then(() => {
        shutdownComplete = true;
        return undefined;
      });
      await runtime.settle();

      expect(shutdownComplete).toBe(false);
      runtime.releaseProcessGroupInspection();
      await shutdown;
      expect(await runtime.managedProcesses.list()).toEqual([]);
    },
  );

  test("shutdown waits for a launch before its server generation is registered", async () => {
    const { manager, runtime } = createTestManager([4477], {
      autoAnnounce: false,
      portAllocationPending: true,
    });
    const acquisition = manager.acquireNew();
    const acquisitionResult = acquisition.catch((error: unknown) => error);

    const shutdown = manager.shutdown();
    await runtime.settle();
    expect(runtime.launchedPorts).toEqual([]);

    runtime.releasePortAllocation();
    await shutdown;
    const error = await acquisitionResult;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("OpenCode server terminated during startup");
    expect(runtime.terminatedPorts).toEqual([4477]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("shutdown waits for a dedicated launch until it is registered as retired", async () => {
    const { manager, runtime } = createTestManager([4478], {
      autoAnnounce: false,
      portAllocationPending: true,
    });
    const acquisition = manager.acquireDedicated({ TEST_ENV: "custom" });
    const acquisitionResult = acquisition.catch((error: unknown) => error);

    const shutdown = manager.shutdown();
    await runtime.settle();
    expect(runtime.launchedPorts).toEqual([]);

    runtime.releasePortAllocation();
    await shutdown;
    const error = await acquisitionResult;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("OpenCode server terminated during startup");
    expect(runtime.terminatedPorts).toEqual([4478]);
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

    await currentAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([4473]);

    runtime.processForPort(4474).announceListening();
    const dedicatedAcquisition = await dedicatedStart;

    expect(dedicatedAcquisition.server.url).toBe("http://127.0.0.1:4474");

    await dedicatedAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([4473, 4474]);
  });

  test("acquireExisting keeps a retired dedicated server alive until every reference releases", async () => {
    const { manager, runtime } = createTestManager([4475]);

    const dedicatedAcquisition = await manager.acquireDedicated({ PASEO_AGENT_ID: "parent" });
    const existingAcquisition = manager.acquireExisting(dedicatedAcquisition.server.url);

    expect(existingAcquisition?.server.url).toBe("http://127.0.0.1:4475");

    await dedicatedAcquisition.release();
    expect(runtime.terminatedPorts).toEqual([]);

    await existingAcquisition?.release();
    expect(runtime.terminatedPorts).toEqual([4475]);
  });

  test("acquireExisting returns null for unknown or dead server urls", async () => {
    const { manager, runtime } = createTestManager([4476]);

    const acquisition = await manager.acquireDedicated({ PASEO_AGENT_ID: "parent" });
    const url = acquisition.server.url;

    expect(manager.acquireExisting("http://127.0.0.1:9999")).toBe(null);

    await acquisition.release();
    expect(runtime.terminatedPorts).toEqual([4476]);
    expect(manager.acquireExisting(url)).toBe(null);
  });

  test("repeated rotations leave zero unreferenced retired servers", async () => {
    const { manager, runtime } = createTestManager([4501, 4502, 4503]);

    const firstAcquisition = await manager.acquireCurrent();
    const secondAcquisition = await manager.acquireNew();
    await secondAcquisition.release();
    const thirdAcquisition = await manager.acquireNew();
    await thirdAcquisition.release();
    await firstAcquisition.release();

    expect(runtime.terminatedPorts).toEqual([4502, 4503, 4501]);
  });

  test("final release detaches the terminating generation before a concurrent acquire", async () => {
    const { manager, runtime } = createTestManager([4551, 4552]);

    const first = await manager.acquireCurrent();
    const release = first.release();
    const next = await manager.acquireCurrent();

    await release;
    expect(next.server.url).toBe("http://127.0.0.1:4552");
    expect(runtime.terminatedPorts).toEqual([4551]);

    await next.release();
  });
});

describe("OpenCodeServerManager managed process ledger", () => {
  test("records helper starts and cleans their process group on leader exit", async () => {
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
        lifecycle: {
          execTransition: process.platform !== "win32" ? "confirmed" : "none",
          terminationScope: process.platform === "win32" ? "process" : "process-group",
        },
        identity: {
          commandLine: "opencode serve --port 4601",
          startedAt: "test-process-start",
          token: process.platform !== "win32" ? "test-managed-process-token" : null,
        },
        createdAt: "test-created-at",
      },
    ]);

    runtime.processForPort(4601).exitNormally();
    await runtime.settle();

    if (process.platform !== "win32") {
      expect(runtime.terminatedPorts).toEqual([]);
    }
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test.runIf(process.platform !== "win32")(
    "does not signal a completed dedicated process group again on release",
    async () => {
      const { manager, runtime } = createTestManager([4605]);
      const acquisition = await manager.acquireDedicated({ PASEO_AGENT_ID: "parent" });

      runtime.processForPort(4605).exitNormally();
      await runtime.settle();
      await acquisition.release();

      expect(runtime.terminatedPorts).toEqual([]);
      expect(await runtime.managedProcesses.list()).toEqual([]);
    },
  );

  test("fails startup and terminates the helper when its durable record cannot be written", async () => {
    const { manager, runtime } = createTestManager([4607], {
      managedProcessRecordError: new Error("managed process ledger failed"),
    });

    await expect(manager.acquireCurrent()).rejects.toThrow("managed process ledger failed");

    expect(runtime.terminatedPorts).toEqual([4607]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("startup timeout does not wait for a pending durable record before cleanup", async () => {
    vi.useFakeTimers();
    const { manager, runtime } = createTestManager([4610], {
      managedProcessRecordPending: true,
    });
    const acquisition = manager.acquireCurrent();
    const failure = expect(acquisition).rejects.toThrow("OpenCode server startup timeout");
    await runtime.settle();

    await vi.advanceTimersByTimeAsync(30_000);

    await failure;
    expect(runtime.terminatedPorts).toEqual([4610]);
  });

  test("retains an unconfirmed cleanup for retry when durable recording also failed", async () => {
    const { manager, runtime } = createTestManager([4611], {
      managedProcessRecordError: new Error("managed process ledger failed"),
      terminationResult: "kill-timeout",
    });

    await expect(manager.acquireCurrent()).rejects.toThrow("managed process ledger failed");
    expect(runtime.terminatedPorts).toEqual([4611]);
    expect(await runtime.managedProcesses.list()).toHaveLength(1);

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4611, 4611]);
    runtime.setTerminationResult("terminated");
    await manager.shutdown();
  });

  test.runIf(process.platform === "win32")(
    "does not signal an unverified Windows PID when durable recording fails",
    async () => {
      const { manager, runtime } = createTestManager([4612], {
        managedProcessRecordError: new Error("managed process ledger failed"),
        processIdentityOwned: false,
      });

      await expect(manager.acquireCurrent()).rejects.toThrow("managed process ledger failed");

      expect(runtime.processIdentityChecks).toEqual(["managed-process-1"]);
      expect(runtime.terminatedPorts).toEqual([]);
      runtime.setProcessIdentityOwned(true);
      await manager.shutdown();
      expect(runtime.terminatedPorts).toEqual([4612]);
    },
  );

  test.runIf(process.platform === "win32")(
    "uses the original child handle for live Windows cleanup",
    async () => {
      const { manager, runtime } = createTestManager([4613]);
      await manager.acquireCurrent();

      await manager.shutdown();

      expect(runtime.terminationTargetPids).toEqual([undefined]);
      expect(runtime.terminatedPorts).toEqual([4613]);
    },
  );

  test("removes helper server records on shutdown", async () => {
    const { manager, runtime } = createTestManager([4602]);

    await manager.acquireCurrent();

    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4602]);
    expect(await runtime.managedProcesses.list()).toEqual([]);
  });

  test("keeps the helper record when shutdown cannot confirm process-group exit", async () => {
    const { manager, runtime } = createTestManager([4604], {
      terminationResult: "kill-timeout",
    });

    await manager.acquireCurrent();
    await manager.shutdown();

    expect(runtime.terminatedPorts).toEqual([4604]);
    expect(await runtime.managedProcesses.list()).toHaveLength(1);
    runtime.setTerminationResult("terminated");
    await manager.shutdown();
  });

  test.runIf(process.platform !== "win32")(
    "retains an unverifiable process group for a later cleanup retry",
    async () => {
      const { manager, runtime } = createTestManager([4606], {
        processGroupIdentityOwned: false,
      });

      await manager.acquireCurrent();
      await manager.shutdown();

      expect(runtime.processGroupIdentityChecks).toEqual([
        { processGroupId: 14606, identityToken: "test-managed-process-token" },
      ]);
      expect(runtime.terminatedPorts).toEqual([]);
      expect(await runtime.managedProcesses.list()).toHaveLength(1);

      runtime.setProcessGroupIdentityOwned(true);
      await manager.shutdown();

      expect(runtime.terminatedPorts).toEqual([4606]);
      expect(await runtime.managedProcesses.list()).toEqual([]);
    },
  );

  test.runIf(process.platform !== "win32")(
    "revalidates process-group ownership before force escalation",
    async () => {
      const { manager, runtime } = createTestManager([4608], {
        revalidateForceSignal: true,
      });

      await manager.acquireCurrent();
      await manager.shutdown();

      expect(runtime.processGroupIdentityChecks).toEqual([
        { processGroupId: 14608, identityToken: "test-managed-process-token" },
        { processGroupId: 14608, identityToken: "test-managed-process-token" },
      ]);
      expect(runtime.terminatedPorts).toEqual([4608]);
    },
  );

  test.runIf(process.platform === "win32")(
    "does not signal a reused Windows PID when process identity no longer matches",
    async () => {
      const { manager, runtime } = createTestManager([4609], {
        processIdentityOwned: false,
      });

      await manager.acquireCurrent();
      await manager.shutdown();

      expect(runtime.processIdentityChecks).toEqual(["managed-process-1"]);
      expect(runtime.terminatedPorts).toEqual([]);
      expect(await runtime.managedProcesses.list()).toHaveLength(1);
    },
  );

  test("starts helper server from opencode-home", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "opencode-server-home-"));
    const opencodeHomeDir = path.join(tempDir, "opencode-home");
    try {
      const { manager, runtime } = createTestManager([4603], { opencodeHomeDir });

      const acquisition = await manager.acquireCurrent();

      expect(runtime.spawnCalls).toEqual([
        expect.objectContaining({
          command: "opencode",
          args: ["serve", "--port", "4603"],
          options: expect.objectContaining({ cwd: opencodeHomeDir }),
        }),
      ]);

      await acquisition.release();
      await manager.shutdown();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe.runIf(process.platform === "win32")(
  "OpenCodeServerManager Windows OpenCode npm install",
  () => {
    test("starts the helper server from opencode.exe instead of the npm opencode.cmd shim", async () => {
      const detectedOpenCode = await findExecutable("opencode");
      expect(detectedOpenCode, "Windows CI must install opencode-ai before server tests").not.toBe(
        null,
      );
      expect(path.extname(detectedOpenCode!).toLowerCase()).toBe(".cmd");

      const tempDir = mkdtempSync(path.join(os.tmpdir(), "opencode-real-windows-"));
      const opencodeHomeDir = path.join(tempDir, "opencode-home");
      const managedProcesses = new FakeManagedProcesses();
      const manager = new OpenCodeServerManager({
        logger: createTestLogger(),
        managedProcesses,
        resolveHomeDir: () => opencodeHomeDir,
      });
      let acquiredPort: number | null = null;

      try {
        const acquisition = await manager.acquireDedicated({
          OPENCODE_AUTH_CONTENT: "{}",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_AUTOCOMPACT: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_PURE: "1",
          OPENCODE_TEST_HOME: path.join(tempDir, "test-home"),
        });
        acquiredPort = acquisition.server.port;

        const records = await managedProcesses.list();
        expect(records).toHaveLength(1);
        const record = records[0]!;
        expect(path.extname(record.command).toLowerCase()).toBe(".exe");
        expect(path.normalize(record.command).toLowerCase()).toContain(
          path.normalize("node_modules/opencode-ai/bin/opencode.exe").toLowerCase(),
        );
        expect(record.command.toLowerCase()).not.toBe(detectedOpenCode!.toLowerCase());
        expect(record.args).toEqual(["serve", "--port", String(acquiredPort)]);
      } finally {
        await manager.shutdown().catch(() => undefined);
        if (acquiredPort !== null) {
          await waitForClosedPort(acquiredPort, 5_000);
        }
        rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }, 60_000);
  },
);

function createTestManager(
  ports: number[],
  options: {
    autoAnnounce?: boolean;
    baseEnv?: Record<string, string>;
    opencodeHomeDir?: string;
    terminationResult?: TerminateWithTreeKillResult;
    processGroupIdentityOwned?: boolean;
    managedProcessRecordError?: Error;
    managedProcessRecordPending?: boolean;
    processIdentityOwned?: boolean;
    revalidateForceSignal?: boolean;
    portAllocationPending?: boolean;
    processGroupInspectionPending?: boolean;
    managedProcessConfirmationPending?: boolean;
  } = {},
): {
  manager: OpenCodeServerManager;
  runtime: FakeOpenCodeServerRuntime;
} {
  const { opencodeHomeDir } = options;
  const runtime = new FakeOpenCodeServerRuntime(ports, {
    autoAnnounce: options.autoAnnounce ?? true,
    terminationResult: options.terminationResult ?? "terminated",
    processGroupIdentityOwned: options.processGroupIdentityOwned ?? true,
    managedProcessRecordError: options.managedProcessRecordError,
    managedProcessRecordPending: options.managedProcessRecordPending ?? false,
    processIdentityOwned: options.processIdentityOwned ?? true,
    revalidateForceSignal: options.revalidateForceSignal ?? false,
    portAllocationPending: options.portAllocationPending ?? false,
    processGroupInspectionPending: options.processGroupInspectionPending ?? false,
    managedProcessConfirmationPending: options.managedProcessConfirmationPending ?? false,
  });
  return {
    manager: new OpenCodeServerManager({
      logger: createTestLogger(),
      baseEnv: options.baseEnv,
      managedProcesses: runtime.managedProcesses,
      portAllocator: runtime.allocatePort,
      resolveCommandPrefix: runtime.resolveCommandPrefix,
      ...(opencodeHomeDir ? { resolveHomeDir: () => opencodeHomeDir } : {}),
      spawnServerProcess: runtime.spawnServerProcess,
      terminateProcess: runtime.terminateProcess,
      createManagedProcessIdentityToken: () => "test-managed-process-token",
      verifyProcessGroupIdentity: runtime.verifyProcessGroupIdentity,
      verifyProcessIdentity: runtime.verifyProcessIdentity,
    }),
    runtime,
  };
}

class FakeOpenCodeServerRuntime {
  readonly managedProcesses: FakeManagedProcesses;
  readonly terminatedPorts: number[] = [];
  readonly processGroupIdentityChecks: Array<{
    processGroupId: number;
    identityToken: string;
  }> = [];
  readonly processIdentityChecks: string[] = [];
  readonly terminationTargetPids: Array<number | undefined> = [];
  readonly spawnCalls: Array<{
    command: string;
    args: string[];
    options: Parameters<OpenCodeServerProcessSpawner>[2];
  }> = [];
  private readonly ports: number[];
  private readonly autoAnnounce: boolean;
  private terminationResult: TerminateWithTreeKillResult;
  private processGroupIdentityOwned: boolean;
  private processIdentityOwned: boolean;
  private readonly revalidateForceSignal: boolean;
  private readonly portAllocationGate: Promise<void> | null;
  private releasePortAllocationGate: () => void = () => undefined;
  private readonly processGroupInspectionGate: Promise<void> | null;
  private releaseProcessGroupInspectionGate: () => void = () => undefined;
  private markProcessGroupInspectionStarted: () => void = () => undefined;
  private readonly processGroupInspectionStarted: Promise<void>;
  private readonly processesByChild = new Map<ChildProcess, FakeOpenCodeProcess>();
  private readonly processesByPort = new Map<number, FakeOpenCodeProcess>();

  constructor(
    ports: number[],
    options: {
      autoAnnounce: boolean;
      terminationResult: TerminateWithTreeKillResult;
      processGroupIdentityOwned: boolean;
      managedProcessRecordError?: Error;
      managedProcessRecordPending: boolean;
      processIdentityOwned: boolean;
      revalidateForceSignal: boolean;
      portAllocationPending: boolean;
      processGroupInspectionPending: boolean;
      managedProcessConfirmationPending: boolean;
    },
  ) {
    this.ports = [...ports];
    this.autoAnnounce = options.autoAnnounce;
    this.terminationResult = options.terminationResult;
    this.processGroupIdentityOwned = options.processGroupIdentityOwned;
    this.processIdentityOwned = options.processIdentityOwned;
    this.revalidateForceSignal = options.revalidateForceSignal;
    this.portAllocationGate = options.portAllocationPending
      ? new Promise<void>((resolve) => {
          this.releasePortAllocationGate = resolve;
        })
      : null;
    this.processGroupInspectionStarted = new Promise<void>((resolve) => {
      this.markProcessGroupInspectionStarted = resolve;
    });
    this.processGroupInspectionGate = options.processGroupInspectionPending
      ? new Promise<void>((resolve) => {
          this.releaseProcessGroupInspectionGate = resolve;
        })
      : null;
    this.managedProcesses = new FakeManagedProcesses(
      options.managedProcessRecordError,
      options.managedProcessRecordPending,
      options.managedProcessConfirmationPending,
    );
  }

  get launchedPorts(): number[] {
    return Array.from(this.processesByPort.keys());
  }

  readonly allocatePort: OpenCodePortAllocator = async () => {
    if (this.portAllocationGate) {
      await this.portAllocationGate;
    }
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

  readonly spawnServerProcess: OpenCodeServerProcessSpawner = (command, args, options) => {
    this.spawnCalls.push({ command, args, options });
    const port = Number(args.at(-1));
    const process = new FakeOpenCodeProcess({ port, pid: 10_000 + port });
    this.processesByChild.set(process.child, process);
    this.processesByPort.set(port, process);
    if (this.autoAnnounce) {
      queueMicrotask(() => process.announceListening());
    }
    return process.child;
  };

  readonly verifyProcessGroupIdentity: OpenCodeProcessGroupIdentityVerifier = async (
    processGroupId,
    identityToken,
  ) => {
    this.processGroupIdentityChecks.push({ processGroupId, identityToken });
    if (this.processGroupInspectionGate) {
      this.markProcessGroupInspectionStarted();
      await this.processGroupInspectionGate;
    }
    const process = Array.from(this.processesByPort.values()).find(
      (candidate) => candidate.pid === processGroupId,
    );
    if (process?.exitCode !== null || process.signalCode !== null) {
      return { status: "not-found" };
    }
    return this.processGroupIdentityOwned
      ? { status: "owned" }
      : { status: "unverifiable", message: "identity token mismatch" };
  };

  readonly verifyProcessIdentity: OpenCodeProcessIdentityVerifier = async (record) => {
    this.processIdentityChecks.push(record.id);
    return this.processIdentityOwned;
  };

  setProcessGroupIdentityOwned(owned: boolean): void {
    this.processGroupIdentityOwned = owned;
  }

  setProcessIdentityOwned(owned: boolean): void {
    this.processIdentityOwned = owned;
  }

  setTerminationResult(result: TerminateWithTreeKillResult): void {
    this.terminationResult = result;
  }

  releasePortAllocation(): void {
    this.releasePortAllocationGate();
  }

  waitForProcessGroupInspection(): Promise<void> {
    return this.processGroupInspectionStarted;
  }

  releaseProcessGroupInspection(): void {
    this.releaseProcessGroupInspectionGate();
  }

  readonly terminateProcess: ProcessTerminator = async (target: TreeKillTarget, options) => {
    this.terminationTargetPids.push(target.pid);
    if (options.beforeSignal && !(await options.beforeSignal("SIGTERM"))) {
      return "signal-skipped";
    }
    if (
      this.revalidateForceSignal &&
      options.beforeSignal &&
      !(await options.beforeSignal("SIGKILL"))
    ) {
      return "signal-skipped";
    }
    const process = this.processForTarget(target);
    this.terminatedPorts.push(process.port);
    if (
      this.terminationResult !== "kill-timeout" &&
      process.exitCode === null &&
      process.signalCode === null
    ) {
      process.exitBySignal("SIGTERM");
    }
    return this.terminationResult;
  };

  processForPort(port: number): FakeOpenCodeProcess {
    const process = this.processesByPort.get(port);
    if (!process) {
      throw new Error(`No fake OpenCode process for port ${port}`);
    }
    return process;
  }

  async settle(): Promise<void> {
    for (let turn = 0; turn < 6; turn += 1) {
      await Promise.resolve();
    }
  }

  private processForTarget(target: TreeKillTarget): FakeOpenCodeProcess {
    const childProcess = this.processesByChild.get(target as ChildProcess);
    if (childProcess) {
      return childProcess;
    }
    if (target.pid === undefined && target.once && target.off) {
      const listener = () => undefined;
      target.once("exit", listener);
      const process = Array.from(this.processesByPort.values()).find((candidate) =>
        candidate.listeners("exit").includes(listener),
      );
      target.off("exit", listener);
      if (process) {
        return process;
      }
    }
    const pid = Math.abs(target.pid ?? 0);
    const process = Array.from(this.processesByPort.values()).find(
      (candidate) => candidate.pid === pid,
    );
    if (!process) {
      throw new Error(`Unknown fake OpenCode process target: ${target.pid}`);
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

  constructor(
    private readonly recordError?: Error,
    private readonly recordPending = false,
    confirmationPending = false,
  ) {
    this.confirmationStarted = new Promise<void>((resolve) => {
      this.markConfirmationStarted = resolve;
    });
    this.confirmationGate = confirmationPending
      ? new Promise<void>((resolve) => {
          this.releaseConfirmationGate = resolve;
        })
      : null;
  }

  private readonly confirmationGate: Promise<void> | null;
  private releaseConfirmationGate: () => void = () => undefined;
  private markConfirmationStarted: () => void = () => undefined;
  private readonly confirmationStarted: Promise<void>;

  async record(
    input: ManagedProcessRecordInput,
    options?: { onIdentityCaptured?: (record: ManagedProcessRecord) => void },
  ): Promise<ManagedProcessRecord> {
    const { identityToken, ...recordInput } = input;
    const record: ManagedProcessRecord = {
      id: `managed-process-${this.records.length + 1}`,
      ...recordInput,
      metadata: input.metadata ?? {},
      lifecycle: input.lifecycle ?? {
        execTransition: "none",
        terminationScope: "process",
      },
      identity: {
        commandLine: [input.command, ...input.args].join(" "),
        startedAt: "test-process-start",
        token: identityToken ?? null,
      },
      createdAt: "test-created-at",
    };
    options?.onIdentityCaptured?.(record);
    if (this.recordPending) {
      await new Promise(() => undefined);
    }
    if (this.recordError) {
      throw this.recordError;
    }
    this.records.push(record);
    return record;
  }

  async confirmExecTransition(id: string): Promise<void> {
    if (this.confirmationGate) {
      this.markConfirmationStarted();
      await this.confirmationGate;
    }
    this.records = this.records.map((record) =>
      record.id === id && record.lifecycle.execTransition === "pending"
        ? {
            ...record,
            lifecycle: { ...record.lifecycle, execTransition: "confirmed" },
          }
        : record,
    );
  }

  async retain(record: ManagedProcessRecord): Promise<void> {
    this.records = [...this.records.filter((candidate) => candidate.id !== record.id), record];
  }

  waitForConfirmation(): Promise<void> {
    return this.confirmationStarted;
  }

  releaseConfirmation(): void {
    this.releaseConfirmationGate();
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

async function waitForClosedPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await canConnectToPort(port))) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`OpenCode helper server still accepts connections on port ${port}`);
}

function canConnectToPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const settle = (connected: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(connected);
    };

    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(500, () => settle(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
