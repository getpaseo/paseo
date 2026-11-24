import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import type { FileChange } from "./index.js";
import { createNativeRecursiveBackend } from "./internal/native-recursive.js";
import { createObserverPaths } from "./internal/paths.js";

test("the recursive watcher remembers newly announced files before reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-observer-native-"));
  const paths = createObserverPaths(process.platform);
  const changes: FileChange[] = [];
  const firstChange = Promise.withResolvers<FileChange>();
  const notifications = new EventEmitter();
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
        const change = { type, path };
        changes.push(change);
        firstChange.resolve(change);
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
    const filename = "new.txt";
    const path = join(root, filename);
    await writeFile(path, "created");

    // Hold scheduled audits until classification has announced and tracked the file.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    notifications.emit("change", "rename", filename);
    expect(await firstChange.promise).toEqual({ type: "create", path });
    // Consumers have seen this file. A later audit needs it in its comparison
    // inventory even if the native watcher coalesces the subsequent delete.
    expect(backend.getDiagnostics().nativeTrackedFileCount).toBe(1);
    await rm(path);
    await backend.updateIgnore();
    expect(changes).toContainEqual({ type: "delete", path });
  } finally {
    active = false;
    await backend.close();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});
