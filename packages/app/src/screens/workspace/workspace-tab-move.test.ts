import { describe, expect, it, vi } from "vitest";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import {
  buildMoveToWorkspaceMenuEntry,
  buildTabClosedLabels,
  buildTabWorkspaceLabels,
  formatTabOrderLabel,
  groupWorkspaceTabMoveTargets,
  insertMoveToWorkspaceMenuEntry,
  listWorkspaceTabMoveTargets,
  mergePendingTabLabels,
  moveWorkspaceTab,
  parseTabOrderLabel,
  decideSyncedClose,
  pendingTabLabelsSatisfied,
  planTabOrderEnforcement,
  planTabWorkspaceEnforcement,
  resolveSidebarDropWorkspaceKey,
  workspaceKeyServerId,
  resolveWorkspaceTabMoveRowLabel,
  resolveWorkspaceTabMoveSource,
  resolveWorkspaceTabMoveStrings,
  MOVE_TO_WORKSPACE_MENU_KEY,
  TAB_CLOSED_LABEL,
  TAB_ORDER_LABEL,
  TAB_WORKSPACE_LABEL,
  type WorkspaceTabMoveStore,
  type WorkspaceTabMoveWorkspace,
} from "@/screens/workspace/workspace-tab-move";

function agentTab(agentId: string, tabId = `tab-${agentId}`): WorkspaceTab {
  return {
    tabId,
    target: { kind: "agent", agentId },
    createdAt: 1,
  };
}

function terminalTab(terminalId: string): WorkspaceTab {
  return {
    tabId: `tab-${terminalId}`,
    target: { kind: "terminal", terminalId },
    createdAt: 1,
  };
}

function workspace(
  workspaceId: string,
  overrides: Partial<WorkspaceTabMoveWorkspace> = {},
): WorkspaceTabMoveWorkspace {
  return {
    workspaceKey: `srv:${workspaceId}`,
    workspaceId,
    projectName: "Project A",
    name: workspaceId,
    currentBranch: null,
    workspaceDirectoryLabel: `~/work/${workspaceId}`,
    archiving: false,
    ...overrides,
  };
}

describe("resolveWorkspaceTabMoveStrings", () => {
  it("returns Chinese strings for zh locales", () => {
    const strings = resolveWorkspaceTabMoveStrings("zh-CN");
    expect(strings.menuLabel).toContain("挪");
    expect(strings.title).toContain("Workspace");
    expect(strings.empty.length).toBeGreaterThan(0);
  });

  it("returns English strings for English and unknown locales", () => {
    expect(resolveWorkspaceTabMoveStrings("en").menuLabel).toBe("Move to workspace…");
    expect(resolveWorkspaceTabMoveStrings(null).menuLabel).toBe("Move to workspace…");
    expect(resolveWorkspaceTabMoveStrings("fr-FR").menuLabel).toBe("Move to workspace…");
  });
});

describe("resolveWorkspaceTabMoveRowLabel", () => {
  it("uses the workspace name in title mode", () => {
    expect(
      resolveWorkspaceTabMoveRowLabel({
        workspace: { name: "my-workspace", currentBranch: "main" },
        titleSource: "title",
      }),
    ).toBe("my-workspace");
  });

  it("uses the branch in branch mode, falling back to the name", () => {
    expect(
      resolveWorkspaceTabMoveRowLabel({
        workspace: { name: "my-workspace", currentBranch: "main" },
        titleSource: "branch",
      }),
    ).toBe("main");
    expect(
      resolveWorkspaceTabMoveRowLabel({
        workspace: { name: "my-workspace", currentBranch: null },
        titleSource: "branch",
      }),
    ).toBe("my-workspace");
  });
});

describe("groupWorkspaceTabMoveTargets", () => {
  it("groups by project name, preserving sidebar order", () => {
    const groups = groupWorkspaceTabMoveTargets([
      workspace("ws-a", { projectName: "P1" }),
      workspace("ws-b", { projectName: "P2" }),
      workspace("ws-c", { projectName: "P1" }),
    ]);
    expect(groups.map((group) => group.projectName)).toEqual(["P1", "P2"]);
    expect(groups[0].workspaces.map((item) => item.workspaceId)).toEqual(["ws-a", "ws-c"]);
    expect(groups[1].workspaces.map((item) => item.workspaceId)).toEqual(["ws-b"]);
  });
});

describe("buildMoveToWorkspaceMenuEntry", () => {
  it("returns null for non-agent tabs", () => {
    expect(
      buildMoveToWorkspaceMenuEntry({
        tab: terminalTab("t1"),
        onSelect: () => {},
        strings: resolveWorkspaceTabMoveStrings("en"),
      }),
    ).toBeNull();
  });

  it("returns a stable entry for agent tabs and forwards the tab on select", () => {
    const tab = agentTab("agent-1");
    const onSelect = vi.fn();
    const strings = resolveWorkspaceTabMoveStrings("zh-CN");
    const entry = buildMoveToWorkspaceMenuEntry({ tab, onSelect, strings });
    expect(entry).not.toBeNull();
    expect(entry?.kind).toBe("item");
    expect(entry?.key).toBe(MOVE_TO_WORKSPACE_MENU_KEY);
    if (entry?.kind !== "item") throw new Error("expected item entry");
    expect(entry.label).toBe(strings.menuLabel);
    entry.onSelect();
    expect(onSelect).toHaveBeenCalledWith(tab);
  });
});

describe("insertMoveToWorkspaceMenuEntry", () => {
  const strings = resolveWorkspaceTabMoveStrings("en");

  it("inserts the move entry before the close group and keeps other entries", () => {
    const entries = [
      { kind: "item", key: "rename", label: "Rename", testID: "rename", onSelect: () => {} },
      { kind: "separator", key: "rename-separator" },
      {
        kind: "item",
        key: "close-before",
        label: "Close left",
        testID: "close-before",
        onSelect: () => {},
      },
      { kind: "item", key: "close", label: "Close", testID: "close", onSelect: () => {} },
    ] as const;
    const result = insertMoveToWorkspaceMenuEntry({
      entries: [...entries],
      tab: agentTab("agent-1"),
      onSelect: () => {},
      strings,
    });
    const keys = result.map((entry) => entry.key);
    expect(keys).toEqual([
      "rename",
      "rename-separator",
      MOVE_TO_WORKSPACE_MENU_KEY,
      "close-before",
      "close",
    ]);
  });

  it("appends at the end when the close group is missing", () => {
    const entries = [
      { kind: "item", key: "rename", label: "Rename", testID: "rename", onSelect: () => {} },
    ] as const;
    const result = insertMoveToWorkspaceMenuEntry({
      entries: [...entries],
      tab: agentTab("agent-1"),
      onSelect: () => {},
      strings,
    });
    expect(result.map((entry) => entry.key)).toEqual(["rename", MOVE_TO_WORKSPACE_MENU_KEY]);
  });

  it("does not duplicate the entry when it already exists", () => {
    const first = insertMoveToWorkspaceMenuEntry({
      entries: [],
      tab: agentTab("agent-1"),
      onSelect: () => {},
      strings,
    });
    const second = insertMoveToWorkspaceMenuEntry({
      entries: first,
      tab: agentTab("agent-1"),
      onSelect: () => {},
      strings,
    });
    expect(second.map((entry) => entry.key)).toEqual([MOVE_TO_WORKSPACE_MENU_KEY]);
  });

  it("leaves non-agent tabs untouched", () => {
    const entries = [
      { kind: "item", key: "close", label: "Close", testID: "close", onSelect: () => {} },
    ] as const;
    const result = insertMoveToWorkspaceMenuEntry({
      entries: [...entries],
      tab: terminalTab("t1"),
      onSelect: () => {},
      strings,
    });
    expect(result.map((entry) => entry.key)).toEqual(["close"]);
  });
});

describe("resolveWorkspaceTabMoveSource", () => {
  it("finds the workspace whose layout contains the tab", () => {
    const source = resolveWorkspaceTabMoveSource({
      tabId: "tab-1",
      layouts: [
        { workspaceKey: "srv:ws-a", tabIds: ["tab-0", "tab-1"] },
        { workspaceKey: "srv:ws-b", tabIds: ["tab-9"] },
      ],
    });
    expect(source).toEqual({ workspaceKey: "srv:ws-a" });
  });

  it("returns null when no workspace holds the tab", () => {
    expect(
      resolveWorkspaceTabMoveSource({
        tabId: "tab-missing",
        layouts: [{ workspaceKey: "srv:ws-a", tabIds: ["tab-0"] }],
      }),
    ).toBeNull();
  });
});

describe("listWorkspaceTabMoveTargets", () => {
  it("excludes the source workspace and archiving workspaces", () => {
    const targets = listWorkspaceTabMoveTargets({
      sourceWorkspaceKey: "srv:ws-a",
      workspaces: [
        workspace("ws-a"),
        workspace("ws-b"),
        workspace("ws-archived", { archiving: true }),
        workspace("ws-c"),
      ],
    });
    expect(targets.map((target) => target.workspaceId)).toEqual(["ws-b", "ws-c"]);
  });
});

describe("tab order labels", () => {
  it("formats and parses order labels", () => {
    expect(formatTabOrderLabel(3)).toBe("000003");
    expect(parseTabOrderLabel("000003")).toBe(3);
    expect(parseTabOrderLabel("12")).toBe(12);
    expect(parseTabOrderLabel("nope")).toBeNull();
    expect(parseTabOrderLabel(null)).toBeNull();
  });

  it("records the order alongside the workspace label", () => {
    expect(buildTabWorkspaceLabels(null, "ws-b", 2)).toEqual({
      [TAB_WORKSPACE_LABEL]: "ws-b",
      [TAB_CLOSED_LABEL]: "",
      [TAB_ORDER_LABEL]: "000002",
    });
  });
});

describe("planTabOrderEnforcement", () => {
  it("sorts agent tabs by their order label, keeping unlabeled tabs last", () => {
    expect(
      planTabOrderEnforcement({
        agentTabIdsInSlots: ["c", "a", "b"],
        orderLabelByTabId: { a: "000000", b: "000001", c: "000002" },
      }),
    ).toEqual(["a", "b", "c"]);
    expect(
      planTabOrderEnforcement({
        agentTabIdsInSlots: ["x", "a", "y"],
        orderLabelByTabId: { a: "000000" },
      }),
    ).toEqual(["a", "x", "y"]);
  });

  it("keeps the current order when labels are missing or equal", () => {
    expect(
      planTabOrderEnforcement({
        agentTabIdsInSlots: ["a", "b"],
        orderLabelByTabId: {},
      }),
    ).toEqual(["a", "b"]);
    expect(
      planTabOrderEnforcement({
        agentTabIdsInSlots: ["a", "b"],
        orderLabelByTabId: { a: "000000", b: "000001" },
      }),
    ).toEqual(["a", "b"]);
  });
});

describe("buildTabWorkspaceLabels", () => {
  it("sets the tab-workspace label, clears the closed tombstone, and keeps existing labels", () => {
    const labels = buildTabWorkspaceLabels(
      { "paseo.open-agent-tab.abc": "true", [TAB_CLOSED_LABEL]: "1" },
      "ws-b",
    );
    expect(labels).toEqual({
      "paseo.open-agent-tab.abc": "true",
      [TAB_WORKSPACE_LABEL]: "ws-b",
      [TAB_CLOSED_LABEL]: "",
    });
    expect(labels[TAB_ORDER_LABEL]).toBeUndefined();
  });

  it("works without existing labels", () => {
    expect(buildTabWorkspaceLabels(null, "ws-b")).toEqual({
      [TAB_WORKSPACE_LABEL]: "ws-b",
      [TAB_CLOSED_LABEL]: "",
    });
  });
});

describe("buildTabClosedLabels", () => {
  it("marks the tab closed while keeping the workspace label for reopen placement", () => {
    expect(
      buildTabClosedLabels({ [TAB_WORKSPACE_LABEL]: "ws-b", [TAB_ORDER_LABEL]: "000002" }),
    ).toEqual({
      [TAB_WORKSPACE_LABEL]: "ws-b",
      [TAB_ORDER_LABEL]: "000002",
      [TAB_CLOSED_LABEL]: "1",
    });
  });
});

describe("decideSyncedClose", () => {
  const base = {
    tombstone: false,
    archived: false,
    pendingClosed: null as boolean | null,
    pinned: false,
    justArchived: false,
  };

  it("closes an archived agent nobody explicitly opened", () => {
    expect(decideSyncedClose({ ...base, archived: true })).toEqual({ closed: true });
  });

  it("keeps an archived agent that is pinned or just opened", () => {
    expect(decideSyncedClose({ ...base, archived: true, pinned: true })).toEqual({
      closed: false,
    });
    expect(decideSyncedClose({ ...base, archived: true, pendingClosed: false })).toEqual({
      closed: false,
    });
  });

  it("lets a user close beat a leftover pin", () => {
    expect(decideSyncedClose({ ...base, pendingClosed: true, pinned: true })).toEqual({
      closed: true,
    });
    expect(decideSyncedClose({ ...base, tombstone: true, pinned: true })).toEqual({
      closed: true,
    });
  });

  it("closes a pinned tab when archive arrives, so a move pin cannot keep it", () => {
    expect(decideSyncedClose({ ...base, justArchived: true, pinned: true })).toEqual({
      closed: true,
    });
  });

  it("does not clear another client's close when unarchive arrives", () => {
    expect(decideSyncedClose({ ...base, tombstone: true, pinned: true })).toEqual({
      closed: true,
    });
    expect(
      decideSyncedClose({ ...base, tombstone: true, pendingClosed: false, pinned: true }),
    ).toEqual({ closed: false });
  });
});

describe("planTabWorkspaceEnforcement", () => {
  it("closes stale tabs and ensures the tab exists in the labeled target", () => {
    expect(
      planTabWorkspaceEnforcement({
        targetWorkspaceKey: "srv:ws-b",
        workspaceKeysWithTab: ["srv:ws-a"],
      }),
    ).toEqual({ closeIn: ["srv:ws-a"], ensureIn: "srv:ws-b" });
  });

  it("only closes stale tabs when the target already has the tab", () => {
    expect(
      planTabWorkspaceEnforcement({
        targetWorkspaceKey: "srv:ws-b",
        workspaceKeysWithTab: ["srv:ws-a", "srv:ws-b"],
      }),
    ).toEqual({ closeIn: ["srv:ws-a"], ensureIn: null });
  });

  it("does nothing without a target label", () => {
    expect(
      planTabWorkspaceEnforcement({
        targetWorkspaceKey: null,
        workspaceKeysWithTab: ["srv:ws-a"],
      }),
    ).toEqual({ closeIn: [], ensureIn: null });
  });

  it("closes the tab everywhere when the closed tombstone is set", () => {
    expect(
      planTabWorkspaceEnforcement({
        targetWorkspaceKey: "srv:ws-b",
        workspaceKeysWithTab: ["srv:ws-a", "srv:ws-b"],
        closed: true,
      }),
    ).toEqual({ closeIn: ["srv:ws-a", "srv:ws-b"], ensureIn: null });
  });

  it("keeps a tombstoned tab closed even when no client has it open", () => {
    expect(
      planTabWorkspaceEnforcement({
        targetWorkspaceKey: "srv:ws-b",
        workspaceKeysWithTab: [],
        closed: true,
      }),
    ).toEqual({ closeIn: [], ensureIn: null });
  });
});

describe("resolveSidebarDropWorkspaceKey", () => {
  it("parses the workspace key from the sidebar row test id", () => {
    expect(resolveSidebarDropWorkspaceKey("sidebar-workspace-row-srv:ws-b")).toBe("srv:ws-b");
  });

  it("returns null for unrelated test ids", () => {
    expect(resolveSidebarDropWorkspaceKey("workspace-tab-abc")).toBeNull();
    expect(resolveSidebarDropWorkspaceKey(null)).toBeNull();
    expect(resolveSidebarDropWorkspaceKey("sidebar-workspace-row-")).toBeNull();
  });
});

describe("workspaceKeyServerId", () => {
  it("returns the host half of a layout key", () => {
    expect(workspaceKeyServerId("srv_e2e_worker_0:wks_123")).toBe("srv_e2e_worker_0");
  });

  it("returns null for keys without a host separator", () => {
    expect(workspaceKeyServerId("wks_123")).toBeNull();
    expect(workspaceKeyServerId(":wks_123")).toBeNull();
    expect(workspaceKeyServerId("")).toBeNull();
    expect(workspaceKeyServerId(null)).toBeNull();
    expect(workspaceKeyServerId(undefined)).toBeNull();
  });
});

describe("moveWorkspaceTab", () => {
  function makeStore(openResult: string | null = "new-tab") {
    return {
      openTab: vi.fn(() => openResult),
      closeTab: vi.fn(),
      unpinAgent: vi.fn(),
      hideAgent: vi.fn(),
    } satisfies WorkspaceTabMoveStore;
  }

  it("reveals and pins the tab in the target workspace, then closes it in the source", () => {
    const store = makeStore();
    const moved = moveWorkspaceTab(
      { store },
      {
        sourceWorkspaceKey: "srv:ws-a",
        targetWorkspaceKey: "srv:ws-b",
        tabId: "tab-1",
        target: { kind: "agent", agentId: "agent-1" },
      },
    );
    expect(moved).toBe(true);
    expect(store.openTab).toHaveBeenCalledWith({
      workspaceKey: "srv:ws-b",
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      pin: true,
    });
    expect(store.unpinAgent).toHaveBeenCalledWith("srv:ws-a", "agent-1");
    expect(store.hideAgent).toHaveBeenCalledWith("srv:ws-a", "agent-1");
    expect(store.closeTab).toHaveBeenCalledWith("srv:ws-a", "tab-1");
  });

  it("writes the synced workspace label when ids are provided", () => {
    const store = makeStore();
    const updateAgentLabels = vi.fn();
    const moved = moveWorkspaceTab(
      { store, updateAgentLabels },
      {
        sourceWorkspaceKey: "srv:ws-a",
        targetWorkspaceKey: "srv:ws-b",
        tabId: "tab-1",
        target: { kind: "agent", agentId: "agent-1" },
        targetWorkspaceId: "ws-b",
        agentLabels: { existing: "1" },
      },
    );
    expect(moved).toBe(true);
    expect(updateAgentLabels).toHaveBeenCalledWith("agent-1", {
      existing: "1",
      [TAB_WORKSPACE_LABEL]: "ws-b",
      [TAB_CLOSED_LABEL]: "",
    });
  });

  it("keeps the source tab when the target open fails", () => {
    const store = makeStore(null);
    const moved = moveWorkspaceTab(
      { store },
      {
        sourceWorkspaceKey: "srv:ws-a",
        targetWorkspaceKey: "srv:ws-b",
        tabId: "tab-1",
        target: { kind: "agent", agentId: "agent-1" },
      },
    );
    expect(moved).toBe(false);
    expect(store.closeTab).not.toHaveBeenCalled();
    expect(store.hideAgent).not.toHaveBeenCalled();
  });

  it("no-ops when the target workspace is the source workspace", () => {
    const store = makeStore();
    const moved = moveWorkspaceTab(
      { store },
      {
        sourceWorkspaceKey: "srv:ws-a",
        targetWorkspaceKey: "srv:ws-a",
        tabId: "tab-1",
        target: { kind: "agent", agentId: "agent-1" },
      },
    );
    expect(moved).toBe(false);
    expect(store.openTab).not.toHaveBeenCalled();
    expect(store.closeTab).not.toHaveBeenCalled();
  });

  it("refuses non-agent targets", () => {
    const store = makeStore();
    const moved = moveWorkspaceTab(
      { store },
      {
        sourceWorkspaceKey: "srv:ws-a",
        targetWorkspaceKey: "srv:ws-b",
        tabId: "tab-1",
        target: { kind: "terminal", terminalId: "t-1" },
      },
    );
    expect(moved).toBe(false);
    expect(store.openTab).not.toHaveBeenCalled();
  });
});

describe("pending label merge", () => {
  const stored = {
    [TAB_WORKSPACE_LABEL]: "ws-a",
    [TAB_ORDER_LABEL]: "000001",
    [TAB_CLOSED_LABEL]: "",
  };

  it("merges local intent over stale stored labels during the echo window", () => {
    expect(mergePendingTabLabels(stored, { workspaceId: "ws-b" })).toEqual({
      [TAB_WORKSPACE_LABEL]: "ws-b",
      [TAB_ORDER_LABEL]: "000001",
      [TAB_CLOSED_LABEL]: "",
    });
    expect(mergePendingTabLabels(stored, { closed: true })[TAB_CLOSED_LABEL]).toBe("1");
    expect(mergePendingTabLabels(stored, { order: "000004" })[TAB_ORDER_LABEL]).toBe("000004");
  });

  it("returns the stored labels untouched when nothing is pending", () => {
    expect(mergePendingTabLabels(stored, undefined)).toEqual(stored);
    expect(mergePendingTabLabels(null, undefined)).toEqual({});
  });

  it("retires a pending write once the echo carries every written key", () => {
    const pending = { workspaceId: "ws-b", closed: false };
    expect(
      pendingTabLabelsSatisfied(pending, {
        [TAB_WORKSPACE_LABEL]: "ws-b",
        [TAB_CLOSED_LABEL]: "",
      }),
    ).toBe(true);
    // The echo has not landed yet: the stored copy still holds the old value.
    expect(pendingTabLabelsSatisfied(pending, stored)).toBe(false);
    expect(pendingTabLabelsSatisfied({ closed: true }, { [TAB_CLOSED_LABEL]: "" })).toBe(false);
    expect(pendingTabLabelsSatisfied({ order: "000002" }, stored)).toBe(false);
  });
});
