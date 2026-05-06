import { describe, expect, it } from "vitest";
import { deriveWorkspaceTabModel } from "@/screens/workspace/workspace-tab-model";
import type { WorkspaceTab } from "@/stores/workspace-tabs-store";

describe("deriveWorkspaceTabModel", () => {
  it("keeps normalized tabs in stored order and preserves targets", () => {
    const uiTabs: WorkspaceTab[] = [
      {
        tabId: "draft_123",
        target: { kind: "draft", draftId: "draft_123" },
        createdAt: 1,
      },
      {
        tabId: "file_/repo/worktree/README.md",
        target: { kind: "file", path: "/repo/worktree/README.md" },
        createdAt: 2,
      },
      {
        tabId: "agent_agent-a",
        target: { kind: "agent", agentId: "agent-a" },
        createdAt: 3,
      },
    ];

    const model = deriveWorkspaceTabModel({
      tabs: [uiTabs[0], uiTabs[2], uiTabs[1]],
    });

    expect(model.tabs.map((tab) => tab.descriptor.tabId)).toEqual([
      "draft_123",
      "agent_agent-a",
      "file_/repo/worktree/README.md",
    ]);
    expect(model.tabs[0]?.descriptor.target).toEqual({ kind: "draft", draftId: "draft_123" });
    expect(model.tabs[1]?.descriptor.target).toEqual({ kind: "agent", agentId: "agent-a" });
    expect(model.tabs[2]?.descriptor.target).toEqual({
      kind: "file",
      path: "/repo/worktree/README.md",
    });
  });

  it("applies stored order and appends unordered tabs deterministically", () => {
    const model = deriveWorkspaceTabModel({
      tabs: [
        {
          tabId: "terminal_term-1",
          target: { kind: "terminal", terminalId: "term-1" },
          createdAt: 3,
        },
        { tabId: "agent_agent-b", target: { kind: "agent", agentId: "agent-b" }, createdAt: 2 },
        { tabId: "agent_agent-a", target: { kind: "agent", agentId: "agent-a" }, createdAt: 1 },
      ],
    });

    expect(model.tabs.map((tab) => tab.descriptor.tabId)).toEqual([
      "terminal_term-1",
      "agent_agent-b",
      "agent_agent-a",
    ]);
  });

  it("uses focused tab when present, otherwise falls back to first tab", () => {
    const base: Parameters<typeof deriveWorkspaceTabModel>[0] = {
      tabs: [
        { tabId: "agent_agent-a", target: { kind: "agent", agentId: "agent-a" }, createdAt: 1 },
        { tabId: "agent_agent-b", target: { kind: "agent", agentId: "agent-b" }, createdAt: 2 },
      ],
    };

    expect(
      deriveWorkspaceTabModel({
        ...base,
        focusedTabId: "agent_agent-b",
      }).activeTabId,
    ).toBe("agent_agent-b");

    expect(deriveWorkspaceTabModel(base).activeTabId).toBe("agent_agent-a");
  });

  it("prefers the route-selected target over stale focused tab state", () => {
    const model = deriveWorkspaceTabModel({
      tabs: [
        { tabId: "agent_agent-a", target: { kind: "agent", agentId: "agent-a" }, createdAt: 1 },
        { tabId: "agent_agent-b", target: { kind: "agent", agentId: "agent-b" }, createdAt: 2 },
      ],
      focusedTabId: "agent_agent-a",
      preferredTarget: { kind: "agent", agentId: "agent-b" },
    });

    expect(model.activeTabId).toBe("agent_agent-b");
    expect(model.activeTab?.descriptor.target).toEqual({ kind: "agent", agentId: "agent-b" });
  });

  it("normalizes preferredTarget before overriding focused tab selection", () => {
    const model = deriveWorkspaceTabModel({
      tabs: [
        {
          tabId: "file_/repo/worktree/README.md",
          target: { kind: "file", path: "/repo/worktree/README.md" },
          createdAt: 1,
        },
        {
          tabId: "agent_agent-a",
          target: { kind: "agent", agentId: "agent-a" },
          createdAt: 2,
        },
      ],
      focusedTabId: "agent_agent-a",
      preferredTarget: { kind: "file", path: "\\repo\\worktree\\README.md" },
    });

    expect(model.activeTabId).toBe("file_/repo/worktree/README.md");
    expect(model.activeTab?.descriptor.target).toEqual({
      kind: "file",
      path: "/repo/worktree/README.md",
    });
  });

  it("keeps retargeted tab ids stable while matching upgraded targets", () => {
    const model = deriveWorkspaceTabModel({
      tabs: [
        {
          tabId: "draft_abc",
          target: { kind: "agent", agentId: "agent-1" },
          createdAt: 1,
        },
      ],
      preferredTarget: { kind: "agent", agentId: "agent-1" },
    });

    expect(model.activeTabId).toBe("draft_abc");
    expect(model.activeTab?.descriptor.tabId).toBe("draft_abc");
    expect(model.activeTab?.descriptor.target).toEqual({ kind: "agent", agentId: "agent-1" });
  });

  it("normalizes file paths and discards invalid tabs", () => {
    const model = deriveWorkspaceTabModel({
      tabs: [
        {
          tabId: "file_path",
          target: { kind: "file", path: "\\repo\\worktree\\README.md" },
          createdAt: 1,
        },
        {
          tabId: "",
          target: { kind: "agent", agentId: "agent-a" },
          createdAt: 2,
        },
      ],
    });

    expect(model.tabs).toHaveLength(1);
    expect(model.tabs[0]?.descriptor.target).toEqual({
      kind: "file",
      path: "/repo/worktree/README.md",
    });
  });
});
