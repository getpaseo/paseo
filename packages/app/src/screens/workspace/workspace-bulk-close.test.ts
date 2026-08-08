import { describe, expect, it, vi } from "vitest";
import {
  buildBulkCloseConfirmationMessage,
  classifyBulkClosableTabs,
  closeBulkWorkspaceTabs,
  selectWorkspaceEditorTabs,
} from "@/screens/workspace/workspace-bulk-close";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

function makeAgentTab(id: string): WorkspaceTabDescriptor {
  return {
    key: `agent_${id}`,
    tabId: `agent_${id}`,
    kind: "agent",
    target: { kind: "agent", agentId: id },
  };
}

function makeTerminalTab(id: string): WorkspaceTabDescriptor {
  return {
    key: `terminal_${id}`,
    tabId: `terminal_${id}`,
    kind: "terminal",
    target: { kind: "terminal", terminalId: id },
  };
}

function makeFileTab(path: string): WorkspaceTabDescriptor {
  return {
    key: `file_${path}`,
    tabId: `file_${path}`,
    kind: "file",
    target: { kind: "file", path },
  };
}

describe("workspace bulk close helpers", () => {
  it("selects every non-agent, non-terminal tab as an editor tab", () => {
    const tabs: WorkspaceTabDescriptor[] = [
      makeAgentTab("a1"),
      makeTerminalTab("t1"),
      {
        key: "draft",
        tabId: "draft",
        kind: "draft",
        target: { kind: "draft", draftId: "draft-1" },
      },
      {
        key: "provider_subagent",
        tabId: "provider_subagent",
        kind: "provider_subagent",
        target: {
          kind: "provider_subagent",
          parentAgentId: "agent-1",
          subagentId: "subagent-1",
        },
      },
      makeFileTab("/repo/README.md"),
      {
        key: "working_diff",
        tabId: "working_diff",
        kind: "working_diff",
        target: { kind: "working_diff" },
      },
      {
        key: "commit_diff",
        tabId: "commit_diff",
        kind: "commit_diff",
        target: { kind: "commit_diff", sha: "abc123" },
      },
      {
        key: "browser",
        tabId: "browser",
        kind: "browser",
        target: { kind: "browser", browserId: "browser-1" },
      },
      {
        key: "setup",
        tabId: "setup",
        kind: "setup",
        target: { kind: "setup", workspaceId: "workspace-1" },
      },
    ];

    expect(selectWorkspaceEditorTabs(tabs).map((tab) => tab.target.kind)).toEqual([
      "file",
      "working_diff",
      "commit_diff",
      "browser",
      "setup",
    ]);
  });

  it("classifies agent, terminal, and passive tabs for shared bulk close handling", () => {
    const groups = classifyBulkClosableTabs([
      makeAgentTab("a1"),
      makeTerminalTab("t1"),
      makeFileTab("/repo/README.md"),
    ]);

    expect(groups).toEqual({
      archiveAgentTabs: [{ tabId: "agent_a1", agentId: "a1" }],
      layoutOnlyAgentTabs: [],
      terminalTabs: [{ tabId: "terminal_t1", terminalId: "t1" }],
      otherTabs: [
        {
          tabId: "file_/repo/README.md",
          target: { kind: "file", path: "/repo/README.md" },
        },
      ],
    });
  });

  it("separates subagent tabs from agents that archive on close", () => {
    const groups = classifyBulkClosableTabs(
      [makeAgentTab("root"), makeAgentTab("child")],
      (agentId) => (agentId === "child" ? "layout-only" : "archive"),
    );

    expect(groups).toMatchObject({
      archiveAgentTabs: [{ tabId: "agent_root", agentId: "root" }],
      layoutOnlyAgentTabs: [{ tabId: "agent_child", agentId: "child" }],
    });
    expect(buildBulkCloseConfirmationMessage(groups)).toBe(
      "This will archive 1 agent(s) and close 1 tab(s).",
    );
  });

  it("describes mixed destructive bulk close operations in the confirmation copy", () => {
    const message = buildBulkCloseConfirmationMessage(
      classifyBulkClosableTabs([
        makeAgentTab("a1"),
        makeAgentTab("a2"),
        makeTerminalTab("t1"),
        makeFileTab("/repo/README.md"),
      ]),
    );

    expect(message).toBe(
      "This will archive 2 agent(s), close 1 terminal(s), and close 1 tab(s). Any running process in a closed terminal will be stopped immediately.",
    );
  });

  it("keeps terminal-only confirmations explicit about stopping running processes", () => {
    const message = buildBulkCloseConfirmationMessage(
      classifyBulkClosableTabs([makeTerminalTab("t1")]),
    );

    expect(message).toBe(
      "This will close 1 terminal(s). Any running process in a closed terminal will be stopped immediately.",
    );
  });

  it("closes all tabs immediately and fires one mixed closeItems RPC in the background", async () => {
    const groups = classifyBulkClosableTabs([
      makeAgentTab("a1"),
      makeTerminalTab("t1"),
      makeTerminalTab("t2"),
      makeFileTab("/repo/README.md"),
    ]);
    const closedTabIds: string[] = [];
    const cleanupCalls: Array<{ tabId: string; target?: WorkspaceTabDescriptor["target"] }> = [];
    const closeItems = vi.fn(async () => ({
      agents: [{ agentId: "a1", archivedAt: "2026-04-01T04:00:00.000Z" }],
      terminals: [
        { terminalId: "t1", success: true },
        { terminalId: "t2", success: false },
      ],
      requestId: "req-1",
    }));

    await closeBulkWorkspaceTabs({
      groups,
      client: { closeItems },
      closeTab: async (tabId, action) => {
        closedTabIds.push(tabId);
        await action();
      },
      closeWorkspaceTabWithCleanup: (input) => {
        cleanupCalls.push(input);
      },
      closeLayoutOnlyAgent: async () => {},
      logLabel: "all tabs",
    });

    expect(closeItems).toHaveBeenCalledTimes(1);
    expect(closeItems).toHaveBeenCalledWith({
      agentIds: ["a1"],
      terminalIds: ["t1", "t2"],
    });
    expect(closedTabIds).toEqual([
      "agent_a1",
      "terminal_t1",
      "terminal_t2",
      "file_/repo/README.md",
    ]);
    expect(cleanupCalls).toEqual([
      { tabId: "agent_a1", target: { kind: "agent", agentId: "a1" } },
      { tabId: "terminal_t1", target: { kind: "terminal", terminalId: "t1" } },
      { tabId: "terminal_t2", target: { kind: "terminal", terminalId: "t2" } },
      { tabId: "file_/repo/README.md", target: { kind: "file", path: "/repo/README.md" } },
    ]);
  });

  it("still closes all tabs when the mixed closeItems RPC fails", async () => {
    const groups = classifyBulkClosableTabs([
      makeAgentTab("a1"),
      makeTerminalTab("t1"),
      makeFileTab("/repo/README.md"),
    ]);
    const closedTabIds: string[] = [];
    const cleanupCalls: Array<{ tabId: string; target?: WorkspaceTabDescriptor["target"] }> = [];
    const warn = vi.fn();

    await closeBulkWorkspaceTabs({
      groups,
      client: {
        closeItems: async () => {
          throw new Error("rpc failed");
        },
      },
      closeTab: async (tabId, action) => {
        closedTabIds.push(tabId);
        await action();
      },
      closeWorkspaceTabWithCleanup: (input) => {
        cleanupCalls.push(input);
      },
      closeLayoutOnlyAgent: async () => {},
      warn,
      logLabel: "others",
    });

    await Promise.resolve();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(closedTabIds).toEqual(["agent_a1", "terminal_t1", "file_/repo/README.md"]);
    expect(cleanupCalls).toEqual([
      { tabId: "agent_a1", target: { kind: "agent", agentId: "a1" } },
      { tabId: "terminal_t1", target: { kind: "terminal", terminalId: "t1" } },
      { tabId: "file_/repo/README.md", target: { kind: "file", path: "/repo/README.md" } },
    ]);
  });

  it("closes subagent tabs without sending them to closeItems", async () => {
    const groups = classifyBulkClosableTabs(
      [makeAgentTab("root"), makeAgentTab("child")],
      (agentId) => (agentId === "child" ? "layout-only" : "archive"),
    );
    const closeItems = vi.fn(async () => ({ agents: [], terminals: [], requestId: "req-1" }));
    const preparedSubagents: string[] = [];
    const cleanedTabs: string[] = [];

    await closeBulkWorkspaceTabs({
      groups,
      client: { closeItems },
      closeTab: async (_tabId, action) => action(),
      closeLayoutOnlyAgent: async (agentId) => {
        preparedSubagents.push(agentId);
      },
      closeWorkspaceTabWithCleanup: ({ tabId }) => {
        cleanedTabs.push(tabId);
      },
      logLabel: "others",
    });

    expect(closeItems).toHaveBeenCalledWith({ agentIds: ["root"], terminalIds: [] });
    expect(preparedSubagents).toEqual(["child"]);
    expect(cleanedTabs).toEqual(["agent_child", "agent_root"]);
  });
});
