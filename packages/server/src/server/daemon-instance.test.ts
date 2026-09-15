import { describe, expect, it } from "vitest";

import {
  DaemonInstanceError,
  stopDaemonInstance,
  type StopDaemonPorts,
} from "./daemon-instance.js";
import type { PidLockInfo } from "./pid-lock.js";

const INSTANCE = {
  pid: 4242,
  startedAt: "2026-01-01T00:00:00.000Z",
  listen: "127.0.0.1:4949",
} as PidLockInfo;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * In-memory stand-in for the daemon environment. `wait` is a controllable gate:
 * each call parks until the test releases it, so abort and exit points are
 * chosen exactly instead of by making timing assumptions. `enteredWait` resolves
 * on the first parked wait, giving the test a deterministic sync point.
 */
function createFakePorts(input?: { instance?: PidLockInfo | null }) {
  const fake = {
    instance: input?.instance === undefined ? ({ ...INSTANCE } as PidLockInfo) : input.instance,
    running: true,
    events: [] as string[],
    enteredWait: deferred<void>(),
    pendingWait: null as { resolve(): void; reject(error: Error): void } | null,
  };
  const ports: StopDaemonPorts = {
    async readInstance() {
      return fake.instance;
    },
    isRunning() {
      return fake.running;
    },
    isSameInstance(left, right) {
      return left.pid === right.pid && left.startedAt === right.startedAt;
    },
    async releaseLock() {
      fake.events.push("release-lock");
      fake.instance = null;
    },
    async signalTerm() {
      // Platform-dependent environment call; not part of the behavior asserted here.
    },
    async killTree() {
      fake.events.push("kill-tree");
      fake.running = false;
    },
    wait(_ms, signal) {
      if (signal?.aborted) {
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      }
      return new Promise<void>((resolve, reject) => {
        const settle = (fn: () => void) => {
          fake.pendingWait = null;
          signal?.removeEventListener("abort", onAbort);
          fn();
        };
        const onAbort = () => settle(() => reject(new DOMException("Aborted", "AbortError")));
        fake.pendingWait = {
          resolve: () => settle(resolve),
          reject: (error: Error) => settle(() => reject(error)),
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        fake.enteredWait.resolve();
      });
    },
  };
  return {
    ports,
    firstWait: fake.enteredWait.promise,
    state: fake,
    resolveWait() {
      fake.pendingWait?.resolve();
    },
  };
}

describe("stopDaemonInstance", () => {
  it("returns cancelled instead of throwing when the signal aborts during the wait", async () => {
    const fake = createFakePorts();
    const controller = new AbortController();
    const stop = stopDaemonInstance("/tmp/home", {
      timeoutMs: 15_000,
      signal: controller.signal,
      ports: fake.ports,
      requestShutdown: async () => {},
    });

    await fake.firstWait;
    controller.abort();
    const result = await stop;

    // `usedLifecycleRpc` differs by platform (Windows uses the shutdown RPC,
    // POSIX sends SIGTERM), so assert the fields this test owns.
    expect(result).toMatchObject({
      action: "cancelled",
      pid: 4242,
      forced: false,
    });
    // A cancelled wait must not release the lock: the daemon may still be alive.
    expect(fake.state.events).toEqual([]);
    expect(fake.state.instance).not.toBeNull();
  });

  it("returns cancelled when the signal aborts while the shutdown RPC is in flight", async () => {
    const fake = createFakePorts();
    const controller = new AbortController();
    const stop = stopDaemonInstance("/tmp/home", {
      timeoutMs: 15_000,
      signal: controller.signal,
      ports: fake.ports,
      // A shutdown RPC that never settles must not block the stop past the
      // deadline: an aborted signal cancels it (Windows) or the wait loop
      // reports the cancellation (POSIX).
      requestShutdown: () => new Promise<void>(() => {}),
    });

    controller.abort();
    const result = await stop;

    expect(result).toMatchObject({
      action: "cancelled",
      pid: 4242,
      forced: false,
    });
    expect(fake.state.events).toEqual([]);
  });

  it("stops once the daemon exits and releases the lock", async () => {
    const fake = createFakePorts();
    const stop = stopDaemonInstance("/tmp/home", {
      timeoutMs: 15_000,
      ports: fake.ports,
      requestShutdown: async () => {},
    });

    await fake.firstWait;
    fake.state.running = false;
    fake.resolveWait();

    const result = await stop;
    expect(result).toMatchObject({
      action: "stopped",
      pid: 4242,
      forced: false,
    });
    expect(fake.state.events).toEqual(["release-lock"]);
  });

  it("reports not_running when no supervisor holds the lock", async () => {
    const fake = createFakePorts({ instance: null });
    const result = await stopDaemonInstance("/tmp/home", { ports: fake.ports });
    expect(result).toEqual({
      action: "not_running",
      pid: null,
      forced: false,
      usedLifecycleRpc: false,
    });
  });

  it("fails with STOP_NOT_CONFIRMED when the daemon never exits before the timeout", async () => {
    const fake = createFakePorts();
    const stop = stopDaemonInstance("/tmp/home", {
      timeoutMs: 0,
      ports: fake.ports,
      requestShutdown: async () => {},
    });

    await expect(stop).rejects.toBeInstanceOf(DaemonInstanceError);
    await expect(stop).rejects.toMatchObject({ code: "STOP_NOT_CONFIRMED" });
    expect(fake.state.events).toEqual([]);
  });
});
