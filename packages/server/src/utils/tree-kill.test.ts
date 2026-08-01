import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { terminateWithTreeKill } from "./tree-kill.js";

const pollIntervalMs = 50;

let tempDir: string | null = null;
let ownerProcess: ChildProcess | null = null;
let descendantPid: number | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  async function poll(): Promise<void> {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(pollIntervalMs);
    return poll();
  }
  return poll();
}

async function readPidFileNumber(filePath: string): Promise<number | null> {
  try {
    const raw = (await readFile(filePath, "utf-8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function killIfRunning(pid: number | null | undefined): void {
  if (!pid || !isProcessRunning(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Ignore cleanup races.
  }
}

function spawnOwnerWithDescendant(options: {
  childPidPath: string;
  detachedDescendant: boolean;
}): ChildProcess {
  const descendantOptions = options.detachedDescendant
    ? '{ detached: true, stdio: "ignore" }'
    : '{ stdio: "ignore" }';
  const childUnref = options.detachedDescendant ? "child.unref();" : "";

  return spawn(
    process.execPath,
    [
      "-e",
      `
        const { spawn } = require("node:child_process");
        process.on("SIGTERM", () => {});
        const child = spawn(process.execPath, [
          "-e",
          ${JSON.stringify(`
            const fs = require("node:fs");
            process.on("SIGTERM", () => {});
            fs.writeFileSync(${JSON.stringify(options.childPidPath)}, String(process.pid));
            setInterval(() => {}, 1000);
          `)}
        ], ${descendantOptions});
        ${childUnref}
        setInterval(() => {}, 1000);
      `,
    ],
    { stdio: "ignore" },
  );
}

async function waitForFixtureReady(childPidPath: string): Promise<void> {
  await waitFor(
    async () => {
      descendantPid = await readPidFileNumber(childPidPath);
      return (
        isProcessRunning(ownerProcess?.pid ?? -1) &&
        descendantPid !== null &&
        isProcessRunning(descendantPid)
      );
    },
    5000,
    "owner descendant did not become running in time",
  );
}

async function expectOwnerAndDescendantStopped(message: string): Promise<void> {
  await waitFor(
    () => !isProcessRunning(ownerProcess?.pid ?? -1) && !isProcessRunning(descendantPid ?? -1),
    5000,
    message,
  );
}

afterEach(async () => {
  killIfRunning(ownerProcess?.pid);
  killIfRunning(descendantPid);
  ownerProcess = null;
  descendantPid = null;

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("terminateWithTreeKill", () => {
  test("skips a signal when its target can no longer be verified", async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const target = {
      pid: -4101,
      exitCode: null,
      signalCode: null,
      kill(signal?: NodeJS.Signals | number) {
        signals.push(signal);
        return true;
      },
      once() {},
    };

    const result = await terminateWithTreeKill(target, {
      gracefulTimeoutMs: 1,
      forceTimeoutMs: 1,
      beforeSignal: async () => false,
    });

    expect(result).toBe("signal-skipped");
    expect(signals).toEqual([]);
  });

  test("cancels exit observation when signaling is skipped", async () => {
    let observationCancelled = false;
    const target = {
      pid: -4103,
      exitCode: null,
      signalCode: null,
      kill() {
        return true;
      },
      observeExit() {
        return () => {
          observationCancelled = true;
        };
      },
    };

    const result = await terminateWithTreeKill(target, {
      gracefulTimeoutMs: 1,
      forceTimeoutMs: 1,
      beforeSignal: async () => false,
    });

    expect(result).toBe("signal-skipped");
    expect(observationCancelled).toBe(true);
  });

  test("cancels exit observation after force cleanup times out", async () => {
    let observationCancelled = false;
    const target = {
      pid: -4104,
      exitCode: null,
      signalCode: null,
      kill() {
        return true;
      },
      observeExit() {
        return () => {
          observationCancelled = true;
        };
      },
    };

    const result = await terminateWithTreeKill(target, {
      gracefulTimeoutMs: 1,
      forceTimeoutMs: 1,
    });

    expect(result).toBe("kill-timeout");
    expect(observationCancelled).toBe(true);
  });

  test("preserves the root and reports incomplete cleanup when tree signaling fails", async () => {
    const directSignals: Array<NodeJS.Signals | number | undefined> = [];
    let observationCancelled = false;
    const target = {
      pid: 4105,
      exitCode: null,
      signalCode: null,
      kill(signal?: NodeJS.Signals | number) {
        directSignals.push(signal);
        return true;
      },
      observeExit() {
        return () => {
          observationCancelled = true;
        };
      },
    };

    const result = await terminateWithTreeKill(target, {
      gracefulTimeoutMs: 1,
      forceTimeoutMs: 1,
      preserveRootOnTreeFailure: true,
      treeKiller: (_pid, _signal, callback) => callback(new Error("taskkill failed")),
    });

    expect(result).toBe("kill-timeout");
    expect(directSignals).toEqual([]);
    expect(observationCancelled).toBe(true);
  });

  test("falls back to the direct child when a non-retrying caller cannot signal the tree", async () => {
    const directSignals: Array<NodeJS.Signals | number | undefined> = [];
    let exitListener: () => void = () => undefined;
    const target = {
      pid: 4106,
      exitCode: null,
      signalCode: null,
      kill(signal?: NodeJS.Signals | number) {
        directSignals.push(signal);
        exitListener();
        return true;
      },
      once(_event: "exit", listener: () => void) {
        exitListener = listener;
      },
      off() {},
    };

    const result = await terminateWithTreeKill(target, {
      gracefulTimeoutMs: 1,
      forceTimeoutMs: 1,
      treeKiller: (_pid, _signal, callback) => callback(new Error("tree lookup failed")),
    });

    expect(result).toBe("terminated");
    expect(directSignals).toEqual(["SIGTERM"]);
  });

  test("waits for an uncancellable tree-kill callback after termination is aborted", async () => {
    const abortController = new AbortController();
    const removeListener = vi.spyOn(abortController.signal, "removeEventListener");
    let treeKillCallback: ((error?: Error) => void) | null = null;
    let outcome: "pending" | "resolved" | "rejected" = "pending";
    const target = {
      pid: 4107,
      exitCode: null,
      signalCode: null,
      kill() {
        return true;
      },
      once() {},
    };

    const termination = terminateWithTreeKill(target, {
      gracefulTimeoutMs: 1,
      forceTimeoutMs: 1,
      signal: abortController.signal,
      treeKiller: (_pid, _signal, callback) => {
        treeKillCallback = callback;
      },
    });
    void termination.then(
      () => {
        outcome = "resolved";
        return undefined;
      },
      () => {
        outcome = "rejected";
        return undefined;
      },
    );
    await Promise.resolve();

    abortController.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(outcome).toBe("pending");
    expect(treeKillCallback).not.toBe(null);
    expect(removeListener).not.toHaveBeenCalled();

    treeKillCallback?.();
    await expect(termination).rejects.toMatchObject({ name: "AbortError" });
    expect(outcome).toBe("rejected");
    expect(removeListener).toHaveBeenCalledOnce();
  });

  test.each([
    ["success", undefined],
    ["failure", new Error("tree-kill callback failed")],
  ])("removes its abort listener after asynchronous tree-kill %s", async (_label, error) => {
    const abortController = new AbortController();
    const addListener = vi.spyOn(abortController.signal, "addEventListener");
    const removeListener = vi.spyOn(abortController.signal, "removeEventListener");
    let exitListener: () => void = () => undefined;
    const target = {
      pid: 4108,
      exitCode: null,
      signalCode: null,
      kill() {
        exitListener();
        return true;
      },
      once(_event: "exit", listener: () => void) {
        exitListener = listener;
      },
      off() {},
    };

    const result = await terminateWithTreeKill(target, {
      gracefulTimeoutMs: 1,
      forceTimeoutMs: 1,
      signal: abortController.signal,
      treeKiller: (_pid, _signal, callback) => {
        setImmediate(() => {
          if (!error) {
            exitListener();
          }
          callback(error);
        });
      },
    });

    expect(result).toBe("terminated");
    for (const call of addListener.mock.calls) {
      expect(removeListener).toHaveBeenCalledWith("abort", call[1]);
    }
  });

  test("removes its abort listener when tree-kill throws synchronously", async () => {
    const abortController = new AbortController();
    const addListener = vi.spyOn(abortController.signal, "addEventListener");
    const removeListener = vi.spyOn(abortController.signal, "removeEventListener");
    const failure = new Error("tree-kill failed synchronously");
    const target = {
      pid: 4108,
      exitCode: null,
      signalCode: null,
      kill() {
        return true;
      },
      once() {},
    };

    await expect(
      terminateWithTreeKill(target, {
        gracefulTimeoutMs: 1,
        forceTimeoutMs: 1,
        signal: abortController.signal,
        treeKiller: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(addListener).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith("abort", addListener.mock.calls[0]?.[1]);
  });

  test("revalidates the target before force escalation", async () => {
    const verifiedSignals: NodeJS.Signals[] = [];
    const deliveredSignals: Array<NodeJS.Signals | number | undefined> = [];
    const target = {
      pid: -4102,
      exitCode: null,
      signalCode: null,
      kill(signal?: NodeJS.Signals | number) {
        deliveredSignals.push(signal);
        return true;
      },
      once() {},
    };

    const result = await terminateWithTreeKill(target, {
      gracefulTimeoutMs: 1,
      forceTimeoutMs: 1,
      beforeSignal: async (signal) => {
        verifiedSignals.push(signal);
        return signal === "SIGTERM";
      },
    });

    expect(result).toBe("signal-skipped");
    expect(verifiedSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(deliveredSignals).toEqual(["SIGTERM"]);
  });

  test.runIf(process.platform === "win32")(
    "kills Windows descendants through taskkill tree cleanup",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "paseo-server-tree-kill-"));
      const childPidPath = join(tempDir, "descendant.pid");

      ownerProcess = spawnOwnerWithDescendant({
        childPidPath,
        detachedDescendant: false,
      });
      expect(ownerProcess.pid).toBeTypeOf("number");
      await waitForFixtureReady(childPidPath);

      const result = await terminateWithTreeKill(ownerProcess, {
        gracefulTimeoutMs: 2000,
        forceTimeoutMs: 2000,
      });

      // tree-kill uses taskkill /T /F on Windows, so the first signal is already forceful.
      expect(result).toBe("terminated");
      await expectOwnerAndDescendantStopped(
        "owner or Windows descendant survived terminateWithTreeKill",
      );
    },
  );

  test.runIf(process.platform !== "win32")(
    "force-kills descendants that started their own process group",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "paseo-server-tree-kill-"));
      const childPidPath = join(tempDir, "descendant.pid");

      ownerProcess = spawnOwnerWithDescendant({
        childPidPath,
        detachedDescendant: true,
      });
      expect(ownerProcess.pid).toBeTypeOf("number");
      await waitForFixtureReady(childPidPath);

      const result = await terminateWithTreeKill(ownerProcess, {
        gracefulTimeoutMs: 100,
        forceTimeoutMs: 2000,
      });

      expect(result).toBe("killed");
      await expectOwnerAndDescendantStopped(
        "owner or separate-process-group descendant survived terminateWithTreeKill",
      );
    },
  );
});
