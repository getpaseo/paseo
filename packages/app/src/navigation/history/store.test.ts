import { describe, expect, it, vi } from "vitest";
import { createNavigationHistoryStore } from "./store";
import type { HistoryEntry } from "./model";

const ws = (workspaceId: string, tabId: string | null = null): HistoryEntry => ({
  kind: "workspace",
  serverId: "srv",
  workspaceId,
  tabId,
  target: null,
});

describe("navigation history store", () => {
  it("starts empty", () => {
    const store = createNavigationHistoryStore();
    expect(store.getState()).toEqual({ entries: [], index: -1 });
  });

  it("records entries and notifies subscribers", () => {
    const store = createNavigationHistoryStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.record(ws("a"));
    store.record(ws("b"));

    expect(store.getState().entries).toEqual([ws("a"), ws("b")]);
    expect(store.getState().index).toBe(1);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not notify when recording the current entry again", () => {
    const store = createNavigationHistoryStore();
    store.record(ws("a"));
    const listener = vi.fn();
    store.subscribe(listener);

    store.record(ws("a"));

    expect(listener).not.toHaveBeenCalled();
  });

  it("moves the index only within bounds", () => {
    const store = createNavigationHistoryStore();
    store.record(ws("a"));
    store.record(ws("b"));

    store.setIndex(0);
    expect(store.getState().index).toBe(0);
    store.setIndex(5);
    expect(store.getState().index).toBe(0);
    store.setIndex(-1);
    expect(store.getState().index).toBe(0);
  });

  it("replaces the current entry in place", () => {
    const store = createNavigationHistoryStore();
    store.record(ws("a"));
    store.record(ws("b", "old"));
    store.setIndex(1);

    store.replaceCurrent(ws("b", "new"));

    expect(store.getState().entries[1]).toEqual(ws("b", "new"));
    expect(store.getState().index).toBe(1);
  });

  it("unsubscribes listeners", () => {
    const store = createNavigationHistoryStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();

    store.record(ws("a"));

    expect(listener).not.toHaveBeenCalled();
  });
});
