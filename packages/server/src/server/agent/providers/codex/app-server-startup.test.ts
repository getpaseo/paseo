import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { createCodexAppServerChildProcess } from "./test-utils/fake-app-server.js";
import { CodexAppServerStartupCoordinator } from "./app-server-startup.js";
import { CodexAppServerExitError } from "./app-server-transport.js";

function sqliteStartupError(): CodexAppServerExitError {
  return new CodexAppServerExitError({
    exitCode: 1,
    exitSignal: null,
    stderr: "failed to initialize sqlite state runtime",
  });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Codex app-server startup coordinator", () => {
  test("serializes a burst through initialize but retains all initialized clients", async () => {
    const coordinator = new CodexAppServerStartupCoordinator();
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let spawned = 0;
    let activeInitializations = 0;
    let maxActiveInitializations = 0;
    let disposed = 0;

    const starts = Array.from({ length: 24 }, () =>
      coordinator.start({
        stateDirKey: "/codex/shared",
        spawn: () => {
          spawned++;
          return createCodexAppServerChildProcess();
        },
        createClient: () => ({
          request: async (method: string) => {
            expect(method).toBe("initialize");
            activeInitializations++;
            maxActiveInitializations = Math.max(maxActiveInitializations, activeInitializations);
            if (spawned === 1) {
              firstEntered.resolve();
              await releaseFirst.promise;
            }
            activeInitializations--;
            return {};
          },
          notify: vi.fn(),
          dispose: async () => {
            disposed++;
          },
        }),
        initializeParams: {},
        logger: createTestLogger(),
      }),
    );

    await firstEntered.promise;
    expect(spawned).toBe(1);
    releaseFirst.resolve();
    const clients = await Promise.all(starts);

    expect(clients).toHaveLength(24);
    expect(spawned).toBe(24);
    expect(maxActiveInitializations).toBe(1);
    expect(disposed).toBe(0);
  });

  test("allows different Codex homes to initialize concurrently", async () => {
    const coordinator = new CodexAppServerStartupCoordinator();
    const bothEntered = deferred();
    const release = deferred();
    let entered = 0;
    const start = (stateDirKey: string) =>
      coordinator.start({
        stateDirKey,
        spawn: createCodexAppServerChildProcess,
        createClient: () => ({
          request: async () => {
            entered++;
            if (entered === 2) bothEntered.resolve();
            await release.promise;
            return {};
          },
          notify: vi.fn(),
          dispose: vi.fn(async () => {}),
        }),
        initializeParams: {},
        logger: createTestLogger(),
      });

    const first = start("/codex/one");
    const second = start("/codex/two");
    await bothEntered.promise;
    expect(entered).toBe(2);
    release.resolve();
    await Promise.all([first, second]);
  });

  test("retries only SQLite startup failures after disposing the failed child", async () => {
    const coordinator = new CodexAppServerStartupCoordinator();
    const events: string[] = [];
    let attempt = 0;
    const client = await coordinator.start({
      stateDirKey: "/codex/shared",
      spawn: () => {
        attempt++;
        events.push(`spawn ${attempt}`);
        return createCodexAppServerChildProcess();
      },
      createClient: () => {
        const number = attempt;
        return {
          request: async () => {
            events.push(`initialize ${number}`);
            if (number === 1) throw sqliteStartupError();
            return {};
          },
          notify: () => events.push(`initialized ${number}`),
          dispose: async () => {
            events.push(`dispose ${number}`);
          },
        };
      },
      initializeParams: {},
      logger: createTestLogger(),
    });

    expect(client).toEqual(expect.objectContaining({ request: expect.any(Function) }));
    expect(events).toEqual([
      "spawn 1",
      "initialize 1",
      "dispose 1",
      "spawn 2",
      "initialize 2",
      "initialized 2",
    ]);
  });

  test("does not retry unrelated startup failures", async () => {
    const coordinator = new CodexAppServerStartupCoordinator();
    let spawned = 0;
    let disposed = 0;
    await expect(
      coordinator.start({
        stateDirKey: "/codex/shared",
        spawn: () => {
          spawned++;
          return createCodexAppServerChildProcess();
        },
        createClient: () => ({
          request: async () => {
            throw new Error("database is locked while reading unrelated configuration");
          },
          notify: vi.fn(),
          dispose: async () => {
            disposed++;
          },
        }),
        initializeParams: {},
        logger: createTestLogger(),
      }),
    ).rejects.toThrow("database is locked while reading unrelated configuration");
    expect(spawned).toBe(1);
    expect(disposed).toBe(1);
  });

  test("bounds persistent SQLite failures and leaves the lane usable", async () => {
    const coordinator = new CodexAppServerStartupCoordinator();
    let spawned = 0;
    let disposed = 0;
    let locked = true;
    const start = () =>
      coordinator.start({
        stateDirKey: "/codex/shared",
        spawn: () => {
          spawned++;
          return createCodexAppServerChildProcess();
        },
        createClient: () => ({
          request: async () => {
            if (locked) throw sqliteStartupError();
            return {};
          },
          notify: vi.fn(),
          dispose: async () => {
            disposed++;
          },
        }),
        initializeParams: {},
        logger: createTestLogger(),
      });

    await expect(start()).rejects.toThrow("failed to initialize sqlite state runtime");
    expect(spawned).toBe(3);
    expect(disposed).toBe(3);
    locked = false;
    await expect(start()).resolves.toEqual(
      expect.objectContaining({ request: expect.any(Function) }),
    );
    expect(spawned).toBe(4);
    expect(disposed).toBe(3);
  });

  test("a cancelled waiter never spawns or overtakes the active startup", async () => {
    const coordinator = new CodexAppServerStartupCoordinator();
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const events: string[] = [];
    const first = coordinator.start({
      stateDirKey: "/codex/shared",
      spawn: () => {
        events.push("spawn first");
        return createCodexAppServerChildProcess();
      },
      createClient: () => ({
        request: async () => {
          firstEntered.resolve();
          await releaseFirst.promise;
          return {};
        },
        notify: vi.fn(),
        dispose: vi.fn(async () => {}),
      }),
      initializeParams: {},
      logger: createTestLogger(),
    });
    await firstEntered.promise;

    const controller = new AbortController();
    const queued = coordinator.start({
      stateDirKey: "/codex/shared",
      spawn: () => {
        events.push("spawn cancelled");
        return createCodexAppServerChildProcess();
      },
      createClient: () => ({
        request: async () => ({}),
        notify: vi.fn(),
        dispose: vi.fn(async () => {}),
      }),
      initializeParams: {},
      logger: createTestLogger(),
      signal: controller.signal,
    });
    controller.abort(new Error("cancelled"));
    await expect(queued).rejects.toThrow("cancelled");
    const next = coordinator.start({
      stateDirKey: "/codex/shared",
      spawn: () => {
        events.push("spawn next");
        return createCodexAppServerChildProcess();
      },
      createClient: () => ({
        request: async () => ({}),
        notify: vi.fn(),
        dispose: vi.fn(async () => {}),
      }),
      initializeParams: {},
      logger: createTestLogger(),
    });

    expect(events).toEqual(["spawn first"]);
    releaseFirst.resolve();
    await Promise.all([first, next]);
    expect(events).toEqual(["spawn first", "spawn next"]);
  });

  test("a timed-out initialize disposes its child and releases the next waiter", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new CodexAppServerStartupCoordinator({
        attemptTimeoutMs: 10,
        queueTimeoutMs: 100,
      });
      const firstEntered = deferred();
      const events: string[] = [];
      const first = coordinator.start({
        stateDirKey: "/codex/shared",
        spawn: createCodexAppServerChildProcess,
        createClient: () => ({
          request: () => {
            firstEntered.resolve();
            return new Promise<never>(() => {});
          },
          notify: vi.fn(),
          dispose: async () => {
            events.push("dispose first");
          },
        }),
        initializeParams: {},
        logger: createTestLogger(),
      });
      await firstEntered.promise;
      const next = coordinator.start({
        stateDirKey: "/codex/shared",
        spawn: () => {
          events.push("spawn next");
          return createCodexAppServerChildProcess();
        },
        createClient: () => ({
          request: async () => ({}),
          notify: vi.fn(),
          dispose: vi.fn(async () => {}),
        }),
        initializeParams: {},
        logger: createTestLogger(),
      });

      const firstResult = expect(first).rejects.toThrow("Timed out initializing Codex app-server");
      await vi.advanceTimersByTimeAsync(10);
      await firstResult;
      await expect(next).resolves.toEqual(
        expect.objectContaining({ request: expect.any(Function) }),
      );
      expect(events).toEqual(["dispose first", "spawn next"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
