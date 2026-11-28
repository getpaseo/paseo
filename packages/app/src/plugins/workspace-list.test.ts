import { describe, expect, it, vi } from "vitest";
import type { PluginWorkspaceGrouping } from "@getpaseo/plugin/client";
import { createPluginWorkspaceList, type PluginWorkspaceListSource } from "./workspace-list";

function source(initial: PluginWorkspaceGrouping = "project") {
  let grouping = initial;
  const listeners = new Set<(grouping: PluginWorkspaceGrouping) => void>();
  const api: PluginWorkspaceListSource = {
    getGrouping: () => grouping,
    setGrouping(next) {
      grouping = next;
      for (const listener of listeners) listener(next);
    },
    subscribeGrouping(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { api, listeners };
}

describe("plugin workspace list", () => {
  it("reads, changes, and observes this client's grouping", () => {
    const state = source();
    const lifetime = new AbortController();
    const workspaceList = createPluginWorkspaceList(state.api, lifetime.signal);
    const listener = vi.fn();
    const unsubscribe = workspaceList.subscribeGrouping(listener);

    expect(workspaceList.getGrouping()).toBe("project");
    workspaceList.setGrouping("status");
    expect(workspaceList.getGrouping()).toBe("status");
    expect(listener).toHaveBeenCalledWith("status");

    unsubscribe();
    workspaceList.setGrouping("project");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("validates writes and owns subscriptions for the plugin lifetime", () => {
    const state = source();
    const lifetime = new AbortController();
    const workspaceList = createPluginWorkspaceList(state.api, lifetime.signal);
    const listener = vi.fn();
    workspaceList.subscribeGrouping(listener);

    expect(() => workspaceList.setGrouping("label" as never)).toThrow(
      "Invalid workspace grouping: label",
    );
    expect(state.listeners.size).toBe(1);
    lifetime.abort();
    expect(state.listeners.size).toBe(0);
    expect(() => workspaceList.getGrouping()).toThrow("Plugin has stopped");
    expect(() => workspaceList.setGrouping("status")).toThrow("Plugin has stopped");
    expect(workspaceList.subscribeGrouping(listener)).toBeTypeOf("function");
  });
});
