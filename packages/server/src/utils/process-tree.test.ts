import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import { describe, expect, test, vi } from "vitest";

import { signalProcessTree, terminateProcessTree, type ProcessTreeTarget } from "./process-tree.js";

const execFileAsync = promisify(execFile);

describe("signalProcessTree", () => {
  test.each(["darwin", "linux"] as const)("signals the %s process group", (platform) => {
    const child = createChild({ pid: 1234 });
    const kill = vi.fn(() => true);

    signalProcessTree(child, "SIGTERM", { platform, kill });

    expect(kill).toHaveBeenCalledWith(-1234, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
  });

  test("falls back to direct child signaling when POSIX process group signaling fails", () => {
    const child = createChild({ pid: 1234 });

    signalProcessTree(child, "SIGTERM", {
      platform: "darwin",
      kill: vi.fn(() => {
        throw new Error("no process group");
      }),
    });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("uses taskkill for Windows process trees", () => {
    const child = createChild({ pid: 1234 });
    const execFileMock = vi.fn((_file, _args, callback) => {
      callback(null);
    });

    signalProcessTree(child, "SIGTERM", { platform: "win32", execFile: execFileMock });

    expect(execFileMock).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", "1234", "/T"],
      expect.any(Function),
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  test("forces Windows process tree cleanup for SIGKILL", () => {
    const child = createChild({ pid: 1234 });
    const execFileMock = vi.fn((_file, _args, callback) => {
      callback(null);
    });

    signalProcessTree(child, "SIGKILL", { platform: "win32", execFile: execFileMock });

    expect(execFileMock).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", "1234", "/T", "/F"],
      expect.any(Function),
    );
  });

  test("falls back to direct child signaling when taskkill cannot run", () => {
    const child = createChild({ pid: 1234 });
    const execFileMock = vi.fn((_file, _args, callback) => {
      callback(Object.assign(new Error("taskkill failed"), { code: "ENOENT" }));
    });

    signalProcessTree(child, "SIGTERM", { platform: "win32", execFile: execFileMock });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("does not signal an exited child", () => {
    const child = createChild({ pid: 1234, exitCode: 0 });
    const kill = vi.fn(() => true);

    signalProcessTree(child, "SIGTERM", { platform: "darwin", kill });

    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  test("terminateProcessTree returns after graceful exit", async () => {
    const child = createEventedChild({ pid: 1234 });
    const kill = vi.fn(() => true);

    const resultPromise = terminateProcessTree(child, {
      platform: "darwin",
      gracefulTimeoutMs: 100,
      forceTimeoutMs: 100,
      kill,
    });
    child.emit("exit");

    await expect(resultPromise).resolves.toBe("terminated");
    expect(kill).toHaveBeenCalledWith(-1234, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(-1234, "SIGKILL");
  });

  test("terminateProcessTree sends SIGKILL after graceful timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = createEventedChild({ pid: 1234 });
      const kill = vi.fn(() => true);
      const onForceSignal = vi.fn();

      const resultPromise = terminateProcessTree(child, {
        platform: "darwin",
        gracefulTimeoutMs: 100,
        forceTimeoutMs: 100,
        kill,
        onForceSignal,
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(onForceSignal).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenNthCalledWith(1, -1234, "SIGTERM");
      expect(kill).toHaveBeenNthCalledWith(2, -1234, "SIGKILL");

      child.emit("exit");
      await expect(resultPromise).resolves.toBe("killed");
    } finally {
      vi.useRealTimers();
    }
  });

  test("terminateProcessTree reports when forced cleanup does not exit", async () => {
    vi.useFakeTimers();
    try {
      const child = createEventedChild({ pid: 1234 });
      const kill = vi.fn(() => true);

      const resultPromise = terminateProcessTree(child, {
        platform: "darwin",
        gracefulTimeoutMs: 100,
        forceTimeoutMs: 100,
        kill,
      });

      await vi.advanceTimersByTimeAsync(200);

      await expect(resultPromise).resolves.toBe("kill-timeout");
      expect(kill).toHaveBeenNthCalledWith(1, -1234, "SIGTERM");
      expect(kill).toHaveBeenNthCalledWith(2, -1234, "SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  test.skipIf(process.platform === "win32")("kills a detached POSIX process group", async () => {
    const child = spawn("/bin/sh", ["-c", "sleep 60 & wait"], {
      detached: true,
      stdio: "ignore",
    });
    const pid = child.pid;
    if (typeof pid !== "number") {
      throw new Error("spawned shell did not expose a pid");
    }

    let childPids: number[] = [];
    try {
      childPids = await waitForChildren(pid);
      await expect(
        terminateProcessTree(child, {
          gracefulTimeoutMs: 1000,
          forceTimeoutMs: 1000,
        }),
      ).resolves.toMatch(/^(terminated|killed)$/);
      await waitForNoLivePids(childPids);
    } finally {
      cleanupPidGroup(pid);
      for (const childPid of childPids) {
        cleanupPid(childPid);
      }
    }
  });
});

function createChild(options: { pid?: number; exitCode?: number | null } = {}): ProcessTreeTarget {
  return {
    pid: options.pid,
    exitCode: options.exitCode ?? null,
    signalCode: null,
    kill: vi.fn(() => true),
  };
}

function createEventedChild(options: { pid?: number }): ProcessTreeTarget & EventEmitter {
  const child = new EventEmitter() as ProcessTreeTarget & EventEmitter;
  child.pid = options.pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  return child;
}

async function waitForChildren(parentPid: number): Promise<number[]> {
  return waitFor(async () => {
    const { stdout } = await execFileAsync("pgrep", ["-P", String(parentPid)]).catch(() => ({
      stdout: "",
    }));
    const pids = stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0);
    return pids.length > 0 ? pids : null;
  });
}

async function waitForNoLivePids(pids: number[]): Promise<void> {
  await waitFor(() => (pids.every((pid) => !isPidAlive(pid)) ? true : null));
}

async function waitFor<T>(probe: () => T | null | Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 3000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError instanceof Error ? lastError : new Error("timed out waiting for condition");
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupPidGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ignore cleanup races
  }
}

function cleanupPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore cleanup races
  }
}
