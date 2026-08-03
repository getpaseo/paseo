import { afterEach, describe, expect, test, vi } from "vitest";

import { GitProcessScheduler, resolveGitProcessPolicy } from "./git-process-scheduler.js";

function createConcurrencyTask(
  index: number,
  started: number[],
  releases: Array<() => void>,
): () => { result: Promise<void>; exited: Promise<void> } {
  return () => {
    started.push(index);
    if (index >= 2) {
      const completed = Promise.resolve();
      return { result: completed, exited: completed };
    }
    const completed = new Promise<void>((resolve) => {
      releases.push(resolve);
    });
    return { result: completed, exited: completed };
  };
}

describe("GitProcessScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("limits unresolved processes independently of their start rate", async () => {
    const scheduler = new GitProcessScheduler({
      maxProcessesPerSecond: 100,
      maxProcessConcurrency: 2,
    });
    const releases: Array<() => void> = [];
    const started: number[] = [];
    const tasks = Array.from({ length: 4 }, (_, index) =>
      scheduler.run(createConcurrencyTask(index, started, releases)),
    );

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    releases.shift()?.();
    await vi.waitFor(() => expect(started).toContain(2));
    releases.shift()?.();
    await Promise.all(tasks);

    expect(scheduler.activeCount).toBe(0);
    expect(scheduler.pendingCount).toBe(0);
  });

  test("limits process starts in each strict one-second interval", async () => {
    vi.useFakeTimers();
    const scheduler = new GitProcessScheduler({
      maxProcessesPerSecond: 2,
      maxProcessConcurrency: 4,
    });
    const startedAt: number[] = [];
    const recordStart = () => {
      startedAt.push(Date.now());
      const completed = Promise.resolve();
      return { result: completed, exited: completed };
    };
    const tasks = Array.from({ length: 4 }, () => scheduler.run(recordStart));

    await vi.advanceTimersByTimeAsync(0);
    expect(startedAt).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(startedAt).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(startedAt).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all(tasks);

    expect(startedAt).toHaveLength(4);
    expect(startedAt[2]! - startedAt[0]!).toBeGreaterThanOrEqual(1_000);
  });
});

describe("resolveGitProcessPolicy", () => {
  test("prefers renamed environment variables over legacy and persisted values", () => {
    expect(
      resolveGitProcessPolicy({
        env: {
          PASEO_GIT_MAX_PROCESSES_PER_SECOND: "12",
          PASEO_GIT_MAX_PROCESS_CONCURRENCY: "7",
          PASEO_GIT_CONCURRENCY: "3",
        },
        persisted: { maxProcessesPerSecond: 5, maxProcessConcurrency: 4 },
      }),
    ).toEqual({ maxProcessesPerSecond: 12, maxProcessConcurrency: 7 });
  });
});
