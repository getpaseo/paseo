import { expect, test } from "vitest";
import { createCatalogRefresh } from "./catalog-refresh";

function world(pending = true) {
  const listeners = new Set<() => void>();
  const timers = new Set<() => void>();
  const refreshes: (string | undefined)[] = [];
  const refresh = createCatalogRefresh({
    catchUp: {
      isVisibleCatchUpPending: () => pending,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    refresh: (id) => {
      refreshes.push(id);
    },
    schedule(task, delayMs) {
      expect(delayMs).toBe(3_000);
      timers.add(task);
      return () => {
        timers.delete(task);
      };
    },
  });
  return {
    refresh,
    refreshes,
    listeners,
    timers,
    complete() {
      pending = false;
      for (const listener of listeners) listener();
    },
    timeout() {
      for (const timer of timers) timer();
    },
  };
}

test("initial snapshots wait for visible catch-up completion", () => {
  const w = world();
  w.refresh.snapshot();
  w.refresh.snapshot();
  expect(w.refreshes).toEqual([]);
  expect(w.timers.size).toBe(1);
  w.complete();
  expect(w.refreshes).toEqual([undefined]);
  expect(w.timers.size).toBe(0);
  expect(w.listeners.size).toBe(0);
});

test("initial snapshot waits at most three seconds", () => {
  const w = world();
  w.refresh.snapshot();
  w.timeout();
  w.complete();
  expect(w.refreshes).toEqual([undefined]);
});

test("snapshots fetch immediately when no visible timeline is catching up", () => {
  const w = world(false);
  w.refresh.snapshot();
  expect(w.refreshes).toEqual([undefined]);
  expect(w.timers.size).toBe(0);
});

test("plugin_catalog_changed refreshes immediately and cancels the deferred snapshot", () => {
  const w = world();
  w.refresh.snapshot();
  w.refresh.changed("changed-plugin");
  expect(w.refreshes).toEqual(["changed-plugin"]);
  w.complete();
  w.timeout();
  expect(w.refreshes).toEqual(["changed-plugin"]);
});

test("disconnect disposes the deferred snapshot", () => {
  const w = world();
  w.refresh.snapshot();
  w.refresh.dispose();
  w.complete();
  w.timeout();
  expect(w.refreshes).toEqual([]);
  expect(w.listeners.size).toBe(0);
});
