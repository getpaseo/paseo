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
            Object.defineProperty(child, "exitCode", { configurable: true, value: 1 });
            (child.stdout as EventEmitter).emit("data", Buffer.from("test-windows-job-empty\n"));
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
      queueMicrotask(() => {
        (child.stdout as EventEmitter).emit("data", Buffer.from("listening on"));
      });
      return child;
    },
    terminateProcess,
    createManagedProcessIdentityToken: () => "capacity-test-token",
    verifyProcessGroupIdentity: async () => processGroupInspection,
    getWindowsJobProofMarker: () => "test-windows-job-empty",
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

  test("retains the Windows charge until the Job Object supervisor reports empty", async () => {
    const { children, manager, releaseCapacity } = createManager({ platform: "win32" });
    const current = await manager.acquireCurrent();

    await expect(manager.acquireDedicated({ TEST: "descendant-survives" })).rejects.toBeInstanceOf(
      AgentRuntimeCapacityError,
    );
    expect(releaseCapacity).not.toHaveBeenCalled();

    const supervisor = children[0]!;
    Object.defineProperty(supervisor, "exitCode", { configurable: true, value: 0 });
    (supervisor.stdout as EventEmitter).emit("data", Buffer.from("test-windows-job-empty\n"));
    supervisor.emit("exit", 0, null);
    supervisor.emit("close", 0, null);
    await vi.waitFor(() => expect(releaseCapacity).toHaveBeenCalledTimes(1));

    const replacement = await manager.acquireDedicated({ TEST: "job-empty" });
    await current.release();
    await replacement.release();
  });

  test("retains the Windows charge when the supervisor exits without empty proof", async () => {
    vi.useFakeTimers();
    const { children, manager, releaseCapacity } = createManager({ platform: "win32" });
    await manager.acquireCurrent();

    Object.defineProperty(children[0], "exitCode", { configurable: true, value: 1 });
    children[0]?.emit("exit", 1, null);
    children[0]?.emit("close", 1, null);
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
