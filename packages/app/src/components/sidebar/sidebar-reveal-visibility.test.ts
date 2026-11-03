import { beforeEach, describe, expect, it } from "vitest";
import { repairRevealVisibility } from "./sidebar-reveal-visibility";
import type { SidebarRevealVisibilityActions } from "./sidebar-reveal-visibility";

function buildEntry(overrides?: Partial<Parameters<typeof repairRevealVisibility>[0]["entry"]>) {
  return {
    serverId: "local",
    projectViewKey: "local:paseo",
    statusBucket: "done" as const,
    background: false,
    pinnedAt: null,
    labels: [],
    ...overrides,
  };
}

function buildHarness(input?: {
  filters?: Partial<Parameters<typeof repairRevealVisibility>[0]["filters"]>;
  collapsed?: Partial<Parameters<typeof repairRevealVisibility>[0]["collapsed"]>;
  groupMode?: Parameters<typeof repairRevealVisibility>[0]["groupMode"];
}) {
  const calls: string[] = [];
  const actions: SidebarRevealVisibilityActions = {
    clearProjectFilters: () => calls.push("clearProjectFilters"),
    clearLabelFilter: () => calls.push("clearLabelFilter"),
    showBackground: () => calls.push("showBackground"),
    expandProject: (key) => calls.push(`expandProject:${key}`),
    expandWorkspaceGroup: (key) => calls.push(`expandWorkspaceGroup:${key}`),
    expandPinned: () => calls.push("expandPinned"),
  };
  const filters = {
    resolvedProjectFilters: [],
    labelFilter: { labels: [] },
    showBackground: true,
    ...input?.filters,
  };
  const collapsed = {
    projectKeys: new Set<string>(),
    workspaceGroupKeys: new Set<string>(),
    pinned: false,
    ...input?.collapsed,
  };
  const groupMode = input?.groupMode ?? "project";
  return { calls, filters, collapsed, groupMode, actions };
}

describe("reveal visibility repair", () => {
  beforeEach(() => {
    // No shared state; each case builds its own harness.
  });

  it("leaves a fully visible workspace alone", () => {
    const { calls, filters, collapsed, groupMode, actions } = buildHarness();
    const changed = repairRevealVisibility({
      entry: buildEntry(),
      filters,
      collapsed,
      groupMode,
      actions,
    });
    expect(changed).toBe(false);
    expect(calls).toEqual([]);
  });

  it("clears a project filter that excludes the workspace's project", () => {
    const { calls, filters, collapsed, groupMode, actions } = buildHarness({
      filters: { resolvedProjectFilters: ["local:other"] },
    });
    const changed = repairRevealVisibility({
      entry: buildEntry({ projectViewKey: "local:paseo" }),
      filters,
      collapsed,
      groupMode,
      actions,
    });
    expect(changed).toBe(true);
    expect(calls).toEqual(["clearProjectFilters"]);
  });

  it("clears a label filter that hides the workspace", () => {
    const { calls, filters, collapsed, groupMode, actions } = buildHarness({
      filters: { labelFilter: { labels: ["wip"] } },
    });
    const changed = repairRevealVisibility({
      entry: buildEntry({ labels: ["shipping"] }),
      filters,
      collapsed,
      groupMode,
      actions,
    });
    expect(changed).toBe(true);
    expect(calls).toEqual(["clearLabelFilter"]);
  });

  it("keeps a label filter the workspace satisfies", () => {
    const { calls, filters, collapsed, groupMode, actions } = buildHarness({
      filters: { labelFilter: { labels: ["wip"] } },
    });
    const changed = repairRevealVisibility({
      entry: buildEntry({ labels: ["WIP"] }),
      filters,
      collapsed,
      groupMode,
      actions,
    });
    expect(changed).toBe(false);
    expect(calls).toEqual([]);
  });

  it("treats the unlabelled key as matching a workspace with no labels", () => {
    const { calls, filters, collapsed, groupMode, actions } = buildHarness({
      filters: { labelFilter: { labels: [""] } },
    });
    const changed = repairRevealVisibility({
      entry: buildEntry({ labels: [] }),
      filters,
      collapsed,
      groupMode,
      actions,
    });
    expect(changed).toBe(false);
    expect(calls).toEqual([]);
  });

  it("shows background workspaces when the target is one", () => {
    const { calls, filters, collapsed, groupMode, actions } = buildHarness({
      filters: { showBackground: false },
    });
    const changed = repairRevealVisibility({
      entry: buildEntry({ background: true }),
      filters,
      collapsed,
      groupMode,
      actions,
    });
    expect(changed).toBe(true);
    expect(calls).toEqual(["showBackground"]);
  });

  it("leaves background hiding alone for a foreground workspace", () => {
    const { calls, filters, collapsed, groupMode, actions } = buildHarness({
      filters: { showBackground: false },
    });
    const changed = repairRevealVisibility({
      entry: buildEntry({ background: false }),
      filters,
      collapsed,
      groupMode,
      actions,
    });
    expect(changed).toBe(false);
    expect(calls).toEqual([]);
  });

  it("expands the collapsed project section in project mode", () => {
    const { calls, filters, collapsed, groupMode, actions } = buildHarness({
      collapsed: { projectKeys: new Set(["local:paseo"]) },
      groupMode: "project",
    });
    const changed = repairRevealVisibility({
      entry: buildEntry({ projectViewKey: "local:paseo" }),
      filters,
      collapsed,
      groupMode,
      actions,
    });
    expect(changed).toBe(true);
    expect(calls).toEqual(["expandProject:local:paseo"]);
  });

  it("expands the collapsed status group the workspace sits in, in status mode", () => {
    const { calls, filters, collapsed, groupMode, actions } = buildHarness({
      collapsed: { workspaceGroupKeys: new Set(["needs_input"]) },
      groupMode: "status",
    });
    const changed = repairRevealVisibility({
      entry: buildEntry({ statusBucket: "needs_input" }),
      filters,
      collapsed,
      groupMode,
      actions,
    });
    expect(changed).toBe(true);
    expect(calls).toEqual(["expandWorkspaceGroup:needs_input"]);
  });

  it("does not touch status-group collapses while rendering project mode", () => {
    const { calls, filters, collapsed, groupMode, actions } = buildHarness({
      collapsed: { workspaceGroupKeys: new Set(["needs_input"]) },
      groupMode: "project",
    });
    const changed = repairRevealVisibility({
      entry: buildEntry({ statusBucket: "needs_input" }),
      filters,
      collapsed,
      groupMode,
      actions,
    });
    expect(changed).toBe(false);
    expect(calls).toEqual([]);
  });

  it("does not touch project collapses while rendering status mode", () => {
    const { calls, filters, collapsed, groupMode, actions } = buildHarness({
      collapsed: { projectKeys: new Set(["local:paseo"]) },
      groupMode: "status",
    });
    const changed = repairRevealVisibility({
      entry: buildEntry({ projectViewKey: "local:paseo" }),
      filters,
      collapsed,
      groupMode,
      actions,
    });
    expect(changed).toBe(false);
    expect(calls).toEqual([]);
  });

  it("expands the pinned section for a pinned workspace", () => {
    const { calls, filters, collapsed, groupMode, actions } = buildHarness({
      collapsed: { pinned: true },
    });
    const changed = repairRevealVisibility({
      entry: buildEntry({ pinnedAt: "2026-10-19T00:00:00Z" }),
      filters,
      collapsed,
      groupMode,
      actions,
    });
    expect(changed).toBe(true);
    expect(calls).toEqual(["expandPinned"]);
  });

  it("ignores the pinned section for an unpinned workspace", () => {
    const { calls, filters, collapsed, groupMode, actions } = buildHarness({
      collapsed: { pinned: true },
    });
    const changed = repairRevealVisibility({
      entry: buildEntry({ pinnedAt: null }),
      filters,
      collapsed,
      groupMode,
      actions,
    });
    expect(changed).toBe(false);
    expect(calls).toEqual([]);
  });

  it("repairs every gate that hides the workspace, in one pass", () => {
    const { calls, filters, collapsed, groupMode, actions } = buildHarness({
      filters: {
        resolvedProjectFilters: ["local:other"],
        showBackground: false,
      },
      collapsed: { projectKeys: new Set(["local:paseo"]), pinned: true },
      groupMode: "project",
    });
    const changed = repairRevealVisibility({
      entry: buildEntry({ background: true, pinnedAt: "2026-10-19T00:00:00Z" }),
      filters,
      collapsed,
      groupMode,
      actions,
    });
    expect(changed).toBe(true);
    expect(calls).toEqual([
      "clearProjectFilters",
      "showBackground",
      "expandProject:local:paseo",
      "expandPinned",
    ]);
  });
});
