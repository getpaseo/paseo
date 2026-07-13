import { beforeEach, describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import {
  createHistoryViewStore,
  DEFAULT_HISTORY_VIEW_STATE,
  migrateHistoryViewState,
} from "./history-view-store";

function createMemoryStorage(): StateStorage {
  const values = new Map<string, string>();
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
}

const store = createHistoryViewStore(createMemoryStorage());

describe("history view store", () => {
  beforeEach(() => {
    store.setState(DEFAULT_HISTORY_VIEW_STATE);
  });

  it("defaults to the current all-history recency view", () => {
    expect(migrateHistoryViewState(undefined)).toEqual({
      status: "all",
      projectFilters: [],
      hostFilters: [],
      lastActivity: "any",
      groupMode: "last_activity",
      sortMode: "recency",
    });
  });

  it("clears server filters without resetting grouping or sorting", () => {
    store.setState({
      status: "archived",
      projectFilters: ["project-a"],
      hostFilters: ["host-a"],
      lastActivity: "7d",
      groupMode: "project",
      sortMode: "alphabetical",
    });

    store.getState().clearFilters();

    expect(store.getState()).toMatchObject({
      status: "all",
      projectFilters: [],
      hostFilters: [],
      lastActivity: "any",
      groupMode: "project",
      sortMode: "alphabetical",
    });
  });

  it("supports multi-select host and project filters", () => {
    const actions = store.getState();
    actions.toggleHostFilter("host-a");
    actions.toggleHostFilter("host-b");
    actions.toggleProjectFilter("project-a");
    actions.toggleProjectFilter("project-b");
    actions.toggleHostFilter("host-a");

    expect(store.getState()).toMatchObject({
      hostFilters: ["host-b"],
      projectFilters: ["project-a", "project-b"],
    });
  });

  it("reconciles selections against available hosts and projects", () => {
    store.setState({
      hostFilters: ["host-a", "removed-host"],
      projectFilters: ["project-a", "removed-project"],
    });

    const actions = store.getState();
    actions.reconcileHostFilters(["host-a"]);
    actions.reconcileProjectFilters(["project-a"]);

    expect(store.getState()).toMatchObject({
      hostFilters: ["host-a"],
      projectFilters: ["project-a"],
    });
  });

  it("normalizes invalid persisted values and duplicate keys", () => {
    expect(
      migrateHistoryViewState({
        status: "invalid",
        projectFilters: [" project-a ", "project-a", null],
        hostFilters: ["host-a", ""],
        lastActivity: "invalid",
        groupMode: "project",
        sortMode: "created",
      }),
    ).toEqual({
      status: "all",
      projectFilters: ["project-a"],
      hostFilters: ["host-a"],
      lastActivity: "any",
      groupMode: "project",
      sortMode: "created",
    });
  });
});
