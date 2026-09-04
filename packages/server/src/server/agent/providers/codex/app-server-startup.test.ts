import { describe, expect, test, vi } from "vitest";

import { runCodexAppServerStartup } from "./app-server-startup.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Codex app-server startup", () => {
  test("serializes concurrent SQLite runtime initialization", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const starts: string[] = [];

    const first = runCodexAppServerStartup({
      start: async () => {
        starts.push("first");
        firstStarted.resolve();
        await releaseFirst.promise;
        return "first";
      },
    });
    await firstStarted.promise;

    const second = runCodexAppServerStartup({
      start: async () => {
        starts.push("second");
        return "second";
      },
    });
    await Promise.resolve();

    expect(starts).toEqual(["first"]);
    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(starts).toEqual(["first", "second"]);
  });

  test("retries SQLite initialization failures with a fresh startup attempt", async () => {
    const starts = vi.fn(async (attempt: number) => {
      if (attempt < 3) {
        throw new Error(
          "Codex app-server exited with code 1 and signal null\n" +
            "Error: failed to initialize sqlite state runtime under /tmp/codex-home: " +
            "failed to initialize state runtime at /tmp/codex-home",
        );
      }
      return `client-${attempt}`;
    });
    const retries = vi.fn();

    await expect(runCodexAppServerStartup({ start: starts, onRetry: retries })).resolves.toBe(
      "client-3",
    );
    expect(starts).toHaveBeenCalledTimes(3);
    expect(retries).toHaveBeenCalledTimes(2);
    expect(retries).toHaveBeenNthCalledWith(1, expect.any(Error), 2, 3);
    expect(retries).toHaveBeenNthCalledWith(2, expect.any(Error), 3, 3);
  });

  test("rejects a queued startup as soon as its signal aborts", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const first = runCodexAppServerStartup({
      start: async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
        return "first";
      },
    });
    await firstStarted.promise;

    const controller = new AbortController();
    const secondStart = vi.fn(async () => "second");
    const second = runCodexAppServerStartup({
      signal: controller.signal,
      start: secondStart,
    });
    controller.abort(new Error("refresh expired"));

    await expect(second).rejects.toThrow("refresh expired");
    expect(secondStart).not.toHaveBeenCalled();
    releaseFirst.resolve();
    await expect(first).resolves.toBe("first");
  });

  test("releases the queue when a running startup never settles", async () => {
    vi.useFakeTimers();
    const firstStarted = deferred();
    const firstAborted = deferred();
    const cleanupAllowed = deferred();
    const secondStart = vi.fn(async () => "second");

    try {
      const first = runCodexAppServerStartup({
        timeoutMs: 100,
        start: async (_attempt, signal) => {
          firstStarted.resolve();
          signal.addEventListener("abort", firstAborted.resolve, { once: true });
          return await new Promise<never>(() => {});
        },
        onAbort: async () => await cleanupAllowed.promise,
      });
      await firstStarted.promise;
      const second = runCodexAppServerStartup({ start: secondStart });

      await vi.advanceTimersByTimeAsync(100);
      await firstAborted.promise;
      await Promise.resolve();
      expect(secondStart).not.toHaveBeenCalled();

      cleanupAllowed.resolve();

      await expect(first).rejects.toThrow("startup timed out after 100ms");
      await expect(second).resolves.toBe("second");
      expect(secondStart).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not retry unrelated startup failures", async () => {
    const starts = vi.fn(async () => {
      throw new Error("Codex binary is not executable");
    });

    await expect(runCodexAppServerStartup({ start: starts })).rejects.toThrow(
      "Codex binary is not executable",
    );
    expect(starts).toHaveBeenCalledTimes(1);
  });
});
