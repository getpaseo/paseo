import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createFileObserver, type FileChange } from "../index.js";
import { createNativeRecursiveBackend } from "./native-recursive.js";
import { createObserverPaths } from "./paths.js";

// Native watchers may coalesce file removals into change notifications. Keep the
// filesystem real while controlling which notifications reach reconciliation.
test("shallow parent scans retain nested change scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-scopes-"));
  const paths = createObserverPaths(process.platform);
  const removed = [
    join(root, "root.txt"),
    join(root, "child", "child.txt"),
    join(root, "child", "deep", "deep.txt"),
  ];
  await mkdir(join(root, "child", "deep"), { recursive: true });
  await Promise.all(removed.map((path) => writeFile(path, "before")));
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
});

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
