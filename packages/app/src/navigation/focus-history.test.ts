import { describe, expect, it, vi } from "vitest";
import {
  createNavigationFocusHistory,
  type NavigationFocusLocation,
  type WorkspaceFocusLocation,
} from "./focus-history";

function workspace(
  workspaceId: string,
  tabId: string,
  panel: WorkspaceFocusLocation["view"]["panel"] = "agent",
): WorkspaceFocusLocation {
  return {
    kind: "workspace",
    serverId: "server-1",
    workspaceId,
    paneId: "pane-1",
    tabId,
    target: { kind: "agent", agentId: tabId },
    view: { panel, explorerTab: "changes" },
  };
}

describe("navigation focus history", () => {
  it("returns to tab focus in true recency order, including across workspaces", () => {
    const history = createNavigationFocusHistory();
    const firstAgent = workspace("workspace-a", "agent-a");
    const secondAgent = workspace("workspace-a", "agent-b");
    const otherWorkspace = workspace("workspace-b", "agent-c");

    history.record(firstAgent);
    history.record(secondAgent);
    history.record(otherWorkspace);

    expect(history.back()).toEqual(secondAgent);
    history.record(secondAgent);
    expect(history.back()).toEqual(firstAgent);
  });

  it("treats compact panel changes as focus locations", () => {
    const history = createNavigationFocusHistory();
    const content = workspace("workspace-a", "agent-a");
    const explorer = workspace("workspace-a", "agent-a", "file-explorer");

    history.record(content);
    history.record(explorer);

    expect(history.back()).toEqual(content);
  });

  it("deduplicates repeated observations of the same location", () => {
    const history = createNavigationFocusHistory();
    const listener = vi.fn();
    const location = workspace("workspace-a", "agent-a");
    history.subscribe(listener);

    history.record(location);
    history.record({ ...location });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(history.getSnapshot().canGoBack).toBe(false);
  });

  it("ignores intermediate observations while crossing workspace routes", () => {
    const history = createNavigationFocusHistory();
    const first = workspace("workspace-a", "agent-a");
    const second = workspace("workspace-b", "agent-b");
    const staleIntermediate = workspace("workspace-b", "agent-a", "file-explorer");

    history.record(first);
    history.record(second);
    expect(history.back()).toEqual(first);
    history.record(staleIntermediate);

    expect(history.getSnapshot().restoring).toBe(true);
    history.record(first);
    expect(history.getSnapshot()).toMatchObject({ current: first, restoring: false });
  });

  it("records app routes in the same recency stack", () => {
    const history = createNavigationFocusHistory();
    const workspaceLocation = workspace("workspace-a", "agent-a");
    const settings: NavigationFocusLocation = { kind: "route", pathname: "/settings/general" };

    history.record(workspaceLocation);
    history.record(settings);

    expect(history.back()).toEqual(workspaceLocation);
  });
});
