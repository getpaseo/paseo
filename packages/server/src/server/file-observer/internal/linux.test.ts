import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createFileObserver, type FileChangeType } from "../index.js";
import { createLinuxBackend } from "./linux.js";
import { createObserverPaths } from "./paths.js";

test("file creates only check watched directories in the changed subtree", async () => {
  const root = await mkdtemp(join(tmpdir(), "linux-file-scopes-"));
  const fixture = createWatchedBackend(root);
  try {
    for (let index = 0; index < 128; index += 1) await mkdir(join(root, `dir-${index}`));
    await fixture.backend.start();
    fixture.counts.ancestry = 0;
    const files = Array.from({ length: 12 }, (_, index) => `file-${index}.txt`);
    for (const file of files) {
      await writeFile(join(root, file), "created");
      fixture.watchers.get(root)!.emit("change", "rename", file);
    }
    await expect
      .poll(() => fixture.backend.getDiagnostics().pendingReconciliationWorkCount)
      .toBe(0);
    expect(fixture.events.sort((left, right) => left.path.localeCompare(right.path))).toEqual(
      files
        .sort((left, right) => left.localeCompare(right))
        .map((file) => ({ type: "create", path: join(root, file) })),
    );
    expect(fixture.backend.getDiagnostics().nativeHandleCount).toBe(129);
    expect(fixture.counts.ancestry).toBe(0);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "directory-to-file replacement removes descendant watchers (ancestor ENOENT: %s)",
  async (missingAncestor) => {
    const root = await mkdtemp(join(tmpdir(), "linux-replacement-"));
    const fixture = createWatchedBackend(root);
    const replaced = join(root, "dir");
    const child = join(replaced, "child");
    const sibling = join(root, "dir-sibling");
    const dottedSibling = join(root, "dir.more");
    try {
      await mkdir(child, { recursive: true });
      await mkdir(join(sibling, "child"), { recursive: true });
      await mkdir(dottedSibling);
      await fixture.backend.start();
      expect(fixture.watchers.size).toBe(6);
      await rm(replaced, { recursive: true });
      await writeFile(replaced, "replacement");
      if (missingAncestor) {
        fixture.watchers
          .get(replaced)!
          .emit("error", Object.assign(new Error("gone"), { code: "ENOENT" }));
      } else {
        fixture.watchers.get(root)!.emit("change", "rename", "dir");
      }
      await expect
        .poll(() => fixture.backend.getDiagnostics().pendingReconciliationWorkCount)
        .toBe(0);
      expect([...fixture.watchers.keys()].sort()).toEqual(
        [root, sibling, join(sibling, "child"), dottedSibling].sort(),
      );
      expect(fixture.events).toContainEqual({ type: "delete", path: child });
    } finally {
      await fixture.close();
      expect(fixture.watchers.size).toBe(0);
      await rm(root, { recursive: true, force: true });
    }
  },
);

class TestWatcher extends EventEmitter implements FSWatcher {
  constructor(private readonly onClose: () => void) {
    super();
  }
  close(): void {
    this.onClose();
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

function createWatchedBackend(root: string) {
  const paths = createObserverPaths(process.platform);
  const observer = createFileObserver();
  const watchers = new Map<string, TestWatcher>();
  const events: Array<{ type: FileChangeType; path: string }> = [];
  const counts = { ancestry: 0 };
  let active = true;
  const backend = createLinuxBackend(
    {
      root,
      metrics: observer.getDiagnostics(),
      isActive: () => active,
      isIgnored: () => false,
      isPathInside: (scope, path) => {
        counts.ancestry += 1;
        return paths.isInside(scope, path);
      },
      queueEvent: (type, path) => {
        events.push({ type, path });
      },
      fail: (error) => {
        throw error;
      },
    },
    paths,
    (directory, listener) => {
      const watcher = new TestWatcher(() => watchers.delete(directory));
      watcher.on("change", listener);
      watchers.set(directory, watcher);
      return watcher;
    },
  );
  return {
    backend,
    watchers,
    events,
    counts,
    async close() {
      active = false;
      await backend.close();
      await observer.close();
    },
  };
}

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
