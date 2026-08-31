import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { withTimelineMutationLock } from "./file-mutation-lock.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("withTimelineMutationLock", () => {
  it("fails closed instead of stealing an existing lock", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-timeline-lock-"));
    directories.push(directory);
    const first = deferred<void>();
    const firstAcquired = deferred<void>();

    const owner = withTimelineMutationLock(
      directory,
      async () => {
        firstAcquired.resolve();
        await first.promise;
      },
      { createToken: () => "current-owner" },
    );
    await firstAcquired.promise;
    await expect(
      withTimelineMutationLock(directory, async () => undefined, {
        retries: 1,
        retryMs: 0,
        createToken: () => "contending-owner",
      }),
    ).rejects.toThrow("Timed out acquiring timeline mutation lock");

    first.resolve();
    await owner;
    await expect(
      withTimelineMutationLock(directory, async () => "acquired", {
        retries: 1,
        retryMs: 0,
        createToken: () => "next-owner",
      }),
    ).resolves.toBe("acquired");
  });

  it("does not let an old owner release an adversarial replacement lock", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-timeline-lock-"));
    directories.push(directory);
    const releaseOwner = deferred<void>();
    const ownerAcquired = deferred<void>();
    const lockPath = path.join(directory, ".timeline-write.lock");
    const owner = withTimelineMutationLock(
      directory,
      async () => {
        ownerAcquired.resolve();
        await releaseOwner.promise;
      },
      { createToken: () => "original-owner" },
    );
    await ownerAcquired.promise;
    await unlink(lockPath);
    const replacement = { token: "replacement-owner", pid: process.pid, createdAt: Date.now() };
    await writeFile(lockPath, JSON.stringify(replacement), { flag: "wx" });

    releaseOwner.resolve();
    await owner;

    await expect(readFile(lockPath, "utf8")).resolves.toBe(JSON.stringify(replacement));
  });

  it("rejects unsafe owner tokens before constructing a cache pathname", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-timeline-lock-"));
    directories.push(directory);

    await expect(
      withTimelineMutationLock(directory, async () => undefined, {
        createToken: () => "../escape",
      }),
    ).rejects.toThrow("Invalid timeline mutation lock token");
    await expect(readdir(directory)).resolves.toEqual([]);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
