import { describe, expect, it } from "vitest";
import {
  isWorkspaceTabPinned,
  reorderWorkspaceTabPinKeys,
  sortWorkspaceTabsPinnedFirst,
  toggleWorkspaceTabPinKey,
  workspaceTabPinKey,
} from "@/screens/workspace/workspace-tab-pins";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

function agentTab(agentId: string): WorkspaceTabDescriptor {
  return {
    key: `agent_${agentId}`,
    tabId: `agent_${agentId}`,
    kind: "agent",
    target: { kind: "agent", agentId },
  };
}

function fileTab(path: string): WorkspaceTabDescriptor {
  return {
    key: `file_${path}`,
    tabId: `file_${path}`,
    kind: "file",
    target: { kind: "file", path },
  };
}

describe("workspaceTabPinKey", () => {
  it("derives deterministic keys from tab targets", () => {
    expect(workspaceTabPinKey({ kind: "agent", agentId: "a1" })).toBe("agent_a1");
    expect(workspaceTabPinKey({ kind: "file", path: "/x/y.ts" })).toBe("file_/x/y.ts");
  });
});

describe("toggleWorkspaceTabPinKey", () => {
  it("appends the key when not pinned", () => {
    expect(toggleWorkspaceTabPinKey([], { kind: "agent", agentId: "a1" })).toEqual(["agent_a1"]);
    expect(toggleWorkspaceTabPinKey(["agent_a1"], { kind: "agent", agentId: "a2" })).toEqual([
      "agent_a1",
      "agent_a2",
    ]);
  });

  it("removes the key when already pinned", () => {
    expect(
      toggleWorkspaceTabPinKey(["agent_a1", "agent_a2"], { kind: "agent", agentId: "a1" }),
    ).toEqual(["agent_a2"]);
  });
});

describe("isWorkspaceTabPinned", () => {
  it("matches by deterministic key", () => {
    expect(isWorkspaceTabPinned(["agent_a1"], { kind: "agent", agentId: "a1" })).toBe(true);
    expect(isWorkspaceTabPinned(["agent_a1"], { kind: "agent", agentId: "a2" })).toBe(false);
  });
});

describe("reorderWorkspaceTabPinKeys", () => {
  const agent = (agentId: string) => ({ kind: "agent", agentId }) as const;

  it("is a no-op when nothing is pinned", () => {
    expect(reorderWorkspaceTabPinKeys([], [agent("a1"), agent("a2")])).toEqual([]);
  });

  it("adopts the new relative order of pinned tabs", () => {
    const next = reorderWorkspaceTabPinKeys(
      ["agent_a1", "agent_a2", "agent_a3"],
      [agent("a2"), agent("a1"), agent("a3"), agent("x")],
    );
    expect(next).toEqual(["agent_a2", "agent_a1", "agent_a3"]);
  });

  it("clamps a pinned tab dragged past unpinned tabs to the end of the pinned section", () => {
    // Visual drop order: a2 stayed first, unpinned x in the middle, pinned a1
    // dragged to the end. a1 stays pinned but moves after a2.
    const next = reorderWorkspaceTabPinKeys(
      ["agent_a1", "agent_a2"],
      [agent("a2"), agent("x"), agent("a1")],
    );
    expect(next).toEqual(["agent_a2", "agent_a1"]);
  });

  it("leaves pins untouched when an unpinned tab is dragged into the pinned zone", () => {
    const next = reorderWorkspaceTabPinKeys(
      ["agent_a1", "agent_a2"],
      [agent("a1"), agent("x"), agent("a2")],
    );
    expect(next).toEqual(["agent_a1", "agent_a2"]);
  });

  it("keeps pinned keys absent from the reordered pane at their original positions", () => {
    // Pane only shows a2 and a3; a1 is pinned in another pane and keeps slot 0.
    const next = reorderWorkspaceTabPinKeys(
      ["agent_a1", "agent_a2", "agent_a3"],
      [agent("a3"), agent("a2")],
    );
    expect(next).toEqual(["agent_a1", "agent_a3", "agent_a2"]);
  });

  it("ignores unpinned targets entirely", () => {
    const next = reorderWorkspaceTabPinKeys(["agent_a1"], [agent("x"), agent("a1"), agent("y")]);
    expect(next).toEqual(["agent_a1"]);
  });
});

describe("sortWorkspaceTabsPinnedFirst", () => {
  it("keeps order untouched when nothing is pinned", () => {
    const tabs = [agentTab("a1"), fileTab("/x.ts"), agentTab("a2")];
    expect(sortWorkspaceTabsPinnedFirst(tabs, [], (tab) => tab.target)).toEqual(tabs);
  });

  it("moves pinned tabs to the front in pin order", () => {
    const tabs = [agentTab("a1"), fileTab("/x.ts"), agentTab("a2"), fileTab("/y.ts")];
    const sorted = sortWorkspaceTabsPinnedFirst(
      tabs,
      ["agent_a2", "file_/x.ts"],
      (tab) => tab.target,
    );
    expect(sorted.map((tab) => tab.tabId)).toEqual([
      "agent_a2",
      "file_/x.ts",
      "agent_a1",
      "file_/y.ts",
    ]);
  });

  it("ignores pin keys with no matching open tab", () => {
    const tabs = [agentTab("a1"), agentTab("a2")];
    const sorted = sortWorkspaceTabsPinnedFirst(
      tabs,
      ["agent_gone", "agent_a2"],
      (tab) => tab.target,
    );
    expect(sorted.map((tab) => tab.tabId)).toEqual(["agent_a2", "agent_a1"]);
  });

  it("preserves relative order of unpinned tabs", () => {
    const tabs = [fileTab("/a.ts"), fileTab("/b.ts"), fileTab("/c.ts"), fileTab("/d.ts")];
    const sorted = sortWorkspaceTabsPinnedFirst(tabs, ["file_/c.ts"], (tab) => tab.target);
    expect(sorted.map((tab) => tab.tabId)).toEqual([
      "file_/c.ts",
      "file_/a.ts",
      "file_/b.ts",
      "file_/d.ts",
    ]);
  });
});
