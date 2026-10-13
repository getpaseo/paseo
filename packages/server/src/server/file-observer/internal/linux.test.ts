import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createFileObserver } from "../index.js";
import { createLinuxBackend } from "./linux.js";
import { createObserverPaths } from "./paths.js";

// This backend keeps no file-level inventory and runs no periodic full-tree
// safety audit (see the comment on MAX_QUEUED_CLASSIFICATIONS in linux.ts), so
// a shed classification could never be recovered later the way the native
// backend's directory audit recovers one. Overflow must fail the observation
// loudly instead of silently dropping a create or delete.
test("the linux backend fails the observation when the classification queue overflows", async () => {
  const root = await mkdtemp(join(tmpdir(), "linux-classify-"));
  const paths = createObserverPaths(process.platform);
  const notifications = new EventEmitter();
  const observer = createFileObserver();
  let active = true;
  let failure: Error | null = null;
  const backend = createLinuxBackend(
    {
      root,
      metrics: observer.getDiagnostics(),
      isActive: () => active,
      isIgnored: () => false,
      isPathInside: paths.isInside,
      queueEvent: () => {},
      fail: (error) => {
        // Mirror the real Observation host: a failure ends the subscription,
        // so isActive() must flip immediately and further events must not be
        // processed.
        active = false;
        failure = error;
      },
    },
    paths,
    (_directory, listener) => {
      notifications.on("change", listener);
      return {
        close: () => notifications.removeAllListeners(),
        on: (event: string, onError: (error: Error) => void) => notifications.on(event, onError),
      } as never;
    },
  );
  try {
    await backend.start();
    // Emitted synchronously: no stat can settle before the last event lands,
    // so the queue grows monotonically until it overflows. Once it does,
    // isActive() flips false and the backend's own listener guard skips the
    // rest of the burst, so it's safe to keep emitting unconditionally.
    for (let index = 0; index < 20_000; index += 1) {
      notifications.emit("change", "rename", `module-${index}.js`);
    }
    expect(active).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toMatch(/exceeded \d+ queued classifications/);
  } finally {
    active = false;
    await backend.close();
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an ignore update drains classifications queued below the new excluded root", async () => {
  const root = await mkdtemp(join(tmpdir(), "linux-ignore-queue-"));
  const ignored = join(root, "generated");
  await mkdir(ignored);
  const tracked = join(root, "tracked.txt");
  await writeFile(tracked, "tracked");
  // The backend is injected for deterministic queue admission, but its real
  // temporary root uses the host filesystem's path format.
  const paths = createObserverPaths(process.platform);
  let onRootChange: ((eventType: string, filename: string | null) => void) | null = null;
  const observer = createFileObserver();
  let active = true;
  let ignoreGenerated = false;
  const delivered: string[] = [];
  const backend = createLinuxBackend(
    {
      root,
      metrics: observer.getDiagnostics(),
      isActive: () => active,
      isIgnored: (path) => ignoreGenerated && paths.isInside(ignored, path),
      isPathInside: paths.isInside,
      queueEvent: (type, path) => {
        if (type === "create") delivered.push(path);
      },
      fail: (error) => {
        throw error;
      },
    },
    paths,
    (directory, listener) => {
      if (directory === root) onRootChange = listener;
      return {
        close: () => {},
        on: () => {},
      } as never;
    },
  );
  try {
    await backend.start();
    delivered.length = 0;
    for (let index = 0; index < 6_000; index += 1) {
      onRootChange?.("rename", `generated/file-${index}.js`);
    }
    onRootChange?.("rename", "tracked.txt");
    expect(backend.getDiagnostics().pendingClassificationCount).toBeGreaterThan(0);
    ignoreGenerated = true;
    await backend.updateIgnore();
    expect(backend.getDiagnostics().pendingClassificationCount).toBeLessThanOrEqual(1);
    await expect.poll(() => delivered.includes(tracked)).toBe(true);
  } finally {
    active = false;
    await backend.close();
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
});
