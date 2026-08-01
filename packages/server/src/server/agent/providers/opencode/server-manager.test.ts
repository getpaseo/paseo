import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import {
  AgentRuntimeCapacityError,
  HostAgentRuntimeCapacityController,
} from "../../agent-runtime-capacity.js";
import { OpenCodeServerManager } from "./server-manager.js";

const tempDirs: string[] = [];

afterEach(() => {
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
  terminateResult?: "terminated" | "kill-timeout";
  terminateResults?: Array<"terminated" | "kill-timeout">;
  terminateImplementation?: () => Promise<"terminated" | "kill-timeout">;
  capacity?: number;
}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "paseo-opencode-capacity-"));
  tempDirs.push(directory);
  const children: ChildProcess[] = [];
  const terminateProcess = vi.fn(
    options.terminateImplementation ??
      (async () => options.terminateResults?.shift() ?? options.terminateResult ?? "terminated"),
  );
  const manager = new OpenCodeServerManager({
    logger: createTestLogger(),
    portAllocator: async () => 4100 + children.length,
    resolveCommandPrefix: async () => ({ command: "opencode", args: [] }),
    resolveHomeDir: () => directory,
    spawnServerProcess: () => {
      const child = createChild();
      children.push(child);
      queueMicrotask(() => {
        (child.stdout as EventEmitter).emit("data", Buffer.from("listening on"));
      });
      return child;
    },
    terminateProcess,
  });
  manager.configureRuntimeCapacityController(
    new HostAgentRuntimeCapacityController(options.capacity ?? 1),
  );
  return { children, manager, terminateProcess };
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

  test("retains the charge while dedicated server termination remains unproven", async () => {
    const { manager, terminateProcess } = createManager({ terminateResult: "kill-timeout" });
    const first = await manager.acquireDedicated({ TEST: "one" });

    await expect(first.release()).rejects.toThrow(
      "OpenCode server termination did not report process exit",
    );
    await expect(manager.acquireDedicated({ TEST: "two" })).rejects.toBeInstanceOf(
      AgentRuntimeCapacityError,
    );
    expect(terminateProcess).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["dedicated", (manager: OpenCodeServerManager) => manager.acquireDedicated({ TEST: "two" })],
    ["current", (manager: OpenCodeServerManager) => manager.acquireCurrent()],
    ["new", (manager: OpenCodeServerManager) => manager.acquireNew()],
  ])("retries retained cleanup before %s admission", async (_kind, acquireReplacement) => {
    const { children, manager, terminateProcess } = createManager({
      terminateResults: ["kill-timeout", "terminated", "terminated"],
    });
    const first = await manager.acquireDedicated({ TEST: "one" });
    await expect(first.release()).rejects.toThrow(
      "OpenCode server termination did not report process exit",
    );

    const replacement = await acquireReplacement(manager);
    expect(children).toHaveLength(2);
    expect(terminateProcess).toHaveBeenCalledTimes(2);
    await replacement.release();
  });

  test("coalesces concurrent pre-admission cleanup retries", async () => {
    let terminationAttempt = 0;
    let allowCleanup!: () => void;
    const cleanupAllowed = new Promise<void>((resolve) => {
      allowCleanup = resolve;
    });
    const { children, manager, terminateProcess } = createManager({
      terminateImplementation: async () => {
        terminationAttempt += 1;
        if (terminationAttempt === 1) {
          return "kill-timeout";
        }
        if (terminationAttempt === 2) {
          await cleanupAllowed;
        }
        return "terminated";
      },
    });
    const first = await manager.acquireDedicated({ TEST: "one" });
    await expect(first.release()).rejects.toThrow(
      "OpenCode server termination did not report process exit",
    );

    const replacements = [
      manager.acquireDedicated({ TEST: "two" }),
      manager.acquireDedicated({ TEST: "three" }),
    ];
    await vi.waitFor(() => expect(terminateProcess).toHaveBeenCalledTimes(2));
    expect(children).toHaveLength(1);
    allowCleanup();

    const results = await Promise.allSettled(replacements);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.status === "rejected" && result.reason instanceof AgentRuntimeCapacityError,
      ),
    ).toHaveLength(1);
    expect(children).toHaveLength(2);
    expect(terminateProcess).toHaveBeenCalledTimes(2);
    const acquired = results.find((result) => result.status === "fulfilled");
    if (acquired?.status === "fulfilled") {
      await acquired.value.release();
    }
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
});
