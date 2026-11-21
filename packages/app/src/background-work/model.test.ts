import { expect, test } from "vitest";
import { createBackgroundWorkModel } from "./model";

test("keeps a newer update when an earlier list resolves after it", async () => {
  let resolve!: (
    value: Array<{ id: string; kind: string; description: string | null; startedAt: string }>,
  ) => void;
  let update!: (
    items: Array<{ id: string; kind: string; description: string | null; startedAt: string }>,
  ) => void;
  let snapshot!: () => void;
  const model = createBackgroundWorkModel({
    list: () =>
      new Promise((done) => {
        resolve = done;
      }),
    observe: (callbacks) => {
      snapshot = callbacks.snapshot;
      update = callbacks.update;
      return () => {};
    },
  });
  const unsubscribe = model.subscribe(() => {});
  expect(model.getSnapshot().items).toBeNull();
  snapshot();
  const item = { id: "1", kind: "shell", description: "sleep", startedAt: "2026-01-01T00:00:00Z" };
  update([item]);
  resolve([]);
  await Promise.resolve();
  expect(model.getSnapshot().items).toEqual([item]);
  unsubscribe();
});

test("retains the last inventory while reconnecting and replaces it after resync", async () => {
  const item = { id: "1", kind: "shell", description: "sleep", startedAt: "2026-01-01T00:00:00Z" };
  const reads: Array<(value: (typeof item)[]) => void> = [];
  let snapshot!: () => void;
  const model = createBackgroundWorkModel({
    list: () => new Promise((resolve) => reads.push(resolve)),
    observe: (callbacks) => {
      snapshot = callbacks.snapshot;
      return () => {};
    },
  });
  const unsubscribe = model.subscribe(() => {});
  snapshot();
  reads[0]([item]);
  await Promise.resolve();
  snapshot();
  expect(model.getSnapshot().items).toEqual([item]);
  reads[1]([]);
  await Promise.resolve();
  expect(model.getSnapshot().items).toEqual([]);
  unsubscribe();
});

test("ignores a list response from a connection that was replaced", async () => {
  let snapshot!: () => void;
  let disconnected!: () => void;
  let resolve!: (
    items: Array<{ id: string; kind: string; description: string | null; startedAt: string }>,
  ) => void;
  const model = createBackgroundWorkModel({
    list: () =>
      new Promise((done) => {
        resolve = done;
      }),
    observe: (callbacks) => {
      snapshot = callbacks.snapshot;
      disconnected = callbacks.disconnected;
      return () => {};
    },
  });
  const unsubscribe = model.subscribe(() => {});
  snapshot();
  disconnected();
  resolve([{ id: "old", kind: "shell", description: null, startedAt: "2026-01-01T00:00:00Z" }]);
  await Promise.resolve();
  expect(model.getSnapshot().items).toBeNull();
  unsubscribe();
});

test("retains stale items on failure and retries the inventory", async () => {
  const item = { id: "1", kind: "shell", description: "sleep", startedAt: "2026-01-01T00:00:00Z" };
  let snapshot!: () => void;
  let resolve!: (items: (typeof item)[]) => void;
  let reject!: (error: Error) => void;
  const model = createBackgroundWorkModel({
    list: () =>
      new Promise((done, fail) => {
        resolve = done;
        reject = fail;
      }),
    observe: (callbacks) => {
      snapshot = callbacks.snapshot;
      return () => {};
    },
  });
  const unsubscribe = model.subscribe(() => {});
  snapshot();
  resolve([item]);
  await Promise.resolve();
  snapshot();
  expect(model.getSnapshot()).toEqual({ status: "stale", items: [item] });
  reject(new Error("offline"));
  await Promise.resolve();
  expect(model.getSnapshot()).toEqual({ status: "error", items: [item] });
  model.retry();
  expect(model.getSnapshot()).toEqual({ status: "stale", items: [item] });
  resolve([]);
  await Promise.resolve();
  expect(model.getSnapshot()).toEqual({ status: "ready", items: [] });
  unsubscribe();
});

test("reports an initial read failure without claiming an empty inventory", async () => {
  let snapshot!: () => void;
  const model = createBackgroundWorkModel({
    list: async () => {
      throw new Error("offline");
    },
    observe: (callbacks) => {
      snapshot = callbacks.snapshot;
      return () => {};
    },
  });
  const unsubscribe = model.subscribe(() => {});
  snapshot();
  await Promise.resolve();
  expect(model.getSnapshot()).toEqual({ status: "error", items: null });
  unsubscribe();
});

test("recreates a failed observation on retry and resumes live updates", async () => {
  const item = { id: "1", kind: "shell", description: "sleep", startedAt: "2026-01-01T00:00:00Z" };
  let observation!: Parameters<Parameters<typeof createBackgroundWorkModel>[0]["observe"]>[0];
  let starts = 0;
  let releases = 0;
  const model = createBackgroundWorkModel({
    list: async () => [item],
    observe: (callbacks) => {
      observation = callbacks;
      starts++;
      return () => {
        releases++;
      };
    },
  });
  const unsubscribe = model.subscribe(() => {});
  observation.failed();
  expect(model.getSnapshot()).toEqual({ status: "error", items: null });
  model.retry();
  expect(starts).toBe(2);
  expect(releases).toBe(1);
  observation.snapshot();
  await Promise.resolve();
  expect(model.getSnapshot()).toEqual({ status: "ready", items: [item] });
  observation.update([]);
  expect(model.getSnapshot()).toEqual({ status: "ready", items: [] });
  unsubscribe();
});

test("keeps a stop pending across a roster removal and exposes a failed outcome", async () => {
  const item = {
    id: "1",
    kind: "shell",
    description: "sleep",
    startedAt: "2026-01-01",
    canStop: true,
    stopToken: "generation-1",
  };
  let update!: (items: (typeof item)[]) => void;
  let reject!: (error: Error) => void;
  const model = createBackgroundWorkModel({
    list: async () => [item],
    stop: () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
    observe: (callbacks) => {
      update = callbacks.update;
      return () => {};
    },
  });
  const unsubscribe = model.subscribe(() => {});
  update([item]);
  const pending = model.stopItem(item);
  update([]);
  expect(model.getSnapshot().stops?.["generation-1"]).toEqual({ status: "pending", item });
  reject(new Error("connection lost"));
  await pending;
  expect(model.getSnapshot().stops?.["generation-1"]).toEqual({ status: "error", item });
  model.dismissStop("generation-1");
  expect(model.getSnapshot().stops).toEqual({});
  unsubscribe();
});

test("ignores a stop response from a disconnected generation", async () => {
  const first = {
    id: "1",
    kind: "shell",
    description: "old",
    startedAt: "2026-01-01",
    canStop: true,
    stopToken: "first",
  };
  const replacement = { ...first, description: "new", stopToken: "second" };
  let update!: (items: (typeof first)[]) => void;
  let disconnect!: () => void;
  let resolve!: () => void;
  const model = createBackgroundWorkModel({
    list: async () => [],
    stop: () =>
      new Promise((done) => {
        resolve = done;
      }),
    observe: (callbacks) => {
      update = callbacks.update;
      disconnect = callbacks.disconnected;
      return () => {};
    },
  });
  const unsubscribe = model.subscribe(() => {});
  update([first]);
  const pending = model.stopItem(first);
  disconnect();
  update([replacement]);
  resolve();
  await pending;
  expect(model.getSnapshot().items).toEqual([replacement]);
  expect(model.getSnapshot().stops?.first).toEqual({ status: "error", item: first });
  unsubscribe();
});
