import { describe, expect, it, vi } from "vitest";
import {
  buildWorkspaceDesktopTabActions,
  buildWorkspaceTabMenuEntries,
} from "@/screens/workspace/workspace-tab-menu";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

function createAgentTab(): WorkspaceTabDescriptor {
  return {
    key: "agent_123",
    tabId: "agent_123",
    kind: "agent",
    target: { kind: "agent", agentId: "agent-123" },
  };
}

describe("buildWorkspaceTabMenuEntries", () => {
  it("uses desktop tab ordering labels for desktop menus", () => {
    const onCopyResumeCommand = vi.fn();
    const onCopyAgentId = vi.fn();
    const onCopyFilePath = vi.fn();
    const onReloadAgent = vi.fn();
    const onRenameTab = vi.fn();
    const onCloseTab = vi.fn();
    const onCloseTabsBefore = vi.fn();
    const onCloseTabsAfter = vi.fn();
    const onCloseOtherTabs = vi.fn();

    const entries = buildWorkspaceTabMenuEntries({
      surface: "desktop",
      tab: createAgentTab(),
      index: 1,
      tabCount: 3,
      menuTestIDBase: "workspace-tab-context-agent_123",
      onCopyResumeCommand,
      onCopyAgentId,
      onCopyTerminalId: vi.fn(),
      onCopyFilePath,
      onReloadAgent,
      onForkAgent: vi.fn(),
      onRenameTab,
      onCloseTab,
      onCloseTabsBefore,
      onCloseTabsAfter,
      onCloseOtherTabs,
    });

    expect(entries.filter((entry) => entry.kind === "item").map((entry) => entry.label)).toEqual([
      "Copy resume command",
      "Copy agent id",
      "Fork chat in a new tab",
      "Fork chat in a new workspace",
      "Rename",
      "Close to the left",
      "Close to the right",
      "Close other tabs",
      "Reload agent",
      "Close",
    ]);
  });

  it("uses stacked ordering labels for mobile menus", () => {
    const entries = buildWorkspaceTabMenuEntries({
      surface: "mobile",
      tab: createAgentTab(),
      index: 1,
      tabCount: 3,
      menuTestIDBase: "workspace-tab-menu-agent_123",
      onCopyResumeCommand: vi.fn(),
      onCopyAgentId: vi.fn(),
      onCopyTerminalId: vi.fn(),
      onCopyFilePath: vi.fn(),
      onReloadAgent: vi.fn(),
      onForkAgent: vi.fn(),
      onRenameTab: vi.fn(),
      onCloseTab: vi.fn(),
      onCloseTabsBefore: vi.fn(),
      onCloseTabsAfter: vi.fn(),
      onCloseOtherTabs: vi.fn(),
    });

    expect(entries.filter((entry) => entry.kind === "item").map((entry) => entry.label)).toEqual([
      "Copy resume command",
      "Copy agent id",
      "Fork chat in a new tab",
      "Fork chat in a new workspace",
      "Rename",
      "Close tabs above",
      "Close tabs below",
      "Close other tabs",
      "Reload agent",
      "Close",
    ]);
  });

  it("omits agent copy actions and rename for draft tabs", () => {
    const entries = buildWorkspaceTabMenuEntries({
      surface: "mobile",
      tab: {
        key: "draft_123",
        tabId: "draft_123",
        kind: "draft",
        target: { kind: "draft", draftId: "draft_123" },
      },
      index: 0,
      tabCount: 1,
      menuTestIDBase: "workspace-tab-menu-draft_123",
      onCopyResumeCommand: vi.fn(),
      onCopyAgentId: vi.fn(),
      onCopyTerminalId: vi.fn(),
      onCopyFilePath: vi.fn(),
      onReloadAgent: vi.fn(),
      onForkAgent: vi.fn(),
      onRenameTab: vi.fn(),
      onCloseTab: vi.fn(),
      onCloseTabsBefore: vi.fn(),
      onCloseTabsAfter: vi.fn(),
      onCloseOtherTabs: vi.fn(),
    });

    expect(entries.some((entry) => entry.kind === "item" && entry.label === "Copy agent id")).toBe(
      false,
    );
    expect(entries.some((entry) => entry.kind === "item" && entry.label === "Reload agent")).toBe(
      false,
    );
    expect(entries.some((entry) => entry.kind === "item" && entry.label === "Rename")).toBe(false);
    expect(entries.some((entry) => entry.kind === "separator")).toBe(false);
  });

  it("adds reload tooltip copy for agent tabs", () => {
    const entries = buildWorkspaceTabMenuEntries({
      surface: "desktop",
      tab: createAgentTab(),
      index: 0,
      tabCount: 1,
      menuTestIDBase: "workspace-tab-context-agent_123",
      onCopyResumeCommand: vi.fn(),
      onCopyAgentId: vi.fn(),
      onCopyTerminalId: vi.fn(),
      onCopyFilePath: vi.fn(),
      onReloadAgent: vi.fn(),
      onForkAgent: vi.fn(),
      onRenameTab: vi.fn(),
      onCloseTab: vi.fn(),
      onCloseTabsBefore: vi.fn(),
      onCloseTabsAfter: vi.fn(),
      onCloseOtherTabs: vi.fn(),
    });

    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: "item",
        key: "reload-agent",
        tooltip: "Reload agent to update skills, MCPs or login status.",
      }),
    );
  });

  it("invokes onRenameTab when the rename entry is selected for agent tabs", () => {
    const onRenameTab = vi.fn();
    const tab = createAgentTab();
    const entries = buildWorkspaceTabMenuEntries({
      surface: "desktop",
      tab,
      index: 0,
      tabCount: 1,
      menuTestIDBase: "workspace-tab-context-agent_123",
      onCopyResumeCommand: vi.fn(),
      onCopyAgentId: vi.fn(),
      onCopyTerminalId: vi.fn(),
      onCopyFilePath: vi.fn(),
      onReloadAgent: vi.fn(),
      onForkAgent: vi.fn(),
      onRenameTab,
      onCloseTab: vi.fn(),
      onCloseTabsBefore: vi.fn(),
      onCloseTabsAfter: vi.fn(),
      onCloseOtherTabs: vi.fn(),
    });

    const renameEntry = entries.find((entry) => entry.kind === "item" && entry.label === "Rename");
    if (!renameEntry || renameEntry.kind !== "item") {
      throw new Error("Rename entry missing");
    }
    renameEntry.onSelect();

    expect(onRenameTab).toHaveBeenCalledWith(tab);
  });

  it("includes copy id and rename for terminal tabs", () => {
    const onRenameTab = vi.fn();
    const onCopyTerminalId = vi.fn();
    const terminalTab: WorkspaceTabDescriptor = {
      key: "terminal_abc",
      tabId: "terminal_abc",
      kind: "terminal",
      target: { kind: "terminal", terminalId: "terminal-abc" },
    };
    const entries = buildWorkspaceTabMenuEntries({
      surface: "desktop",
      tab: terminalTab,
      index: 0,
      tabCount: 1,
      menuTestIDBase: "workspace-tab-context-terminal_abc",
      onCopyResumeCommand: vi.fn(),
      onCopyAgentId: vi.fn(),
      onCopyTerminalId,
      onCopyFilePath: vi.fn(),
      onReloadAgent: vi.fn(),
      onForkAgent: vi.fn(),
      onRenameTab,
      onCloseTab: vi.fn(),
      onCloseTabsBefore: vi.fn(),
      onCloseTabsAfter: vi.fn(),
      onCloseOtherTabs: vi.fn(),
    });

    const labels = entries.filter((entry) => entry.kind === "item").map((entry) => entry.label);
    expect(labels[0]).toBe("Copy terminal id");
    expect(labels[1]).toBe("Rename");
    expect(labels).not.toContain("Copy resume command");
    expect(labels).not.toContain("Copy agent id");
    expect(labels).not.toContain("Copy file path");
    expect(labels).not.toContain("Reload agent");

    const copyTerminalIdEntry = entries.find(
      (entry) => entry.kind === "item" && entry.key === "copy-terminal-id",
    );
    if (!copyTerminalIdEntry || copyTerminalIdEntry.kind !== "item") {
      throw new Error("Copy terminal id entry missing");
    }
    copyTerminalIdEntry.onSelect();
    expect(onCopyTerminalId).toHaveBeenCalledWith("terminal-abc");

    const renameEntry = entries.find((entry) => entry.kind === "item" && entry.label === "Rename");
    if (!renameEntry || renameEntry.kind !== "item") {
      throw new Error("Rename entry missing");
    }
    renameEntry.onSelect();
    expect(onRenameTab).toHaveBeenCalledWith(terminalTab);
  });

  it("includes copy file path for file tabs", () => {
    const onCopyFilePath = vi.fn();
    const fileTab: WorkspaceTabDescriptor = {
      key: "file_abc",
      tabId: "file_abc",
      kind: "file",
      target: { kind: "file", path: "/some/path.ts", lineStart: 1, lineEnd: 10 },
    };
    const entries = buildWorkspaceTabMenuEntries({
      surface: "desktop",
      tab: fileTab,
      index: 0,
      tabCount: 1,
      menuTestIDBase: "workspace-tab-context-file_abc",
      onCopyResumeCommand: vi.fn(),
      onCopyAgentId: vi.fn(),
      onCopyTerminalId: vi.fn(),
      onCopyFilePath,
      onReloadAgent: vi.fn(),
      onForkAgent: vi.fn(),
      onRenameTab: vi.fn(),
      onCloseTab: vi.fn(),
      onCloseTabsBefore: vi.fn(),
      onCloseTabsAfter: vi.fn(),
      onCloseOtherTabs: vi.fn(),
    });

    const labels = entries.filter((entry) => entry.kind === "item").map((entry) => entry.label);
    expect(labels[0]).toBe("Copy file path");
    expect(labels).not.toContain("Copy resume command");
    expect(labels).not.toContain("Copy agent id");
    expect(labels).not.toContain("Rename");
    expect(labels).not.toContain("Reload agent");

    const copyFilePathEntry = entries.find(
      (entry) => entry.kind === "item" && entry.key === "copy-file-path",
    );
    if (!copyFilePathEntry || copyFilePathEntry.kind !== "item") {
      throw new Error("Copy file path entry missing");
    }
    copyFilePathEntry.onSelect();
    expect(onCopyFilePath).toHaveBeenCalledWith("/some/path.ts");
  });

  it("uses a Changes close id for the working diff tab", () => {
    const actions = buildWorkspaceDesktopTabActions({
      tab: {
        key: "working_diff_abc",
        tabId: "working_diff_abc",
        kind: "working_diff",
        target: {
          kind: "working_diff",
          focusPath: "src/example.ts",
          focusRequestId: 1,
        },
      },
      index: 0,
      tabCount: 1,
      onCopyResumeCommand: vi.fn(),
      onCopyAgentId: vi.fn(),
      onCopyTerminalId: vi.fn(),
      onCopyFilePath: vi.fn(),
      onReloadAgent: vi.fn(),
      onForkAgent: vi.fn(),
      onRenameTab: vi.fn(),
      onCloseTab: vi.fn(),
      onCloseTabsToLeft: vi.fn(),
      onCloseTabsToRight: vi.fn(),
      onCloseOtherTabs: vi.fn(),
    });

    expect(actions.closeButtonTestId).toMatch(/^workspace-working-diff-close-/);
    expect(actions.menuEntries).not.toContainEqual(
      expect.objectContaining({ kind: "item", key: "copy-file-path" }),
    );
  });

  it("uses the same rename entry shape for agent and terminal tabs", () => {
    const terminalTab: WorkspaceTabDescriptor = {
      key: "terminal_abc",
      tabId: "terminal_abc",
      kind: "terminal",
      target: { kind: "terminal", terminalId: "terminal-abc" },
    };
    const menuTestIDBase = "workspace-tab-context";
    const sharedInput = {
      surface: "desktop" as const,
      index: 0,
      tabCount: 1,
      menuTestIDBase,
      onCopyResumeCommand: vi.fn(),
      onCopyAgentId: vi.fn(),
      onCopyTerminalId: vi.fn(),
      onCopyFilePath: vi.fn(),
      onReloadAgent: vi.fn(),
      onForkAgent: vi.fn(),
      onRenameTab: vi.fn(),
      onCloseTab: vi.fn(),
      onCloseTabsBefore: vi.fn(),
      onCloseTabsAfter: vi.fn(),
      onCloseOtherTabs: vi.fn(),
    };

    const agentEntries = buildWorkspaceTabMenuEntries({ ...sharedInput, tab: createAgentTab() });
    const terminalEntries = buildWorkspaceTabMenuEntries({ ...sharedInput, tab: terminalTab });

    const agentRename = agentEntries.find(
      (entry) => entry.kind === "item" && entry.key === "rename",
    );
    const terminalRename = terminalEntries.find(
      (entry) => entry.kind === "item" && entry.key === "rename",
    );
    if (!agentRename || agentRename.kind !== "item") throw new Error("Agent rename missing");
    if (!terminalRename || terminalRename.kind !== "item")
      throw new Error("Terminal rename missing");

    expect({
      key: agentRename.key,
      label: agentRename.label,
      icon: agentRename.icon,
      testID: agentRename.testID,
    }).toEqual({
      key: terminalRename.key,
      label: terminalRename.label,
      icon: terminalRename.icon,
      testID: terminalRename.testID,
    });

    const agentSeparator = agentEntries
      .slice(agentEntries.indexOf(agentRename) + 1)
      .find((entry) => entry.kind === "separator");
    const terminalSeparator = terminalEntries
      .slice(terminalEntries.indexOf(terminalRename) + 1)
      .find((entry) => entry.kind === "separator");
    expect(agentSeparator?.key).toBe("rename-separator");
    expect(terminalSeparator?.key).toBe("rename-separator");
  });

  it("offers both fork targets for agent tabs and forwards the selected target", () => {
    const onForkAgent = vi.fn();
    const entries = buildWorkspaceTabMenuEntries({
      surface: "desktop",
      tab: createAgentTab(),
      index: 0,
      tabCount: 1,
      menuTestIDBase: "workspace-tab-context-agent_123",
      onCopyResumeCommand: vi.fn(),
      onCopyAgentId: vi.fn(),
      onCopyTerminalId: vi.fn(),
      onCopyFilePath: vi.fn(),
      onReloadAgent: vi.fn(),
      onForkAgent,
      onRenameTab: vi.fn(),
      onCloseTab: vi.fn(),
      onCloseTabsBefore: vi.fn(),
      onCloseTabsAfter: vi.fn(),
      onCloseOtherTabs: vi.fn(),
    });

    const forkTab = entries.find(
      (entry) => entry.kind === "item" && entry.key === "fork-chat-new-tab",
    );
    const forkWorkspace = entries.find(
      (entry) => entry.kind === "item" && entry.key === "fork-chat-new-workspace",
    );
    if (!forkTab || forkTab.kind !== "item") throw new Error("Fork-in-new-tab entry missing");
    if (!forkWorkspace || forkWorkspace.kind !== "item") {
      throw new Error("Fork-in-new-workspace entry missing");
    }

    expect(forkTab.label).toBe("Fork chat in a new tab");
    expect(forkTab.icon).toBe("split");
    expect(forkTab.testID).toBe("workspace-tab-context-agent_123-fork-chat-new-tab");
    expect(forkTab.disabled).toBeUndefined();
    expect(forkWorkspace.label).toBe("Fork chat in a new workspace");
    expect(forkWorkspace.icon).toBe("split");
    expect(forkWorkspace.testID).toBe("workspace-tab-context-agent_123-fork-chat-new-workspace");
    expect(forkWorkspace.disabled).toBeUndefined();

    forkTab.onSelect();
    expect(onForkAgent).toHaveBeenNthCalledWith(1, "agent-123", "tab");
    forkWorkspace.onSelect();
    expect(onForkAgent).toHaveBeenNthCalledWith(2, "agent-123", "workspace");
  });

  it("offers fork entries on mobile agent menus too", () => {
    const onForkAgent = vi.fn();
    const entries = buildWorkspaceTabMenuEntries({
      surface: "mobile",
      tab: createAgentTab(),
      index: 0,
      tabCount: 1,
      menuTestIDBase: "workspace-tab-menu-agent_123",
      onCopyResumeCommand: vi.fn(),
      onCopyAgentId: vi.fn(),
      onCopyTerminalId: vi.fn(),
      onCopyFilePath: vi.fn(),
      onReloadAgent: vi.fn(),
      onForkAgent,
      onRenameTab: vi.fn(),
      onCloseTab: vi.fn(),
      onCloseTabsBefore: vi.fn(),
      onCloseTabsAfter: vi.fn(),
      onCloseOtherTabs: vi.fn(),
    });

    const forkTab = entries.find(
      (entry) => entry.kind === "item" && entry.key === "fork-chat-new-tab",
    );
    if (!forkTab || forkTab.kind !== "item") throw new Error("Fork-in-new-tab entry missing");
    expect(forkTab.testID).toBe("workspace-tab-menu-agent_123-fork-chat-new-tab");
    forkTab.onSelect();
    expect(onForkAgent).toHaveBeenCalledWith("agent-123", "tab");
  });

  it.each([
    [
      "terminal",
      {
        key: "terminal_abc",
        tabId: "terminal_abc",
        kind: "terminal",
        target: { kind: "terminal", terminalId: "terminal-abc" },
      } satisfies WorkspaceTabDescriptor,
    ],
    [
      "file",
      {
        key: "file_abc",
        tabId: "file_abc",
        kind: "file",
        target: { kind: "file", path: "/some/path.ts", lineStart: 1, lineEnd: 10 },
      } satisfies WorkspaceTabDescriptor,
    ],
    [
      "draft",
      {
        key: "draft_123",
        tabId: "draft_123",
        kind: "draft",
        target: { kind: "draft", draftId: "draft_123" },
      } satisfies WorkspaceTabDescriptor,
    ],
    [
      "provider_subagent",
      {
        key: "provider_subagent_x",
        tabId: "provider_subagent_x",
        kind: "provider_subagent",
        target: {
          kind: "provider_subagent",
          parentAgentId: "agent-123",
          subagentId: "subagent-x",
        },
      } satisfies WorkspaceTabDescriptor,
    ],
  ])("omits fork entries for %s tabs", (_kind, tab) => {
    const onForkAgent = vi.fn();
    const entries = buildWorkspaceTabMenuEntries({
      surface: "desktop",
      tab,
      index: 0,
      tabCount: 1,
      menuTestIDBase: "workspace-tab-context",
      onCopyResumeCommand: vi.fn(),
      onCopyAgentId: vi.fn(),
      onCopyTerminalId: vi.fn(),
      onCopyFilePath: vi.fn(),
      onReloadAgent: vi.fn(),
      onForkAgent,
      onRenameTab: vi.fn(),
      onCloseTab: vi.fn(),
      onCloseTabsBefore: vi.fn(),
      onCloseTabsAfter: vi.fn(),
      onCloseOtherTabs: vi.fn(),
    });

    const forkKeys = entries
      .filter((entry) => entry.kind === "item")
      .map((entry) => entry.key)
      .filter((key) => key.startsWith("fork-chat-"));
    expect(forkKeys).toEqual([]);
    expect(onForkAgent).not.toHaveBeenCalled();
  });

  it("forwards onForkAgent through the desktop actions builder", () => {
    const onForkAgent = vi.fn();
    const actions = buildWorkspaceDesktopTabActions({
      tab: createAgentTab(),
      index: 0,
      tabCount: 1,
      onCopyResumeCommand: vi.fn(),
      onCopyAgentId: vi.fn(),
      onCopyTerminalId: vi.fn(),
      onCopyFilePath: vi.fn(),
      onReloadAgent: vi.fn(),
      onForkAgent,
      onRenameTab: vi.fn(),
      onCloseTab: vi.fn(),
      onCloseTabsToLeft: vi.fn(),
      onCloseTabsToRight: vi.fn(),
      onCloseOtherTabs: vi.fn(),
    });

    const forkWorkspace = actions.menuEntries.find(
      (entry) => entry.kind === "item" && entry.key === "fork-chat-new-workspace",
    );
    if (!forkWorkspace || forkWorkspace.kind !== "item") {
      throw new Error("Fork-in-new-workspace entry missing");
    }
    forkWorkspace.onSelect();
    expect(onForkAgent).toHaveBeenCalledWith("agent-123", "workspace");
  });
});
