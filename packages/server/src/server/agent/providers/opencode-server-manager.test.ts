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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

describe("OpenCodeServerManager generations", () => {
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

  test("aborting the only readiness waiter kills the unready server before rejecting", async () => {
    const { manager, runtime } = createTestManager([4470], { autoAnnounce: false });
    const controller = new AbortController();
    const abortReason = new Error("catalog superseded");
    const acquisition = manager.acquireCurrent({ signal: controller.signal });

    await new Promise<void>((resolve) => setImmediate(resolve));
    const observed = manager.acquireExisting("http://127.0.0.1:4470");
    expect(observed).not.toBeNull();
    await observed?.release();
    controller.abort(abortReason);
    const result = await Promise.race([
      acquisition.then(
        () => "resolved" as const,
        (error: unknown) => error,
      ),
      new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
    ]);

    try {
      expect(result).toBe(abortReason);
      expect(runtime.terminatedPorts).toEqual([4470]);
      expect(await runtime.managedProcesses.list()).toEqual([]);
    } finally {
      await manager.shutdown();
    }
  });

  test("aborting the only startup waiter prevents a spawn after command resolution", async () => {
    const resolutionStarted = deferred<void>();
    const resolutionAllowed = deferred<void>();
    const { manager, runtime } = createTestManager([4468], {
      resolveCommandPrefix: async () => {
        resolutionStarted.resolve();
        await resolutionAllowed.promise;
        return { command: "opencode", args: [] };
      },
    });
    const controller = new AbortController();
    const abortReason = new Error("catalog superseded");
    const acquisition = manager.acquireCurrent({ signal: controller.signal });

    await resolutionStarted.promise;
    controller.abort(abortReason);
    await expect(acquisition).rejects.toBe(abortReason);
    resolutionAllowed.resolve();
    await runtime.settle();

    expect(runtime.spawnCalls).toEqual([]);
    await manager.shutdown();
  });

  test("a caller after startup cancellation creates a replacement generation", async () => {
    const firstResolutionStarted = deferred<void>();
    const firstResolutionAllowed = deferred<void>();
    let resolutionCalls = 0;
    const { manager, runtime } = createTestManager([4465, 4466], {
      resolveCommandPrefix: async () => {
        resolutionCalls += 1;
        if (resolutionCalls === 1) {
          firstResolutionStarted.resolve();
          await firstResolutionAllowed.promise;
        }
        return { command: "opencode", args: [] };
      },
    });
    const controller = new AbortController();
    const abortReason = new Error("catalog superseded");
    const canceledAcquisition = manager.acquireCurrent({ signal: controller.signal });

    await firstResolutionStarted.promise;
    controller.abort(abortReason);
    await expect(canceledAcquisition).rejects.toBe(abortReason);
    const replacementAcquisition = manager.acquireCurrent();
    const replacement = await replacementAcquisition;
    firstResolutionAllowed.resolve();
    await runtime.settle();

    expect(runtime.launchedPorts).toEqual([4466]);
    await replacement.release();
  });

  test("a canceled rotation cannot retire the startup it was waiting for", async () => {
    const resolutionStarted = deferred<void>();
    const resolutionAllowed = deferred<void>();
    const { manager, runtime } = createTestManager([4460], {
      autoAnnounce: false,
      resolveCommandPrefix: async () => {
        resolutionStarted.resolve();
        await resolutionAllowed.promise;
        return { command: "opencode", args: [] };
      },
    });
    const initialStart = manager.acquireCurrent();
    const controller = new AbortController();
    const abortReason = new Error("catalog superseded");
    const canceledRotation = manager.acquireNew({ signal: controller.signal });
    await resolutionStarted.promise;
    controller.abort(abortReason);
    await expect(canceledRotation).rejects.toBe(abortReason);

    resolutionAllowed.resolve();
    await runtime.settle();
    runtime.processForPort(4460).announceListening();
    const initial = await initialStart;
    const next = await manager.acquireCurrent();

    expect(initial.server.url).toBe("http://127.0.0.1:4460");
    expect(next.server.url).toBe("http://127.0.0.1:4460");
    expect(runtime.terminatedPorts).toEqual([]);

    await next.release();
    await initial.release();
  });

  test("a canceled rotation cannot retire a fresh acquireCurrent startup after cleanup", async () => {
    const cleanupStarted = deferred<void>();
    const cleanupAllowed = deferred<void>();
    const freshResolutionStarted = deferred<void>();
    const freshResolutionAllowed = deferred<void>();
    let cleanupAttempts = 0;
    let resolutionCalls = 0;
    const { manager, runtime } = createTestManager([4457, 4458, 4459, 4464], {
      beforeTerminate: async (port) => {
        if (port !== 4457) {
          return;
        }
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) {
          throw new Error("termination failed");
        }
        cleanupStarted.resolve();
        await cleanupAllowed.promise;
      },
      resolveCommandPrefix: async () => {
        resolutionCalls += 1;
        if (resolutionCalls === 3) {
          freshResolutionStarted.resolve();
          await freshResolutionAllowed.promise;
        }
        return { command: "opencode", args: [] };
      },
    });
    const orphan = await manager.acquireDedicated({ TEST_ENV: "orphan" });
    await expect(orphan.release()).rejects.toThrow("termination failed");
    const oldCurrent = await manager.acquireCurrent();
    const controller = new AbortController();
    const abortReason = new Error("catalog superseded");
    const canceledRotation = manager.acquireNew({ signal: controller.signal });

    await cleanupStarted.promise;
    controller.abort(abortReason);
    await expect(canceledRotation).rejects.toBe(abortReason);
    const freshStart = manager.acquireCurrent();
    await freshResolutionStarted.promise;

    cleanupAllowed.resolve();
    await runtime.settle();
    freshResolutionAllowed.resolve();
    const fresh = await freshStart;
    const next = await manager.acquireCurrent();

    expect(fresh.server.url).toBe("http://127.0.0.1:4459");
    expect(next.server.url).toBe("http://127.0.0.1:4459");
    expect(runtime.launchedPorts).toEqual([4457, 4458, 4459]);
    expect(runtime.terminatedPorts).toEqual([4457]);

    await next.release();
    await fresh.release();
    await oldCurrent.release();
  });

  test("shutdown rejects acquisitions started after shutdown begins", async () => {
    const resolutionStarted = deferred<void>();
    const resolutionAllowed = deferred<void>();
    const { manager } = createTestManager([4462], {
      resolveCommandPrefix: async () => {
        resolutionStarted.resolve();
        await resolutionAllowed.promise;
        return { command: "opencode", args: [] };
      },
    });
    const pendingAcquisition = manager.acquireCurrent();

    await resolutionStarted.promise;
    const shutdown = manager.shutdown();

    await expect(manager.acquireCurrent()).rejects.toThrow("OpenCode server manager shutting down");
    await expect(manager.acquireNew()).rejects.toThrow("OpenCode server manager shutting down");
    await expect(manager.acquireDedicated({ TEST_ENV: "custom" })).rejects.toThrow(
      "OpenCode server manager shutting down",
    );
    expect(manager.acquireExisting("http://127.0.0.1:4462")).toBeNull();
    await expect(pendingAcquisition).rejects.toThrow("OpenCode server manager shutting down");
    await shutdown;
    resolutionAllowed.resolve();
  });

  test("shutdown aborts and drains an in-flight dedicated startup", async () => {
    const resolutionStarted = deferred<void>();
    const resolutionAllowed = deferred<void>();
    const { manager, runtime } = createTestManager([4465], {
      resolveCommandPrefix: async () => {
        resolutionStarted.resolve();
        await resolutionAllowed.promise;
        return { command: "opencode", args: [] };
      },
    });
    const pendingAcquisition = manager.acquireDedicated({ TEST_ENV: "custom" });

    await resolutionStarted.promise;
    const shutdown = manager.shutdown();

    await expect(pendingAcquisition).rejects.toThrow("OpenCode server manager shutting down");
    await shutdown;
    resolutionAllowed.resolve();
    await runtime.settle();

    expect(runtime.spawnCalls).toEqual([]);
  });

  test("shutdown retries termination that fails after signaling the process", async () => {
    let terminationAttempts = 0;
    const { manager, runtime } = createTestManager([4463], {
      terminateProcess: async (target) => {
        terminationAttempts += 1;
        const process = target as unknown as FakeOpenCodeProcess;
        if (terminationAttempts === 1) {
          process.markKillSignalSent();
          throw new Error("termination failed");
        }
        process.exitBySignal("SIGTERM");
        return "terminated";
      },
    });
    const acquisition = await manager.acquireCurrent();

    await expect(acquisition.release()).rejects.toThrow("termination failed");
    expect(runtime.processForPort(4463).killed).toBe(true);

    await manager.shutdown();

    expect(terminationAttempts).toBe(2);
    expect(runtime.processForPort(4463).signalCode).toBe("SIGTERM");
  });

  test("shutdown retries an unconfirmed kill timeout", async () => {
    let terminationAttempts = 0;
    const { manager } = createTestManager([4464], {
      terminateProcess: async (target) => {
        terminationAttempts += 1;
        if (terminationAttempts === 1) {
          return "kill-timeout";
        }
        const process = target as unknown as FakeOpenCodeProcess;
        process.exitBySignal("SIGKILL");
        return "terminated";
      },
    });
    const acquisition = await manager.acquireCurrent();

    await expect(acquisition.release()).rejects.toThrow(
      "OpenCode server did not exit after SIGKILL",
    );

    await manager.shutdown();

    expect(terminationAttempts).toBe(2);
  });

  test("one canceled command-resolution waiter does not cancel a shared startup", async () => {
    const resolutionStarted = deferred<void>();
    const resolutionAllowed = deferred<void>();
    const { manager, runtime } = createTestManager([4469], {
      resolveCommandPrefix: async () => {
        resolutionStarted.resolve();
        await resolutionAllowed.promise;
        return { command: "opencode", args: [] };
      },
    });
    const controller = new AbortController();
    const abortReason = new Error("catalog superseded");
    const canceledAcquisition = manager.acquireCurrent({ signal: controller.signal });
    const retainedAcquisition = manager.acquireCurrent();

    await resolutionStarted.promise;
    controller.abort(abortReason);
    await expect(canceledAcquisition).rejects.toBe(abortReason);
    resolutionAllowed.resolve();
    const retained = await retainedAcquisition;

    expect(runtime.launchedPorts).toEqual([4469]);
    await retained.release();
  });

  test("shutdown prevents a spawn after command resolution", async () => {
    const resolutionStarted = deferred<void>();
    const resolutionAllowed = deferred<void>();
    const { manager, runtime } = createTestManager([4467], {
      resolveCommandPrefix: async () => {
        resolutionStarted.resolve();
        await resolutionAllowed.promise;
        return { command: "opencode", args: [] };
      },
    });
    const acquisition = manager.acquireCurrent();

    await resolutionStarted.promise;
    const shutdown = manager.shutdown();
    await expect(acquisition).rejects.toThrow("OpenCode server manager shutting down");
    await shutdown;
    resolutionAllowed.resolve();
    await runtime.settle();

    expect(runtime.spawnCalls).toEqual([]);
  });

  test("aborting one startup waiter does not wait for or kill another waiter's server", async () => {
    const { manager, runtime } = createTestManager([4471], { autoAnnounce: false });
    const controller = new AbortController();
    const abortReason = new Error("catalog superseded");
    const canceledAcquisition = manager.acquireCurrent({ signal: controller.signal });
    const retainedAcquisition = manager.acquireCurrent();

    await runtime.settle();
    controller.abort(abortReason);
    const canceledResult = await Promise.race([
      canceledAcquisition.then(
        () => "resolved" as const,
        (error: unknown) => error,
      ),
      new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
    ]);

    runtime.processForPort(4471).announceListening();
    const retained = await retainedAcquisition;
    try {
      expect(canceledResult).toBe(abortReason);
      expect(runtime.terminatedPorts).toEqual([]);
    } finally {
      await retained.release();
    }
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
    beforeTerminate?: (port: number) => Promise<void>;
    opencodeHomeDir?: string;
    resolveCommandPrefix?: OpenCodeCommandPrefixResolver;
    terminateProcess?: ProcessTerminator;
  } = {},
): {
  manager: OpenCodeServerManager;
  runtime: FakeOpenCodeServerRuntime;
} {
  const { opencodeHomeDir } = options;
  const runtime = new FakeOpenCodeServerRuntime(ports, {
    autoAnnounce: options.autoAnnounce ?? true,
    beforeTerminate: options.beforeTerminate,
  });
  return {
    manager: new OpenCodeServerManager({
      logger: createTestLogger(),
      managedProcesses: runtime.managedProcesses,
      portAllocator: runtime.allocatePort,
      resolveCommandPrefix: options.resolveCommandPrefix ?? runtime.resolveCommandPrefix,
      ...(opencodeHomeDir ? { resolveHomeDir: () => opencodeHomeDir } : {}),
      spawnServerProcess: runtime.spawnServerProcess,
      terminateProcess: options.terminateProcess ?? runtime.terminateProcess,
    }),
    runtime,
  };
}

class FakeOpenCodeServerRuntime {
  readonly managedProcesses = new FakeManagedProcesses();
  readonly terminatedPorts: number[] = [];
  readonly spawnCalls: Array<{
    command: string;
    args: string[];
    options: Parameters<OpenCodeServerProcessSpawner>[2];
  }> = [];
  private readonly ports: number[];
  private readonly autoAnnounce: boolean;
  private readonly beforeTerminate?: (port: number) => Promise<void>;
  private readonly processesByChild = new Map<ChildProcess, FakeOpenCodeProcess>();
  private readonly processesByPort = new Map<number, FakeOpenCodeProcess>();

  constructor(
    ports: number[],
    options: {
      autoAnnounce: boolean;
      beforeTerminate?: (port: number) => Promise<void>;
    },
  ) {
    this.ports = [...ports];
    this.autoAnnounce = options.autoAnnounce;
    this.beforeTerminate = options.beforeTerminate;
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

  readonly terminateProcess: ProcessTerminator = async (target: TreeKillTarget) => {
    const process = this.processForChild(target as ChildProcess);
    await this.beforeTerminate?.(process.port);
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
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
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
