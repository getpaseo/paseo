import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      callback(null, "", "");
    },
  ),
);

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: execFileMock,
  };
});

import { BackgroundGitFetchManager } from "./background-git-fetch-manager.js";

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createLogger() {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    warn: vi.fn(),
  };
  return logger;
}

describe("BackgroundGitFetchManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        callback(null, "", "");
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("creates a fetch timer for a repo with an origin remote", async () => {
    const logger = createLogger();
    const manager = new BackgroundGitFetchManager({ logger: logger as any });

    const subscription = await manager.subscribe(
      { repoGitRoot: "/tmp/repo/.git", cwd: "/tmp/repo" },
      vi.fn(),
    );
    await flushPromises();

    const managerAny = manager as any;
    const target = managerAny.targets.get("/tmp/repo/.git");
    expect(target).toBeDefined();
    expect(target.intervalId).toBeTruthy();
    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      "git",
      ["remote", "get-url", "origin"],
      expect.objectContaining({
        cwd: "/tmp/repo",
        env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0" }),
      }),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "git",
      ["fetch", "origin", "--prune"],
      expect.objectContaining({
        cwd: "/tmp/repo",
        env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0" }),
      }),
      expect.any(Function),
    );

    subscription.unsubscribe();
    manager.dispose();
  });

  test("dedupes multiple subscribers for the same repo root behind one timer", async () => {
    const logger = createLogger();
    const manager = new BackgroundGitFetchManager({ logger: logger as any });

    const listenerOne = vi.fn();
    const listenerTwo = vi.fn();
    const subscriptionOne = await manager.subscribe(
      { repoGitRoot: "/tmp/repo/.git", cwd: "/tmp/repo" },
      listenerOne,
    );
    const subscriptionTwo = await manager.subscribe(
      { repoGitRoot: "/tmp/repo/.git", cwd: "/tmp/repo-worktree" },
      listenerTwo,
    );
    await flushPromises();

    const managerAny = manager as any;
    const target = managerAny.targets.get("/tmp/repo/.git");
    expect(managerAny.targets.size).toBe(1);
    expect(target.listeners).toEqual(new Set([listenerOne, listenerTwo]));
    expect(execFileMock.mock.calls.filter((call) => call[1][0] === "remote")).toHaveLength(1);

    subscriptionOne.unsubscribe();
    subscriptionTwo.unsubscribe();
    manager.dispose();
  });

  test("cleans up the timer when the last subscriber unsubscribes", async () => {
    const logger = createLogger();
    const manager = new BackgroundGitFetchManager({ logger: logger as any });

    const subscription = await manager.subscribe(
      { repoGitRoot: "/tmp/repo/.git", cwd: "/tmp/repo" },
      vi.fn(),
    );
    await flushPromises();

    const managerAny = manager as any;
    const target = managerAny.targets.get("/tmp/repo/.git");
    const intervalId = target.intervalId;
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    subscription.unsubscribe();

    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
    expect(managerAny.targets.size).toBe(0);

    clearIntervalSpy.mockRestore();
    manager.dispose();
  });

  test("logs fetch errors without crashing", async () => {
    const logger = createLogger();
    execFileMock.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        if (args[0] === "remote") {
          callback(null, "", "");
          return;
        }
        callback(new Error("fetch failed"));
      },
    );
    const manager = new BackgroundGitFetchManager({ logger: logger as any });

    await manager.subscribe({ repoGitRoot: "/tmp/repo/.git", cwd: "/tmp/repo" }, vi.fn());
    await flushPromises();

    expect(logger.debug).toHaveBeenCalledWith(
      { repoGitRoot: "/tmp/repo/.git", cwd: "/tmp/repo" },
      "Running background git fetch",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      {
        err: expect.any(Error),
        repoGitRoot: "/tmp/repo/.git",
        cwd: "/tmp/repo",
      },
      "Background git fetch failed",
    );

    manager.dispose();
  });

  test("calls listeners when a fetch completes", async () => {
    const logger = createLogger();
    const manager = new BackgroundGitFetchManager({ logger: logger as any });
    const listener = vi.fn();

    await manager.subscribe({ repoGitRoot: "/tmp/repo/.git", cwd: "/tmp/repo" }, listener);
    await flushPromises();

    expect(listener).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(180_000);
    await flushPromises();

    expect(listener).toHaveBeenCalledTimes(2);

    manager.dispose();
  });

  test("does not create a timer when the repo has no origin remote", async () => {
    const logger = createLogger();
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        callback(new Error("missing origin"));
      },
    );
    const manager = new BackgroundGitFetchManager({ logger: logger as any });

    const subscription = await manager.subscribe(
      { repoGitRoot: "/tmp/repo/.git", cwd: "/tmp/repo" },
      vi.fn(),
    );

    expect((manager as any).targets.size).toBe(0);
    subscription.unsubscribe();
    manager.dispose();
  });

  test("dispose clears timers and listeners", async () => {
    const logger = createLogger();
    const manager = new BackgroundGitFetchManager({ logger: logger as any });

    const listener = vi.fn();
    await manager.subscribe({ repoGitRoot: "/tmp/repo-one/.git", cwd: "/tmp/repo-one" }, listener);
    await manager.subscribe({ repoGitRoot: "/tmp/repo-two/.git", cwd: "/tmp/repo-two" }, vi.fn());
    await flushPromises();

    const managerAny = manager as any;
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    manager.dispose();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    expect(managerAny.targets.size).toBe(0);

    clearIntervalSpy.mockRestore();
  });
});
