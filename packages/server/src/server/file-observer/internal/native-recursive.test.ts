import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createFileObserver, type FileChange } from "../index.js";
import { createNativeRecursiveBackend } from "./native-recursive.js";
import { createObserverPaths } from "./paths.js";

// Native watchers may coalesce file removals into change notifications. Keep the
// filesystem real while controlling which notifications reach reconciliation.
test.each(["existing", "new"])(
  "shallow scans recover coalesced deletes of %s files in nested scopes",
  async (population) => {
    const root = await mkdtemp(join(tmpdir(), "native-scopes-"));
    const paths = createObserverPaths(process.platform);
    const removed = [
      join(root, "root.txt"),
      join(root, "child", "child.txt"),
      join(root, "child", "deep", "deep.txt"),
    ];
    await mkdir(join(root, "child", "deep"), { recursive: true });
    if (population === "existing") {
      await Promise.all(removed.map((path) => writeFile(path, "before")));
    }
    const events: FileChange[] = [];
    const notifications = new EventEmitter();
    let active = true;
    const observer = createFileObserver();
    const backend = createNativeRecursiveBackend(
      {
        root,
        metrics: observer.getDiagnostics(),
        isActive: () => active,
        isIgnored: () => false,
        isPathInside: paths.isInside,
        queueEvent: (type, path) => events.push({ type, path }),
        fail: (error) => {
          throw error;
        },
      },
      paths,
      (_root, listener) => {
        notifications.on("change", listener);
        return {
          close: () => {
            notifications.removeAllListeners();
          },
          on: (event, onError) => notifications.on(event, onError),
        };
      },
    );
    try {
      await backend.start();
      if (population === "new") {
        await Promise.all(removed.map((path) => writeFile(path, "before")));
        for (const path of removed) notifications.emit("change", "change", path);
      }
      await Promise.all(removed.map((path) => rm(path)));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      for (const path of removed) notifications.emit("change", "change", path);
      await vi.advanceTimersByTimeAsync(8_000);
      vi.useRealTimers();
      await expect
        .poll(() =>
          events
            .filter((event) => event.type === "delete")
            .map((event) => event.path)
            .sort(),
        )
        .toEqual([...removed].sort());
    } finally {
      vi.useRealTimers();
      active = false;
      await backend.close();
      await observer.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a file announced only as changed remains visible to coalesced deletion scans", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-change-only-"));
  const directory = join(root, "nested");
  await mkdir(directory);
  const paths = createObserverPaths(process.platform);
  const events: FileChange[] = [];
  const notifications = new EventEmitter();
  let active = true;
  const observer = createFileObserver();
  const backend = createNativeRecursiveBackend(
    {
      root,
      metrics: observer.getDiagnostics(),
      isActive: () => active,
      isIgnored: () => false,
      isPathInside: paths.isInside,
      queueEvent: (type, path) => events.push({ type, path }),
      fail: (error) => {
        throw error;
      },
    },
    paths,
    (_root, listener) => {
      notifications.on("change", listener);
      return {
        close: () => notifications.removeAllListeners(),
        on: (event, onError) => notifications.on(event, onError),
      };
    },
  );
  try {
    await backend.start();
    const path = join(directory, "changed.txt");
    await writeFile(path, "created");
    notifications.emit("change", "change", path);
    await expect.poll(() => backend.getDiagnostics().nativeTrackedFileCount).toBe(1);

    await rm(path);
    notifications.emit("change", "change", directory);
    await expect
      .poll(() => events.filter((event) => event.type === "delete"), { timeout: 10_000 })
      .toEqual([{ path, type: "delete" }]);
  } finally {
    vi.useRealTimers();
    active = false;
    await backend.close();
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a native ignore update drains classifications queued below the new excluded root", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-ignore-queue-"));
  const ignored = join(root, "generated");
  await mkdir(ignored);
  const tracked = join(root, "tracked.txt");
  await writeFile(tracked, "tracked");
  const paths = createObserverPaths(process.platform);
  const notifications = new EventEmitter();
  const observer = createFileObserver();
  let active = true;
  let ignoreGenerated = false;
  const delivered: string[] = [];
  const backend = createNativeRecursiveBackend(
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
    (_root, listener) => {
      notifications.on("change", listener);
      return {
        close: () => notifications.removeAllListeners(),
        on: (event, onError) => notifications.on(event, onError),
      };
    },
  );
  try {
    await backend.start();
    for (let index = 0; index < 2_000; index += 1) {
      notifications.emit("change", "rename", join(ignored, `file-${index}.js`));
    }
    notifications.emit("change", "rename", tracked);
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

// One fs.stat per native event is how a single dependency install pins the
// libuv threadpool and the daemon stops answering.
test("a rename burst does not spawn one stat per event", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-classify-"));
  const paths = createObserverPaths(process.platform);
  const notifications = new EventEmitter();
  const observer = createFileObserver();
  let active = true;
  const backend = createNativeRecursiveBackend(
    {
      root,
      metrics: observer.getDiagnostics(),
      isActive: () => active,
      isIgnored: () => false,
      isPathInside: paths.isInside,
      queueEvent: () => {},
      fail: () => {},
    },
    paths,
    (_root, listener) => {
      notifications.on("change", listener);
      return {
        close: () => notifications.removeAllListeners(),
        on: (event, onError) => notifications.on(event, onError),
      };
    },
  );
  try {
    await backend.start();
    // Emitted synchronously: no stat can settle before the last event lands.
    for (let index = 0; index < 5_000; index += 1) {
      notifications.emit("change", "rename", join(root, `package-${index}`, "index.js"));
    }
    expect(backend.getDiagnostics().pendingClassificationCount).toBeLessThanOrEqual(2_080);
  } finally {
    active = false;
    await backend.close();
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
});

// The shed path is only safe because this backend has a real files/entries
// inventory to diff against. Prove it does the work: force a shed onto an
// already-tracked directory and confirm the create still surfaces.
test("a classification shed onto the scoped audit still recovers the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-shed-"));
  const paths = createObserverPaths(process.platform);
  const shedDirectory = join(root, "shed");
  await mkdir(shedDirectory);
  const events: FileChange[] = [];
  const notifications = new EventEmitter();
  const observer = createFileObserver();
  let active = true;
  const backend = createNativeRecursiveBackend(
    {
      root,
      metrics: observer.getDiagnostics(),
      isActive: () => active,
      isIgnored: () => false,
      isPathInside: paths.isInside,
      queueEvent: (type, path) => events.push({ type, path }),
      fail: (error) => {
        throw error;
      },
    },
    paths,
    (_root, listener) => {
      notifications.on("change", listener);
      return {
        close: () => notifications.removeAllListeners(),
        on: (event, onError) => notifications.on(event, onError),
      };
    },
  );
  try {
    await backend.start(); // The initial full audit tracks "shed" as known.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });

    // Jam the queue exactly as in the burst test above: 32 in flight, 2,048
    // queued, all against a directory that never existed.
    const fillerDirectory = join(root, "filler");
    for (let index = 0; index < 2_048 + 32; index += 1) {
      notifications.emit("change", "rename", join(fillerDirectory, `file-${index}.js`));
    }
    expect(backend.getDiagnostics().pendingClassificationCount).toBe(2_080);

    // A real file lands in the already-tracked "shed" directory while the
    // queue is full, so this event must be shed rather than stat-ed. Written
    // synchronously so no queued stat can settle and free a slot before this
    // event is classified -- that would let it enqueue normally instead of
    // exercising the shed branch.
    const shedPath = join(shedDirectory, "recovered.txt");
    writeFileSync(shedPath, "content");
    notifications.emit("change", "rename", shedPath);

    // 2s clears the mandatory-audit deadline (500ms quiet / 5s max-dirty)
    // that the shed forces by adding "shed" to localScopes, but stays well
    // under the optional-only deadline (8s) that the ambient per-event
    // change-scope audit alone would use. Every event -- shed or not --
    // already schedules that ambient audit, so advancing 8s would recover
    // this file even if the shed branch were a no-op. The short window is
    // what actually proves the shed's own requestAudit call did the work.
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();

    await expect
      .poll(() => events.some((event) => event.type === "create" && event.path === shedPath))
      .toBe(true);
  } finally {
    vi.useRealTimers();
    active = false;
    await backend.close();
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
});

// C1 regression: removeSubtree unlinks its root from the parent's
// DirectoryEntry as part of tearing down the old subtree. reconcileSubtree
// re-populates the index below `directory` via mergeInventory but must also
// re-link `directory` itself back into its parent -- walkSubtree only
// descends through that link, so without the re-link a later ancestor
// removal can no longer reach anything below the reconciled directory.
test("a recursive-scope reconcile re-links its directory so an ancestor removal still finds nested files", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-relink-"));
  const paths = createObserverPaths(process.platform);
  const deepDirectory = join(root, "a", "b", "c");
  const deepFile = join(deepDirectory, "deep.txt");
  await mkdir(deepDirectory, { recursive: true });
  await writeFile(deepFile, "content");
  const events: FileChange[] = [];
  const notifications = new EventEmitter();
  const observer = createFileObserver();
  let active = true;
  const backend = createNativeRecursiveBackend(
    {
      root,
      metrics: observer.getDiagnostics(),
      isActive: () => active,
      isIgnored: () => false,
      isPathInside: paths.isInside,
      queueEvent: (type, path) => events.push({ type, path }),
      fail: (error) => {
        throw error;
      },
    },
    paths,
    (_root, listener) => {
      notifications.on("change", listener);
      return {
        close: () => notifications.removeAllListeners(),
        on: (event, onError) => notifications.on(event, onError),
      };
    },
  );
  const settled = () =>
    expect
      .poll(
        () => {
          const diagnostics = backend.getDiagnostics();
          return (
            diagnostics.pendingReconciliationWorkCount === 0 && !diagnostics.reconciliationInFlight
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  try {
    await backend.start(); // Tracks a, a/b, a/b/c, and deep.txt.

    // A rename event landing on the already-known directory a/b produces a
    // local scope on its parent "a" (rebuilding a's DirectoryEntry from a
    // fresh shallow scan) and, once classify()'s real stat() confirms a/b is
    // still a directory, a recursive scope on a/b itself -- the same "known
    // directory changes in place" shape the directory-churn benchmark
    // exercises via atomic replace.
    notifications.emit("change", "rename", join(root, "a", "b"));
    await settled();

    // Remove the ancestor while the native event names only a deleted file.
    // The scoped scan must report its missing directory as well as that file.
    await rm(join(root, "a"), { recursive: true, force: true });
    notifications.emit("change", "rename", deepFile);
    await settled();

    expect(events.filter((event) => event.type === "delete").map((event) => event.path)).toContain(
      deepFile,
    );
    expect(events).toContainEqual({ type: "delete", path: deepDirectory });
  } finally {
    active = false;
    await backend.close();
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("a full native inventory audit reports a removed directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-full-audit-"));
  const directory = join(root, "removed");
  await mkdir(directory);
  await writeFile(join(directory, "tracked.txt"), "before");
  const paths = createObserverPaths(process.platform);
  const events: FileChange[] = [];
  const observer = createFileObserver();
  const backend = createNativeRecursiveBackend(
    {
      root,
      metrics: observer.getDiagnostics(),
      isActive: () => true,
      isIgnored: () => false,
      isPathInside: paths.isInside,
      queueEvent: (type, path) => events.push({ type, path }),
      fail: (error) => {
        throw error;
      },
    },
    paths,
    () => ({ close: () => {}, on: () => {} }),
  );
  try {
    await backend.start();
    await rm(directory, { recursive: true, force: true });
    await backend.updateIgnore(); // Uses the same full inventory diff as the safety audit.
    expect(events).toContainEqual({ type: "delete", path: directory });
  } finally {
    await backend.close();
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
});

// I2 regression: startClassification queues an unconditional "create" event
// before onPresent runs. When a file's parent directory has no entries
// bucket yet (a coalesced directory-creation event that never arrived),
// declining to track the path at all announces a create it can never
// retract -- no future scan can rediscover a path that is already gone from
// disk to emit its matching delete.
test("a file classified with no parent bucket yet still gets its delete emitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-orphan-"));
  const paths = createObserverPaths(process.platform);
  const newDirectory = join(root, "newdir");
  const events: FileChange[] = [];
  const notifications = new EventEmitter();
  const observer = createFileObserver();
  let active = true;
  const backend = createNativeRecursiveBackend(
    {
      root,
      metrics: observer.getDiagnostics(),
      isActive: () => active,
      isIgnored: () => false,
      isPathInside: paths.isInside,
      queueEvent: (type, path) => events.push({ type, path }),
      fail: (error) => {
        throw error;
      },
    },
    paths,
    (_root, listener) => {
      notifications.on("change", listener);
      return {
        close: () => notifications.removeAllListeners(),
        on: (event, onError) => notifications.on(event, onError),
      };
    },
  );
  try {
    await backend.start(); // Tracks the (empty) root only.

    // A brand-new directory with no directory-created event processed for
    // it yet (coalesced away) has no entries bucket: entries.get(scope) is
    // undefined for a file inside it.
    await mkdir(newDirectory);
    const filePath = join(newDirectory, "orphan.txt");
    await writeFile(filePath, "content");
    notifications.emit("change", "rename", filePath);

    // The file must stay tracked so a later removal can still find and
    // retract the create that startClassification already queued.
    await expect.poll(() => backend.getDiagnostics().nativeTrackedFileCount).toBe(1);
    expect(events.some((event) => event.type === "create" && event.path === filePath)).toBe(true);

    // Remove the whole directory before any audit ever scans it. Nothing
    // will see filePath as "on disk and gone from a known listing" through
    // the normal directory-scan diff, since newdir never had one.
    await rm(newDirectory, { recursive: true, force: true });

    await expect
      .poll(() => events.some((event) => event.type === "delete" && event.path === filePath), {
        timeout: 10_000,
      })
      .toBe(true);
    expect(backend.getDiagnostics().nativeTrackedFileCount).toBe(0);
  } finally {
    active = false;
    await backend.close();
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
});
