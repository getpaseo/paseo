import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import type { FileChange } from "./index.js";
import { createNativeRecursiveBackend } from "./internal/native-recursive.js";
import { createObserverPaths } from "./internal/paths.js";

test("the recursive watcher remembers newly announced files before reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-observer-native-"));
  const paths = createObserverPaths(process.platform);
  const changes: FileChange[] = [];
  let active = true;
  const backend = createNativeRecursiveBackend(
    {
      root,
      metrics: {
        reconciliationCount: 0,
        scopedReconciliationCount: 0,
        fullReconciliationCount: 0,
        reconciliationFailureCount: 0,
        observerFailureCount: 0,
        directoryLimitFailureCount: 0,
        nativeEventCount: 0,
        nativeChangeEventCount: 0,
        nativeRenameEventCount: 0,
        nativePathlessEventCount: 0,
        nativeClassificationCount: 0,
        nativeShallowScanCount: 0,
        lastReconciliationDurationMs: 0,
        maxReconciliationDurationMs: 0,
      },
      isActive: () => active,
      isIgnored: () => false,
      isPathInside: paths.isInside,
      queueEvent: (type, path) => {
        changes.push({ type, path });
      },
      fail: (error) => {
        throw error;
      },
    },
    paths,
  );
  try {
    await backend.start();
    const path = join(root, "new.txt");
    await writeFile(path, "created");
    await expect
      .poll(() => changes.some((event) => event.path === path && event.type === "create"))
      .toBe(true);
    // Consumers have seen this file. A later audit needs it in its comparison
    // inventory even if the native watcher coalesces the subsequent delete.
    expect(backend.getDiagnostics().nativeTrackedFileCount).toBe(1);
    await rm(path);
    await backend.updateIgnore();
    await expect
      .poll(() => changes.some((event) => event.path === path && event.type === "delete"))
      .toBe(true);
  } finally {
    active = false;
    await backend.close();
    await rm(root, { recursive: true, force: true });
  }
});
