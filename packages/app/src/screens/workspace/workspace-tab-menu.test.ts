import { describe, expect, it, vi } from "vitest";
import { buildWorkspaceTabMenuEntries } from "@/screens/workspace/workspace-tab-menu";
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
      onReloadAgent,
      onRenameTab,
      onCloseTab,
      onCloseTabsBefore,
      onCloseTabsAfter,
      onCloseOtherTabs,
    });

    expect(entries.filter((entry) => entry.kind === "item").map((entry) => entry.label)).toEqual([
      "Copy resume command",
      "Copy agent id",
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
      onReloadAgent: vi.fn(),
      onRenameTab: vi.fn(),
      onCloseTab: vi.fn(),
      onCloseTabsBefore: vi.fn(),
      onCloseTabsAfter: vi.fn(),
      onCloseOtherTabs: vi.fn(),
    });

    expect(entries.filter((entry) => entry.kind === "item").map((entry) => entry.label)).toEqual([
      "Copy resume command",
      "Copy agent id",
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
      onReloadAgent: vi.fn(),
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
      onReloadAgent: vi.fn(),
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
      onReloadAgent: vi.fn(),
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

  it("includes rename as the first entry for terminal tabs", () => {
    const onRenameTab = vi.fn();
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
      onReloadAgent: vi.fn(),
      onRenameTab,
      onCloseTab: vi.fn(),
      onCloseTabsBefore: vi.fn(),
      onCloseTabsAfter: vi.fn(),
      onCloseOtherTabs: vi.fn(),
    });

    const labels = entries.filter((entry) => entry.kind === "item").map((entry) => entry.label);
    expect(labels[0]).toBe("Rename");
    expect(labels).not.toContain("Copy resume command");
    expect(labels).not.toContain("Copy agent id");
    expect(labels).not.toContain("Reload agent");

    const renameEntry = entries.find((entry) => entry.kind === "item" && entry.label === "Rename");
    if (!renameEntry || renameEntry.kind !== "item") {
      throw new Error("Rename entry missing");
    }
    renameEntry.onSelect();
    expect(onRenameTab).toHaveBeenCalledWith(terminalTab);
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
      onReloadAgent: vi.fn(),
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
});
