import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PidLockInfo } from "./pid-lock.js";

const pidLock = {
  info: null as PidLockInfo | null,
  running: true,
  same: true,
  released: 0,
};

vi.mock("./pid-lock.js", () => ({
  getPidLockInfo: async () => pidLock.info,
  isPidRunning: () => pidLock.running,
  isSamePidLock: () => pidLock.same,
  releasePidLock: async () => {
    pidLock.released += 1;
  },
}));

vi.mock("./config-environment.js", () => ({
  daemonLaunchEnvironment: (input: unknown) => input,
}));

vi.mock("./persisted-config.js", () => ({
  readPersistedConfig: () => ({}),
}));

const { stopDaemonInstance, DaemonInstanceError } = await import("./daemon-instance.js");

const instance: PidLockInfo = {
  pid: 4242,
  startedAt: "2026-01-01T00:00:00.000Z",
  listen: "127.0.0.1:4949",
} as PidLockInfo;

describe("stopDaemonInstance cancellation", () => {
  beforeEach(() => {
    pidLock.info = { ...instance };
    pidLock.running = true;
    pidLock.same = true;
    pidLock.released = 0;
  });

  it("returns cancelled instead of throwing when the signal aborts mid-wait", async () => {
    const controller = new AbortController();
    const stop = stopDaemonInstance("/tmp/home", {
      timeoutMs: 15_000,
      signal: controller.signal,
      requestShutdown: async () => {},
    });

    // Abort while the daemon is still reported running.
    setTimeout(() => controller.abort(), 10);
    const result = await stop;

    expect(result.action).toBe("cancelled");
    expect(result.pid).toBe(4242);
    // A cancelled wait must not release the lock: the daemon may still be alive.
    expect(pidLock.released).toBe(0);
  });

  it("stops normally when no signal is provided", async () => {
    const stop = stopDaemonInstance("/tmp/home", {
      timeoutMs: 15_000,
      requestShutdown: async () => {},
    });
    // The daemon exits on the first poll.
    setTimeout(() => {
      pidLock.running = false;
    }, 10);
    const result = await stop;

    expect(result.action).toBe("stopped");
    expect(pidLock.released).toBe(1);
  });

  it("still reports not_running without a signal", async () => {
    pidLock.info = null;
    const result = await stopDaemonInstance("/tmp/home", {});
    expect(result.action).toBe("not_running");
  });

  it("keeps the STOP_NOT_CONFIRMED error when the daemon never exits", async () => {
    await expect(
      stopDaemonInstance("/tmp/home", {
        timeoutMs: 30,
        requestShutdown: async () => {},
      }),
    ).rejects.toBeInstanceOf(DaemonInstanceError);
  });
});
