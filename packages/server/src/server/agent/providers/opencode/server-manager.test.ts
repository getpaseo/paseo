import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { ManagedProcessGroupInspection } from "../../../managed-processes/managed-processes.js";
import type {
  ProcessTerminator,
  TerminateWithTreeKillResult,
} from "../../../../utils/tree-kill.js";
import {
  AgentRuntimeCapacityError,
  HostAgentRuntimeCapacityController,
} from "../../agent-runtime-capacity.js";
import { OpenCodeServerManager } from "./server-manager.js";
import { createWindowsJobObjectProcessSpawner } from "./windows-job-object.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 12345;
  child.kill = vi.fn(() => true);
  return child;
}

interface FakeWindowsJobLifecycle {
  completion: Promise<boolean>;
  leaderExit: Promise<number>;
  resolveCompletion: (proven: boolean) => void;
  resolveLeaderExit: (exitCode: number) => void;
}

function createWindowsJobLifecycle(): FakeWindowsJobLifecycle {
  let resolveCompletion: (proven: boolean) => void = () => undefined;
  let resolveLeaderExit: (exitCode: number) => void = () => undefined;
  return {
    completion: new Promise((resolve) => {
      resolveCompletion = resolve;
    }),
    leaderExit: new Promise((resolve) => {
      resolveLeaderExit = resolve;
    }),
    resolveCompletion: (proven) => resolveCompletion(proven),
    resolveLeaderExit: (exitCode) => resolveLeaderExit(exitCode),
  };
}

function createManager(options: {
  terminateResult?: TerminateWithTreeKillResult;
  terminateResults?: TerminateWithTreeKillResult[];
  terminateImplementation?: ProcessTerminator;
  processGroupInspection?: ManagedProcessGroupInspection;
  capacity?: number;
  platform?: NodeJS.Platform;
  spawnErrors?: Error[];
}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "paseo-opencode-capacity-"));
  tempDirs.push(directory);
  const children: ChildProcess[] = [];
  const windowsJobs = new Map<ChildProcess, FakeWindowsJobLifecycle>();
  const terminateProcess = vi.fn<ProcessTerminator>(
    options.terminateImplementation ??
      (async () => {
        const result = options.terminateResults?.shift() ?? options.terminateResult ?? "terminated";
        if (
          options.platform === "win32" &&
          result !== "kill-timeout" &&
          result !== "signal-skipped"
        ) {
          const child = children.find((candidate) => candidate.exitCode === null);
          if (child) {
            windowsJobs.get(child)?.resolveLeaderExit(1);
            windowsJobs.get(child)?.resolveCompletion(true);
            Object.defineProperty(child, "exitCode", { configurable: true, value: 1 });
            child.emit("exit", 1, null);
            child.emit("close", 1, null);
          }
        }
        return result;
      }),
  );
  let processGroupInspection: ManagedProcessGroupInspection = options.processGroupInspection ?? {
    status: "owned",
  };
  const manager = new OpenCodeServerManager({
    logger: createTestLogger(),
    portAllocator: async () => 4100 + children.length,
    resolveCommandPrefix: async () => ({ command: "opencode", args: [] }),
    resolveHomeDir: () => directory,
    spawnServerProcess: () => {
      const spawnError = options.spawnErrors?.shift();
      if (spawnError) {
        throw spawnError;
      }
      const child = createChild();
      children.push(child);
      if (options.platform === "win32") {
        windowsJobs.set(child, createWindowsJobLifecycle());
      }
      queueMicrotask(() => {
        (child.stdout as EventEmitter).emit("data", Buffer.from("listening on"));
      });
      return child;
    },
    terminateProcess,
    createManagedProcessIdentityToken: () => "capacity-test-token",
    verifyProcessGroupIdentity: async () => processGroupInspection,
    getWindowsJobCompletion: (child) => windowsJobs.get(child)?.completion,
    getWindowsJobLeaderExit: (child) => windowsJobs.get(child)?.leaderExit,
    platform: options.platform,
  });
  const runtimeCapacity = new HostAgentRuntimeCapacityController(options.capacity ?? 1);
  const releaseCapacity = vi.spyOn(runtimeCapacity, "release");
  manager.configureRuntimeCapacityController(runtimeCapacity);
  return {
    children,
    manager,
    releaseCapacity,
    runtimeCapacity,
    setProcessGroupInspection: (inspection: ManagedProcessGroupInspection) => {
      processGroupInspection = inspection;
    },
    terminateProcess,
    completeWindowsJob: (child: ChildProcess, proven: boolean, exitCode = 0) => {
      windowsJobs.get(child)?.resolveLeaderExit(exitCode);
      windowsJobs.get(child)?.resolveCompletion(proven);
      Object.defineProperty(child, "exitCode", { configurable: true, value: exitCode });
      child.emit("exit", exitCode, null);
      child.emit("close", exitCode, null);
    },
    exitWindowsLeader: (child: ChildProcess, exitCode = 1) => {
      windowsJobs.get(child)?.resolveLeaderExit(exitCode);
    },
  };
}

describe("OpenCodeServerManager runtime capacity", () => {
  test("charges one shared server generation once across existing acquisitions", async () => {
    const { children, manager } = createManager({});

    const first = await manager.acquireCurrent();
    const second = await manager.acquireCurrent();

    expect(children).toHaveLength(1);
    const existing = manager.acquireExisting(first.server.url);
    expect(existing).not.toBeNull();
    await second.release();
    await first.release();
    await existing?.release();
    await manager.shutdown();
  });

  test("atomically rejects a new generation while the full shared generation is held", async () => {
    const { children, manager } = createManager({});
    const current = await manager.acquireCurrent();

    await expect(manager.acquireNew()).rejects.toBeInstanceOf(AgentRuntimeCapacityError);
    expect(children).toHaveLength(1);

    await current.release();
    await manager.shutdown();
  });

  test("rolls back a reservation when the generation spawner throws", async () => {
    const { children, manager } = createManager({
      spawnErrors: [new Error("Windows supervisor failed to spawn")],
    });

    await expect(manager.acquireCurrent()).rejects.toThrow("Windows supervisor failed to spawn");
    const replacement = await manager.acquireCurrent();

    expect(children).toHaveLength(1);
    await replacement.release();
  });

  test("releases a Windows reservation once when Node reports an asynchronous spawn error", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "paseo-opencode-async-spawn-"));
    tempDirs.push(directory);
    const supervisor = createChild();
    Object.defineProperty(supervisor, "pid", { configurable: true, value: undefined });
    const spawnServerProcess = createWindowsJobObjectProcessSpawner(() => supervisor);
    const terminateProcess = vi.fn<ProcessTerminator>(async (target) => {
      target.kill("SIGTERM");
      return "terminated";
    });
    const manager = new OpenCodeServerManager({
      logger: createTestLogger(),
      portAllocator: async () => 4199,
      resolveCommandPrefix: async () => ({ command: "opencode.exe", args: [] }),
      resolveHomeDir: () => directory,
      spawnServerProcess,
      terminateProcess,
      platform: "win32",
    });
    const runtimeCapacity = new HostAgentRuntimeCapacityController(1);
    const releaseCapacity = vi.spyOn(runtimeCapacity, "release");
    manager.configureRuntimeCapacityController(runtimeCapacity);

    const acquisition = manager.acquireCurrent();
    await vi.waitFor(() => expect(supervisor.listenerCount("error")).toBeGreaterThan(1));
    supervisor.emit("error", new Error("spawn powershell.exe ENOENT"));

    await expect(acquisition).rejects.toThrow("spawn powershell.exe ENOENT");
    await vi.waitFor(() => expect(releaseCapacity).toHaveBeenCalledTimes(1));
    supervisor.emit("close", -1, null);
    await Promise.resolve();
    expect(releaseCapacity).toHaveBeenCalledTimes(1);
    const replacement = runtimeCapacity.reserve();
    replacement.release();
  });

  test("retains the Windows charge until the Job Object supervisor reports empty", async () => {
    const { children, manager, releaseCapacity, completeWindowsJob } = createManager({
      platform: "win32",
    });
    const current = await manager.acquireCurrent();

    await expect(manager.acquireDedicated({ TEST: "descendant-survives" })).rejects.toBeInstanceOf(
      AgentRuntimeCapacityError,
    );
    expect(releaseCapacity).not.toHaveBeenCalled();

    const supervisor = children[0]!;
    completeWindowsJob(supervisor, true);
    await vi.waitFor(() => expect(releaseCapacity).toHaveBeenCalledTimes(1));

    const replacement = await manager.acquireDedicated({ TEST: "job-empty" });
    await current.release();
    await replacement.release();
  });

  test("invalidates a Windows server at target-leader exit while retaining capacity for descendants", async () => {
    const {
      children,
      manager,
      releaseCapacity,
      terminateProcess,
      completeWindowsJob,
      exitWindowsLeader,
    } = createManager({ platform: "win32", capacity: 2, terminateResult: "kill-timeout" });
    const dead = await manager.acquireCurrent();

    exitWindowsLeader(children[0]!, 23);
    await expect(dead.server.leaderExit).resolves.toBe(23);
    await vi.waitFor(() => expect(terminateProcess).toHaveBeenCalledTimes(1));

    expect(manager.acquireExisting(dead.server.url)).toBeNull();
    expect(releaseCapacity).not.toHaveBeenCalled();

    const replacement = await manager.acquireCurrent();
    expect(replacement.server.url).not.toBe(dead.server.url);
    expect(children).toHaveLength(2);
    expect(releaseCapacity).not.toHaveBeenCalled();

    completeWindowsJob(children[0]!, true, 23);
    await vi.waitFor(() => expect(releaseCapacity).toHaveBeenCalledTimes(1));
    await dead.release();
    await replacement.release();
    completeWindowsJob(children[1]!, true);
    await vi.waitFor(() => expect(releaseCapacity).toHaveBeenCalledTimes(2));
  });

  test("retains the Windows charge when the supervisor exits without empty proof", async () => {
    vi.useFakeTimers();
    const { children, manager, releaseCapacity, completeWindowsJob } = createManager({
      platform: "win32",
    });
    await manager.acquireCurrent();

    completeWindowsJob(children[0]!, false, 1);
    await vi.advanceTimersByTimeAsync(0);

    expect(releaseCapacity).not.toHaveBeenCalled();
    await expect(manager.acquireDedicated({ TEST: "blocked" })).rejects.toBeInstanceOf(
      AgentRuntimeCapacityError,
    );
  });

  test.runIf(process.platform !== "win32")(
    "retains the charge when the process-group leader exits before its descendants",
    async () => {
      vi.useFakeTimers();
      const { children, manager, releaseCapacity, terminateProcess } = createManager({
        terminateResults: ["kill-timeout", "terminated", "terminated"],
      });
      await manager.acquireCurrent();

      Object.defineProperty(children[0], "exitCode", { configurable: true, value: 0 });
      children[0]?.emit("exit", 0, null);
      await vi.waitFor(() => expect(terminateProcess).toHaveBeenCalledTimes(1));

      expect(releaseCapacity).not.toHaveBeenCalled();
      await expect(manager.acquireDedicated({ TEST: "blocked" })).rejects.toBeInstanceOf(
        AgentRuntimeCapacityError,
      );

      await vi.advanceTimersByTimeAsync(1_000);
      expect(releaseCapacity).toHaveBeenCalledTimes(1);
      const replacement = await manager.acquireDedicated({ TEST: "replacement" });
      await replacement.release();
    },
  );

  test("retains a timed-out cleanup charge until one late retry succeeds", async () => {
    vi.useFakeTimers();
    const { children, manager, releaseCapacity, terminateProcess } = createManager({
      terminateResults: ["kill-timeout", "terminated", "terminated"],
    });
    const first = await manager.acquireDedicated({ TEST: "one" });

    await first.release();
    expect(releaseCapacity).not.toHaveBeenCalled();
    await expect(manager.acquireDedicated({ TEST: "blocked" })).rejects.toBeInstanceOf(
      AgentRuntimeCapacityError,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(terminateProcess).toHaveBeenCalledTimes(2);
    expect(releaseCapacity).toHaveBeenCalledTimes(1);

    children[0]?.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(releaseCapacity).toHaveBeenCalledTimes(1);

    const replacement = await manager.acquireDedicated({ TEST: "replacement" });
    await replacement.release();
  });

  test.runIf(process.platform !== "win32")(
    "retains the charge while process-group identity is unverifiable",
    async () => {
      vi.useFakeTimers();
      const terminateAfterIdentityCheck: ProcessTerminator = async (_target, terminateOptions) =>
        (await terminateOptions.beforeSignal?.("SIGTERM")) === false
          ? "signal-skipped"
          : "terminated";
      const { manager, releaseCapacity, setProcessGroupInspection } = createManager({
        terminateImplementation: terminateAfterIdentityCheck,
        processGroupInspection: { status: "unverifiable", message: "token mismatch" },
      });
      const first = await manager.acquireDedicated({ TEST: "one" });

      await first.release();
      expect(releaseCapacity).not.toHaveBeenCalled();
      await expect(manager.acquireDedicated({ TEST: "blocked" })).rejects.toBeInstanceOf(
        AgentRuntimeCapacityError,
      );

      setProcessGroupInspection({ status: "owned" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(releaseCapacity).toHaveBeenCalledTimes(1);

      const replacement = await manager.acquireDedicated({ TEST: "replacement" });
      await replacement.release();
    },
  );

  test.runIf(process.platform !== "win32")(
    "releases the charge when process-group inspection proves not-found",
    async () => {
      const terminateAfterIdentityCheck: ProcessTerminator = async (_target, terminateOptions) =>
        (await terminateOptions.beforeSignal?.("SIGTERM")) === false
          ? "signal-skipped"
          : "terminated";
      const { manager, releaseCapacity } = createManager({
        terminateImplementation: terminateAfterIdentityCheck,
        processGroupInspection: { status: "not-found" },
      });
      const first = await manager.acquireDedicated({ TEST: "one" });

      await first.release();
      expect(releaseCapacity).toHaveBeenCalledTimes(1);

      const replacement = await manager.acquireDedicated({ TEST: "replacement" });
      await replacement.release();
    },
  );

  test("retains the charge through shutdown until a later shutdown proves cleanup", async () => {
    const { manager, releaseCapacity } = createManager({
      terminateResults: ["kill-timeout", "kill-timeout", "terminated", "terminated"],
    });
    const first = await manager.acquireDedicated({ TEST: "one" });

    await first.release();
    await manager.shutdown();
    expect(releaseCapacity).not.toHaveBeenCalled();
    await expect(manager.acquireDedicated({ TEST: "blocked" })).rejects.toBeInstanceOf(
      AgentRuntimeCapacityError,
    );

    await manager.shutdown();
    expect(releaseCapacity).toHaveBeenCalledTimes(1);

    const replacement = await manager.acquireDedicated({ TEST: "replacement" });
    await replacement.release();
  });

  test("releases the charge after proven dedicated server termination", async () => {
    const { manager } = createManager({ terminateResult: "terminated" });
    const first = await manager.acquireDedicated({ TEST: "one" });
    await first.release();

    const second = await manager.acquireDedicated({ TEST: "two" });
    await second.release();
  });

  test("allows a fresh host controller after every server has shut down", async () => {
    const { manager } = createManager({});
    const current = await manager.acquireCurrent();

    expect(() =>
      manager.configureRuntimeCapacityController(new HostAgentRuntimeCapacityController(1)),
    ).toThrow("OpenCode server manager already has a different runtime capacity controller");

    await current.release();
    expect(() =>
      manager.configureRuntimeCapacityController(new HostAgentRuntimeCapacityController(1)),
    ).not.toThrow();
  });

  test("rejects a fresh controller while retired cleanup still owns capacity", async () => {
    vi.useFakeTimers();
    const { manager } = createManager({
      terminateResults: ["kill-timeout", "terminated"],
    });
    const first = await manager.acquireDedicated({ TEST: "one" });
    await first.release();

    expect(() =>
      manager.configureRuntimeCapacityController(new HostAgentRuntimeCapacityController(1)),
    ).toThrow("OpenCode server manager already has a different runtime capacity controller");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(() =>
      manager.configureRuntimeCapacityController(new HostAgentRuntimeCapacityController(1)),
    ).not.toThrow();
  });
});
