import { describe, expect, it } from "vitest";
import { createWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { classifyLocation, type HistoryEntry } from "./model";
import { recordNavigationLocation } from "./recorder";
import { goHistory, type HistoryReplayDeps } from "./replay";
import { selectActiveWorkspaceTabId } from "./select-active-tab";
import { createNavigationHistoryStore } from "./store";

function createNavigation() {
  const layout = createWorkspaceLayoutStore(undefined, {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  const history = createNavigationHistoryStore();
  let pathname = "/";
  const observe = () => {
    const location = classifyLocation({ pathname, params: {} });
    if (!location) return;
    let entry: HistoryEntry = location;
    if (location.kind === "workspace") {
      const key = `${location.serverId}:${location.workspaceId}`;
      const tabId = selectActiveWorkspaceTabId(layout.getState(), key);
      const tab = layout
        .getState()
        .getWorkspaceTabs(key)
        .find((candidate) => candidate.tabId === tabId);
      entry = { ...location, tabId, target: tab?.target ?? null };
    }
    recordNavigationLocation(history, entry);
  };
  const navigate = (path: string) => {
    pathname = path;
    observe();
  };
  const deps: HistoryReplayDeps = {
    navigateToRoute: navigate,
    navigateToWorkspace: ({ serverId, workspaceId, target }) => {
      if (target)
        layout
          .getState()
          .openTab({ workspaceKey: `${serverId}:${workspaceId}`, target, intent: "reveal" });
      // Route observation follows synchronous replay changes, as it does in the React effect.
      pathname = `/h/${serverId}/workspace/${workspaceId}`;
    },
    focusTab: (key, tabId) => {
      layout.getState().focusTab(key, tabId);
    },
    workspaceExists: () => true,
    tabExists: (key, tabId) =>
      layout
        .getState()
        .getWorkspaceTabs(key)
        .some((tab) => tab.tabId === tabId),
    agentExists: () => true,
  };
  const step = (delta: 1 | -1) => {
    const result = goHistory(delta, history, deps);
    observe();
    return result;
  };
  return { layout, history, observe, navigate, step, pathname: () => pathname };
}

describe("recorded navigation replay", () => {
  it("preserves Forward after visiting a workspace before its layout exists", () => {
    const nav = createNavigation();
    nav.navigate("/settings/general");
    nav.navigate("/h/srv/workspace/first");
    nav.layout.getState().openTab({
      workspaceKey: "srv:first",
      target: { kind: "agent", agentId: "a1" },
      intent: "reveal",
    });
    nav.observe();
    nav.navigate("/sessions");
    const visited = nav.history.getState().entries;
    expect(nav.step(-1)).toBe(true);
    expect(nav.pathname()).toBe("/h/srv/workspace/first");
    expect(nav.step(-1)).toBe(true);
    expect(nav.pathname()).toBe("/settings/general");
    expect(nav.step(1)).toBe(true);
    expect(nav.pathname()).toBe("/h/srv/workspace/first");
    expect(nav.step(1)).toBe(true);
    expect(nav.pathname()).toBe("/sessions");
    expect(nav.history.getState()).toEqual({ entries: visited, index: 2 });
  });

  it("records a settled empty workspace and ignores composer focus changes", () => {
    const nav = createNavigation();
    nav.navigate("/welcome");
    const tabId = nav.layout
      .getState()
      .openTab({ workspaceKey: "srv:empty", target: { kind: "new_tab" }, intent: "new" });
    nav.navigate("/h/srv/workspace/empty");
    nav.layout.getState().unfocusPane("srv:empty");
    nav.observe();
    expect(nav.history.getState()).toEqual({
      entries: [
        {
          kind: "workspace",
          serverId: "srv",
          workspaceId: "empty",
          tabId,
          target: { kind: "new_tab" },
        },
      ],
      index: 0,
    });
  });

  it("keeps retargeted tabs replayable and reopens a closed file without losing Forward", () => {
    const nav = createNavigation();
    const key = "srv:first";
    const tabId = nav.layout
      .getState()
      .openTab({ workspaceKey: key, target: { kind: "file", path: "first.ts" }, intent: "new" })!;
    nav.navigate("/h/srv/workspace/first");
    nav.layout.getState().replaceTab(key, tabId, { kind: "file", path: "second.ts" });
    nav.observe();
    expect(nav.history.getState().entries).toEqual([
      {
        kind: "workspace",
        serverId: "srv",
        workspaceId: "first",
        tabId,
        target: { kind: "file", path: "second.ts" },
      },
    ]);
    nav.navigate("/sessions");
    nav.layout.getState().closeTab(key, tabId);
    expect(nav.step(-1)).toBe(true);
    expect(nav.pathname()).toBe("/h/srv/workspace/first");
    expect(nav.step(1)).toBe(true);
    expect(nav.pathname()).toBe("/sessions");
    expect(nav.history.getState().entries).toHaveLength(2);
  });
});
