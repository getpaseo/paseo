import { describe, expect, it } from "vitest";
import { EXPLORER_SIDEBAR_PANE_ID, normalizeLayout } from "@/stores/workspace-layout-actions";
import type { SubagentRow } from "@/subagents/select";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { entityRefs } from "../client-state/refs";
import {
  createSubagentsProjector,
  createWorkspaceTabsProjector,
  NO_PLUGIN_WORKSPACE_TABS,
  readSubagentRow,
  selectWorkspaceTabDescriptors,
  toPluginWorkspaceTab,
} from "./model";

function tab(tabId: string, target: WorkspaceTabTarget) {
  return { tabId, target, createdAt: 1 };
}

function pane(input: { id: string; tabs: ReturnType<typeof tab>[]; focusedTabId: string }) {
  return { kind: "pane", pane: { ...input, tabIds: input.tabs.map((entry) => entry.tabId) } };
}

const agentTab = tab("agent_a", { kind: "agent", agentId: "a" });
const terminalTab = tab("terminal_t", { kind: "terminal", terminalId: "t" });
const fileTab = tab("file_f", { kind: "file", path: "src/index.ts" });
const filesTab = tab("files", { kind: "files" });

function splitLayout(focusedPaneId: string) {
  return normalizeLayout({
    root: {
      kind: "group",
      group: {
        id: "root",
        direction: "horizontal",
        sizes: [0.4, 0.4, 0.2],
        children: [
          pane({ id: "left", tabs: [agentTab, terminalTab], focusedTabId: "terminal_t" }),
          pane({ id: "right", tabs: [fileTab], focusedTabId: "file_f" }),
          pane({ id: EXPLORER_SIDEBAR_PANE_ID, tabs: [filesTab], focusedTabId: "files" }),
        ],
      },
    },
    focusedPaneId,
  });
}

const workspace = entityRefs.workspace("host-1", "ws-1");

describe("selectWorkspaceTabDescriptors", () => {
  it("lists pane tabs in strip order without the explorer, and marks the focused tab", () => {
    const result = selectWorkspaceTabDescriptors({
      layout: splitLayout("left"),
      explorerPaneId: EXPLORER_SIDEBAR_PANE_ID,
    });
    expect(result.tabs.map((entry) => entry.tabId)).toEqual(["agent_a", "terminal_t", "file_f"]);
    expect(result.activeTabId).toBe("terminal_t");
  });

  it("has no active tab while the explorer holds focus", () => {
    const result = selectWorkspaceTabDescriptors({
      layout: splitLayout(EXPLORER_SIDEBAR_PANE_ID),
      explorerPaneId: EXPLORER_SIDEBAR_PANE_ID,
    });
    expect(result.activeTabId).toBeNull();
  });
});

describe("toPluginWorkspaceTab", () => {
  it("names the agent, terminal, provider subagent or path a tab shows", () => {
    const descriptor = (target: WorkspaceTabTarget) => ({
      key: "k",
      tabId: "k",
      kind: target.kind,
      target,
    });
    expect(toPluginWorkspaceTab(workspace, descriptor(agentTab.target))).toMatchObject({
      kind: "agent",
      agent: entityRefs.agent("host-1", "a"),
      terminalId: null,
    });
    expect(toPluginWorkspaceTab(workspace, descriptor(terminalTab.target)).terminalId).toBe("t");
    expect(toPluginWorkspaceTab(workspace, descriptor(fileTab.target)).path).toBe("src/index.ts");
    expect(
      toPluginWorkspaceTab(
        workspace,
        descriptor({ kind: "provider_subagent", parentAgentId: "a", subagentId: "s" }),
      ).providerSubagent,
    ).toEqual({ parentAgent: entityRefs.agent("host-1", "a"), id: "s" });
    expect(
      toPluginWorkspaceTab(
        workspace,
        descriptor({
          kind: "plugin",
          pluginId: "p",
          panelId: "x",
          context: "agent",
          agentId: "a",
        }),
      ).agent,
    ).toBe(entityRefs.agent("host-1", "a"));
  });
});

describe("createWorkspaceTabsProjector", () => {
  it("keeps the list and each tab while nothing changes", () => {
    const project = createWorkspaceTabsProjector(workspace);
    const input = selectWorkspaceTabDescriptors({
      layout: splitLayout("left"),
      explorerPaneId: EXPLORER_SIDEBAR_PANE_ID,
    });
    const first = project(input);
    const again = project(
      selectWorkspaceTabDescriptors({
        layout: splitLayout("left"),
        explorerPaneId: EXPLORER_SIDEBAR_PANE_ID,
      }),
    );
    expect(again).toBe(first);
  });

  it("keeps tab objects across a focus move and replaces only the list", () => {
    const project = createWorkspaceTabsProjector(workspace);
    const left = project(
      selectWorkspaceTabDescriptors({
        layout: splitLayout("left"),
        explorerPaneId: EXPLORER_SIDEBAR_PANE_ID,
      }),
    );
    const right = project(
      selectWorkspaceTabDescriptors({
        layout: splitLayout("right"),
        explorerPaneId: EXPLORER_SIDEBAR_PANE_ID,
      }),
    );
    expect(right).not.toBe(left);
    expect(right.activeTabId).toBe("file_f");
    expect(right.tabs).toBe(left.tabs);
  });

  it("returns the shared empty value for a workspace with no layout", () => {
    const project = createWorkspaceTabsProjector(workspace);
    expect(project(selectWorkspaceTabDescriptors({ layout: null, explorerPaneId: null }))).toBe(
      NO_PLUGIN_WORKSPACE_TABS,
    );
  });
});

function paseoRow(id: string, title: string): SubagentRow {
  return {
    kind: "paseo",
    address: { serverId: "host-1", agentId: id },
    id,
    provider: "claude",
    title,
    description: null,
    subtitle: null,
    status: "running",
    turn: { phase: "idle", cancellationRequestId: null },
    requiresAttention: false,
    createdAt: new Date("2026-11-01T00:00:00Z"),
  };
}

const providerRow: SubagentRow = {
  kind: "provider",
  id: "task-1",
  parentAgentId: "parent",
  provider: "claude",
  title: "Explore",
  description: "Find the bug",
  subtitle: null,
  status: "running",
  requiresAttention: false,
  createdAt: new Date("2026-11-02T00:00:00Z"),
};

describe("createSubagentsProjector", () => {
  it("projects Paseo and provider subagents with their parent", () => {
    const project = createSubagentsProjector("host-1", "parent");
    const [paseo, provider] = project([paseoRow("child", "Child"), providerRow]);
    expect(paseo).toEqual({
      kind: "agent",
      agent: entityRefs.agent("host-1", "child"),
      parentAgent: entityRefs.agent("host-1", "parent"),
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    expect(provider).toMatchObject({
      kind: "provider",
      ref: { parentAgent: entityRefs.agent("host-1", "parent"), id: "task-1" },
      description: "Find the bug",
    });
    expect(readSubagentRow(provider!)?.row).toBe(providerRow);
  });

  it("keeps unchanged subagents and replaces one whose row changed", () => {
    const project = createSubagentsProjector("host-1", "parent");
    const first = project([paseoRow("child", "Child"), providerRow]);
    expect(project([paseoRow("child", "Child"), providerRow])).toBe(first);
    const renamed = project([paseoRow("child", "Renamed"), providerRow]);
    expect(renamed[0]).not.toBe(first[0]);
    expect(renamed[1]).toBe(first[1]);
    expect(readSubagentRow(renamed[0]!)?.row.title).toBe("Renamed");
  });
});
