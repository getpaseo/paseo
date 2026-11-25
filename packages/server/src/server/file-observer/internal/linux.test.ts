import { EventEmitter } from "node:events";
import { renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
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
      isIgnoredRoot: () => false,
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
      isIgnoredRoot: (path) => ignoreGenerated && path === ignored,
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

test("scan yields to the event loop and aborts mid-directory when the observation closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "linux-scan-yield-"));
  const totalFiles = 700;
  await Promise.all(
    Array.from({ length: totalFiles }, (_, index) =>
      writeFile(join(root, `file-${index}.txt`), "x"),
    ),
  );
  const paths = createObserverPaths(process.platform);
  const observer = createFileObserver();
  let active = true;
  let inspected = 0;
  let yieldedBeforeFinish = false;
  let scheduledYieldProbe = false;
  const backend = createLinuxBackend(
    {
      root,
      metrics: observer.getDiagnostics(),
      isActive: () => active,
      isIgnored: () => false,
      isIgnoredRoot: () => {
        inspected += 1;
        if (!scheduledYieldProbe && inspected === 260) {
          scheduledYieldProbe = true;
          const until = performance.now() + 15;
          while (performance.now() < until) {
            // busy wait
          }
          setImmediate(() => {
            if (inspected < totalFiles) {
              yieldedBeforeFinish = true;
            }
            active = false;
          });
        }
        return false;
      },
      isPathInside: paths.isInside,
      queueEvent: () => {},
      fail: (error) => {
        throw error;
      },
    },
    paths,
    () => ({ close: () => {}, on: () => {} }) as never,
  );
  try {
    await backend.start();
    expect(yieldedBeforeFinish).toBe(true);
    expect(inspected).toBeLessThan(totalFiles);
  } finally {
    active = false;
    await backend.close();
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "a file written into a newly moved directory during a scan yield is not missed",
  async () => {
    const parent = await mkdtemp(join(tmpdir(), "linux-scan-watch-order-"));
    const root = join(parent, "root");
    const staged = join(parent, "staged");
    const moved = join(root, "moved");
    const lateFile = join(moved, "late.txt");
    await mkdir(root);
    await mkdir(staged);
    const totalFiles = 700;
    await Promise.all(
      Array.from({ length: totalFiles }, (_, index) =>
        writeFile(join(staged, `file-${index}.txt`), "x"),
      ),
    );

    const paths = createObserverPaths(process.platform);
    const observer = createFileObserver();
    let active = true;
    const delivered = new Set<string>();
    const movedPrefix = `${moved}${sep}`;
    let inspectedMoved = 0;
    let scheduledLateWrite = false;
    let wroteDuringYield = false;
    const backend = createLinuxBackend(
      {
        root,
        metrics: observer.getDiagnostics(),
        isActive: () => active,
        isIgnored: () => false,
        isIgnoredRoot: (path) => {
          if (path.startsWith(movedPrefix)) {
            inspectedMoved += 1;
            if (!scheduledLateWrite && inspectedMoved === 260) {
              scheduledLateWrite = true;
              const until = performance.now() + 15;
              while (performance.now() < until) {
                // Ensure the next stride boundary exceeds the 8 ms slice budget.
              }
              setImmediate(() => {
                if (inspectedMoved < totalFiles) {
                  wroteDuringYield = true;
                }
                writeFileSync(lateFile, "after-readdir");
              });
            }
          }
          return false;
        },
        isPathInside: paths.isInside,
        queueEvent: (_type, path) => {
          delivered.add(path);
        },
        fail: (error) => {
          throw error;
        },
      },
      paths,
    );

    try {
      await backend.start();
      await rename(staged, moved);
      await expect.poll(() => wroteDuringYield, { timeout: 5_000 }).toBe(true);
      await expect.poll(() => delivered.has(lateFile), { timeout: 2_000 }).toBe(true);
    } finally {
      active = false;
      await backend.close();
      await observer.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "replacing a newly moved directory during its first scan rebinds coverage to the replacement",
  async () => {
    const parent = await mkdtemp(join(tmpdir(), "linux-scan-replace-dir-"));
    const root = join(parent, "root");
    const first = join(parent, "first");
    const second = join(parent, "second");
    const aside = join(parent, "aside");
    const target = join(root, "target");
    await mkdir(root);
    await mkdir(first);
    await mkdir(second);
    const totalFiles = 700;
    await Promise.all(
      Array.from({ length: totalFiles }, (_, index) =>
        writeFile(join(first, `file-${index}.txt`), "x"),
      ),
    );
    await writeFile(join(second, "initial-replacement.txt"), "v1");

    const paths = createObserverPaths(process.platform);
    const observer = createFileObserver();
    let active = true;
    const delivered = new Set<string>();
    const targetPrefix = `${target}${sep}`;
    let inspectedTarget = 0;
    let scheduledSwap = false;
    let swappedDuringYield = false;
    const backend = createLinuxBackend(
      {
        root,
        metrics: observer.getDiagnostics(),
        isActive: () => active,
        isIgnored: () => false,
        isIgnoredRoot: (path) => {
          if (path.startsWith(targetPrefix)) {
            inspectedTarget += 1;
            if (!scheduledSwap && inspectedTarget === 260) {
              scheduledSwap = true;
              const until = performance.now() + 15;
              while (performance.now() < until) {
                // Ensure the next stride boundary exceeds the 8 ms slice budget.
              }
              setImmediate(() => {
                if (inspectedTarget < totalFiles) {
                  swappedDuringYield = true;
                }
                renameSync(target, aside);
                renameSync(second, target);
              });
            }
          }
          return false;
        },
        isPathInside: paths.isInside,
        queueEvent: (_type, path) => {
          delivered.add(path);
        },
        fail: (error) => {
          throw error;
        },
      },
      paths,
    );

    try {
      await backend.start();
      await rename(first, target);
      await expect.poll(() => swappedDuringYield, { timeout: 5_000 }).toBe(true);
      await expect
        .poll(() => backend.getDiagnostics().pendingReconciliationWorkCount, { timeout: 5_000 })
        .toBe(0);
      await expect
        .poll(() => delivered.has(join(target, "initial-replacement.txt")), { timeout: 2_000 })
        .toBe(true);

      const movedAwayEdit = join(aside, "from-moved-away.txt");
      const leakedMovedAwayPath = join(target, "from-moved-away.txt");
      const replacementEdit = join(target, "from-replacement.txt");
      await writeFile(movedAwayEdit, "old-inode");
      await writeFile(replacementEdit, "new-inode");

      await expect.poll(() => delivered.has(replacementEdit), { timeout: 2_000 }).toBe(true);
      expect(delivered.has(leakedMovedAwayPath)).toBe(false);
    } finally {
      active = false;
      await backend.close();
      await observer.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);
