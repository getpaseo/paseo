import { describe, expect, it } from "vitest";
import {
  classifyLocation,
  EMPTY_HISTORY_STATE,
  entriesEqual,
  HISTORY_ENTRY_CAP,
  isTransientPathname,
  pushEntry,
  replaceEntryAt,
  resolveWorkspaceReplay,
  stepIndex,
  type HistoryEntry,
  type HistoryState,
} from "./model";

type WorkspaceTarget = Extract<HistoryEntry, { kind: "workspace" }>["target"];

function workspace(
  workspaceId: string,
  tabId: string | null = null,
  target: WorkspaceTarget = null,
): HistoryEntry {
  return { kind: "workspace", serverId: "srv", workspaceId, tabId, target };
}

function route(path: string): HistoryEntry {
  return { kind: "route", path };
}

function stateOf(entries: HistoryEntry[], index = entries.length - 1): HistoryState {
  return { entries, index };
}

describe("entriesEqual", () => {
  it("compares workspace entries by workspace and tab only", () => {
    expect(
      entriesEqual(workspace("ws", "t1", { kind: "files" }), workspace("ws", "t1", null)),
    ).toBe(true);
    expect(entriesEqual(workspace("ws", "t1"), workspace("ws", "t2"))).toBe(false);
    expect(entriesEqual(workspace("ws", "t1"), workspace("other", "t1"))).toBe(false);
  });

  it("compares route entries by path and never across kinds", () => {
    expect(entriesEqual(route("/settings/general"), route("/settings/general"))).toBe(true);
    expect(entriesEqual(route("/settings/general"), route("/sessions"))).toBe(false);
    expect(entriesEqual(route("/sessions"), workspace("ws"))).toBe(false);
  });
});

describe("pushEntry", () => {
  it("appends and advances the index", () => {
    const state = pushEntry(EMPTY_HISTORY_STATE, workspace("a"));
    expect(state).toEqual(stateOf([workspace("a")]));
  });

  it("is a no-op when the entry equals the current one", () => {
    const state = stateOf([workspace("a", "t1")]);
    expect(pushEntry(state, workspace("a", "t1", { kind: "files" }))).toBe(state);
  });

  it("drops the forward branch when pushing after going back", () => {
    const state = stateOf([workspace("a"), workspace("b"), workspace("c")], 0);
    expect(pushEntry(state, route("/sessions"))).toEqual(
      stateOf([workspace("a"), route("/sessions")]),
    );
  });

  it("caps the stack by dropping the oldest entries and shifting the index", () => {
    let state = EMPTY_HISTORY_STATE;
    for (let i = 0; i < HISTORY_ENTRY_CAP + 5; i += 1) {
      state = pushEntry(state, workspace(`ws-${i}`));
    }
    expect(state.entries).toHaveLength(HISTORY_ENTRY_CAP);
    expect(state.entries[0]).toEqual(workspace("ws-5"));
    expect(state.index).toBe(HISTORY_ENTRY_CAP - 1);
  });
});

describe("replaceEntryAt", () => {
  it("swaps an entry without moving the index", () => {
    const state = stateOf([workspace("a"), workspace("b")], 0);
    const next = replaceEntryAt(state, 1, workspace("b", "t9"));
    expect(next.entries[1]).toEqual(workspace("b", "t9"));
    expect(next.index).toBe(0);
  });

  it("ignores out-of-range indices", () => {
    const state = stateOf([workspace("a")]);
    expect(replaceEntryAt(state, 3, workspace("z"))).toBe(state);
  });
});

describe("stepIndex", () => {
  const entries = [workspace("a"), workspace("b"), workspace("c"), workspace("d")];
  const alive = () => true;

  it("moves one step in either direction", () => {
    expect(stepIndex(stateOf(entries, 2), -1, alive)).toBe(1);
    expect(stepIndex(stateOf(entries, 2), 1, alive)).toBe(3);
  });

  it("returns null at the ends", () => {
    expect(stepIndex(stateOf(entries, 0), -1, alive)).toBeNull();
    expect(stepIndex(stateOf(entries, 3), 1, alive)).toBeNull();
    expect(stepIndex(EMPTY_HISTORY_STATE, -1, alive)).toBeNull();
  });

  it("skips dead entries in both directions", () => {
    const isAlive = (entry: HistoryEntry) =>
      entry.kind === "workspace" && entry.workspaceId !== "b" && entry.workspaceId !== "c";
    expect(stepIndex(stateOf(entries, 3), -1, isAlive)).toBe(0);
    expect(stepIndex(stateOf(entries, 0), 1, isAlive)).toBe(3);
  });

  it("returns null when every remaining entry is dead", () => {
    expect(stepIndex(stateOf(entries, 3), -1, () => false)).toBeNull();
  });
});

describe("isTransientPathname", () => {
  it.each([
    "/",
    "",
    "/welcome",
    "/pair-scan",
    "/settings",
    "/settings/",
    "/settings/hosts/srv",
    "/h/srv",
    "/h/srv/",
    "/h/srv/agent/agent-1",
    "/h/srv/sessions",
    "/h/srv/settings",
    "/h/srv/open-project",
    "/h/srv/plugin/plug/surface",
    "/welcome?x=1",
  ])("treats %s as transient", (pathname) => {
    expect(isTransientPathname(pathname)).toBe(true);
  });

  it.each([
    "/settings/general",
    "/settings/hosts/srv/connections",
    "/settings/hosts/srv/projects/proj-1",
    "/sessions",
    "/schedules",
    "/new",
    "/open-project",
    "/h/srv/plugin/plug/sidebar/surface",
    "/h/srv/plugin/plug/surface/contribution",
  ])("treats %s as a resting route", (pathname) => {
    expect(isTransientPathname(pathname)).toBe(false);
  });
});

describe("classifyLocation", () => {
  it("returns a tab-less workspace entry for a workspace route", () => {
    expect(classifyLocation({ pathname: "/h/srv/workspace/ws-1", params: {} })).toEqual(
      workspace("ws-1"),
    );
  });

  it("falls back to route params on cold mount at /", () => {
    expect(
      classifyLocation({ pathname: "/", params: { serverId: "srv", workspaceId: "ws-1" } }),
    ).toEqual(workspace("ws-1"));
  });

  it("returns null for transient routes", () => {
    expect(classifyLocation({ pathname: "/welcome", params: {} })).toBeNull();
    expect(classifyLocation({ pathname: "/h/srv/agent/a1", params: {} })).toBeNull();
    expect(classifyLocation({ pathname: "/", params: {} })).toBeNull();
  });

  it("returns a route entry with a normalized path otherwise", () => {
    expect(classifyLocation({ pathname: "/settings/general/", params: {} })).toEqual(
      route("/settings/general"),
    );
    expect(classifyLocation({ pathname: "/sessions?x=1", params: {} })).toEqual(route("/sessions"));
  });
});

describe("resolveWorkspaceReplay", () => {
  const entry = (
    tabId: string | null,
    target: WorkspaceTarget,
  ): Extract<HistoryEntry, { kind: "workspace" }> => ({
    kind: "workspace",
    serverId: "srv",
    workspaceId: "ws",
    tabId,
    target,
  });
  const ctx = (overrides: Partial<Parameters<typeof resolveWorkspaceReplay>[1]> = {}) => ({
    workspaceExists: true,
    tabExists: true,
    agentExists: () => true,
    ...overrides,
  });

  it("is dead when the workspace is gone", () => {
    expect(
      resolveWorkspaceReplay(entry("t", { kind: "files" }), ctx({ workspaceExists: false })),
    ).toEqual({ kind: "dead" });
  });

  it("focuses an existing tab", () => {
    expect(
      resolveWorkspaceReplay(entry("tab_1", { kind: "terminal", terminalId: "x" }), ctx()),
    ).toEqual({ kind: "focus", tabId: "tab_1" });
  });

  const reopenable: WorkspaceTarget[] = [
    { kind: "files" },
    { kind: "changes_tree" },
    { kind: "pull_request" },
    { kind: "working_diff" },
    { kind: "file", path: "src/a.ts" },
  ];
  it.each(reopenable)("re-opens a closed %o tab", (target) => {
    expect(resolveWorkspaceReplay(entry("gone", target), ctx({ tabExists: false }))).toEqual({
      kind: "reopen",
      target,
    });
  });

  it("re-opens a closed agent tab only while the agent still exists", () => {
    const target = { kind: "agent", agentId: "a1" } as const;
    expect(resolveWorkspaceReplay(entry("agent_a1", target), ctx({ tabExists: false }))).toEqual({
      kind: "reopen",
      target,
    });
    expect(
      resolveWorkspaceReplay(
        entry("agent_a1", target),
        ctx({ tabExists: false, agentExists: () => false }),
      ),
    ).toEqual({ kind: "dead" });
  });

  const dead: WorkspaceTarget[] = [
    { kind: "terminal", terminalId: "t" },
    { kind: "browser", browserId: "b" },
    { kind: "draft", draftId: "d" },
    { kind: "commit_diff", sha: "abc" },
    { kind: "setup", workspaceId: "ws" },
    { kind: "new_tab" },
  ];
  it.each(dead)("leaves a closed %o tab for dead", (target) => {
    expect(resolveWorkspaceReplay(entry("gone", target), ctx({ tabExists: false }))).toEqual({
      kind: "dead",
    });
  });

  it("navigates to the workspace alone when no tab was recorded", () => {
    expect(resolveWorkspaceReplay(entry(null, null), ctx({ tabExists: false }))).toEqual({
      kind: "workspace-only",
    });
  });
});
