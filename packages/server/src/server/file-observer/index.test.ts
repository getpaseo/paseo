import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { type FileChange, getFileObserverDiagnostics, subscribeToFileChanges } from "./index.js";

const roots = new Set<string>();

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

test("observes nested files while pruning excluded directories", async () => {
  const root = await createRoot();
  const ignored = join(root, "ignored");
  const observed = join(root, "nested");
  await mkdir(ignored);
  await mkdir(observed);
  const events: FileChange[] = [];
  const subscription = await subscribeToFileChanges(
    root,
    (error, batch) => {
      expect(error).toBeNull();
      events.push(...batch);
    },
    { ignore: [ignored] },
  );

  await writeFile(join(ignored, "ignored.txt"), "ignored");
  const observedPath = join(observed, "observed.txt");
  await writeFile(observedPath, "observed");

  await expect.poll(() => events.map((event) => event.path)).toContain(observedPath);
  expect(events.map((event) => event.path)).not.toContain(join(ignored, "ignored.txt"));
  await subscription.unsubscribe();
});

test("covers files populated immediately inside a newly created directory", async () => {
  const root = await createRoot();
  const events: FileChange[] = [];
  const subscription = await subscribeToFileChanges(root, (error, batch) => {
    expect(error).toBeNull();
    events.push(...batch);
  });

  const createdDirectory = join(root, "new", "nested");
  await mkdir(createdDirectory, { recursive: true });
  const firstPath = join(createdDirectory, "first.txt");
  await writeFile(firstPath, "first");
  await expect.poll(() => events.map((event) => event.path)).toContain(firstPath);

  const secondPath = join(createdDirectory, "second.txt");
  await writeFile(secondPath, "second");
  await expect.poll(() => events.map((event) => event.path)).toContain(secondPath);
  await subscription.unsubscribe();
});

test("re-admits an excluded directory without replacing the subscription", async () => {
  const root = await createRoot();
  const ignored = join(root, "ignored");
  await mkdir(ignored);
  const events: FileChange[] = [];
  const subscription = await subscribeToFileChanges(
    root,
    (error, batch) => {
      expect(error).toBeNull();
      events.push(...batch);
    },
    { ignore: [ignored] },
  );

  await subscription.updateIgnore([]);
  const observedPath = join(ignored, "observed.txt");
  await writeFile(observedPath, "observed");
  await expect.poll(() => events.map((event) => event.path)).toContain(observedPath);
  await subscription.unsubscribe();
});

test("an ignore update is a barrier for later delivery", async () => {
  const root = await createRoot();
  const ignored = join(root, "generated");
  await mkdir(ignored);
  const delivered: FileChange[] = [];
  const deliveredPaths = new Set<string>();
  const subscription = await subscribeToFileChanges(root, (error, events) => {
    expect(error).toBeNull();
    delivered.push(...events);
    for (const event of events) deliveredPaths.add(event.path);
  });

  await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      writeFile(join(ignored, `before-${index}.txt`), `${index}`),
    ),
  );
  const outsidePaths = Array.from({ length: 1_000 }, (_, index) =>
    join(root, `outside-${index}.txt`),
  );
  await Promise.all([
    Promise.all(outsidePaths.map((path, index) => writeFile(path, `${index}`))),
    subscription.updateIgnore([ignored]),
  ]);
  await expect
    .poll(() => outsidePaths.filter((path) => !deliveredPaths.has(path)), { timeout: 10_000 })
    .toEqual([]);
  const deliveredAtBarrier = delivered.length;
  await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      writeFile(join(ignored, `after-${index}.txt`), `${index}`),
    ),
  );
  const sentinel = join(root, "still-observed.txt");
  await writeFile(sentinel, "observed");
  await expect.poll(() => deliveredPaths.has(sentinel)).toBe(true);

  expect(
    delivered
      .slice(deliveredAtBarrier)
      .filter((event) => event.path === ignored || event.path.startsWith(`${ignored}${sep}`)),
  ).toEqual([]);
  await subscription.unsubscribe();
}, 20_000);

test("survives atomic replacement and remains observable", async () => {
  const root = await createRoot();
  const target = join(root, "target.txt");
  await writeFile(target, "before");
  const events: FileChange[] = [];
  const subscription = await subscribeToFileChanges(root, (error, batch) => {
    expect(error).toBeNull();
    events.push(...batch);
  });

  const replacement = join(root, "replacement.txt");
  await writeFile(replacement, "after");
  await rename(replacement, target);
  await expect.poll(() => events.map((event) => event.path)).toContain(target);

  events.length = 0;
  await writeFile(target, "again");
  await expect.poll(() => events.map((event) => event.path)).toContain(target);
  await subscription.unsubscribe();
});

test("classifies a removed file as deleted", async () => {
  const root = await createRoot();
  const target = join(root, "removed.txt");
  await writeFile(target, "before");
  const events: FileChange[] = [];
  const subscription = await subscribeToFileChanges(root, (error, batch) => {
    expect(error).toBeNull();
    events.push(...batch);
  });

  await rm(target);
  await expect.poll(() => events.find((event) => event.path === target)?.type).toBe("delete");
  await subscription.unsubscribe();
});

test("observes files moved into the tree with their directory", async () => {
  const root = await createRoot();
  const outside = await createRoot();
  const movedFrom = join(outside, "prepared");
  await mkdir(movedFrom);
  const movedFile = join(movedFrom, "already-written.txt");
  await writeFile(movedFile, "ready");
  const events: FileChange[] = [];
  const subscription = await subscribeToFileChanges(root, (error, batch) => {
    expect(error).toBeNull();
    events.push(...batch);
  });

  const movedTo = join(root, "prepared");
  await rename(movedFrom, movedTo);
  await expect
    .poll(() =>
      events.some(
        (event) => event.path === movedTo || event.path === join(movedTo, "already-written.txt"),
      ),
    )
    .toBe(true);
  await subscription.unsubscribe();
});

test("delivers no callbacks after unsubscribe resolves", async () => {
  const root = await createRoot();
  const callback = vi.fn();
  const subscription = await subscribeToFileChanges(root, callback);
  await subscription.unsubscribe();
  await writeFile(join(root, "after-close.txt"), "closed");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(callback).not.toHaveBeenCalled();
});

test("deleting a watched root cannot wedge idempotent unsubscription", async () => {
  const root = await createRoot();
  const subscription = await subscribeToFileChanges(root, () => undefined);
  await rm(root, { recursive: true, force: true });
  await expect(subscription.unsubscribe()).resolves.toBeUndefined();
  await expect(subscription.unsubscribe()).resolves.toBeUndefined();
});

test("observes a thousand concurrent writes and remains healthy after delete and rename churn", async () => {
  const root = await createRoot();
  const directories = Array.from({ length: 20 }, (_, index) => join(root, `dir-${index}`));
  await Promise.all(directories.map((directory) => mkdir(directory)));
  const observed = new Map<string, Set<FileChange["type"]>>();
  const subscription = await subscribeToFileChanges(root, (error, events) => {
    expect(error).toBeNull();
    for (const event of events) {
      const types = observed.get(event.path) ?? new Set();
      types.add(event.type);
      observed.set(event.path, types);
    }
  });
  const paths = Array.from({ length: 1_000 }, (_, index) =>
    join(directories[index % directories.length], `file-${index}.txt`),
  );

  await Promise.all(paths.map((path, index) => writeFile(path, `${index}`)));
  await expect
    .poll(() => paths.filter((path) => !observed.has(path)), { timeout: 10_000 })
    .toEqual([]);

  const removedPaths = paths.slice(0, 100);
  await Promise.all(removedPaths.map((path) => rm(path)));
  await expect
    .poll(() => removedPaths.filter((path) => !observed.get(path)?.has("delete")), {
      timeout: 10_000,
    })
    .toEqual([]);

  for (let index = 0; index < 10; index += 1) {
    const from = directories[index];
    const to = join(root, `renamed-${index}`);
    await rename(from, to);
    await rm(to, { recursive: true, force: true });
  }
  const sentinel = join(directories[15], "still-observed.txt");
  await writeFile(sentinel, "alive");
  await expect.poll(() => observed.has(sentinel)).toBe(true);
  await subscription.unsubscribe();
}, 30_000);

test("unsubscribe cancels reconciliation queued by a write burst", async () => {
  const root = await createRoot();
  const callback = vi.fn();
  const subscription = await subscribeToFileChanges(root, callback);
  await Promise.all(
    Array.from({ length: 1_000 }, (_, index) =>
      writeFile(join(root, `closing-${index}.txt`), `${index}`),
    ),
  );

  await expect(subscription.unsubscribe()).resolves.toBeUndefined();
  const callsAtClose = callback.mock.calls.length;
  await writeFile(join(root, "after-burst-close.txt"), "closed");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(callback).toHaveBeenCalledTimes(callsAtClose);
}, 20_000);

test("aggregate diagnostics return to their lifecycle baseline", async () => {
  const root = await createRoot();
  const baseline = getFileObserverDiagnostics();
  const subscription = await subscribeToFileChanges(root, () => undefined);

  expect(getFileObserverDiagnostics()).toMatchObject({
    activeObservationCount: baseline.activeObservationCount + 1,
  });
  expect(getFileObserverDiagnostics().nativeHandleCount).toBeGreaterThan(
    baseline.nativeHandleCount,
  );

  await subscription.unsubscribe();
  expect(getFileObserverDiagnostics()).toMatchObject({
    activeObservationCount: baseline.activeObservationCount,
    nativeHandleCount: baseline.nativeHandleCount,
    nativeTrackedFileCount: baseline.nativeTrackedFileCount,
    pendingEventCount: baseline.pendingEventCount,
    reconciliationInFlightCount: baseline.reconciliationInFlightCount,
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "paseo-file-observer-"));
  roots.add(root);
  return root;
}
