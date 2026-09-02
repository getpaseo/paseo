import { describe, expect, it } from "vitest";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { WorkspaceTabLaunchGroup, WorkspaceTabLaunchItem } from "@/workspace-tabs/launcher";
import type { PluginWorkspaceTabTarget, WorkspaceTabTarget } from "@/workspace-tabs/model";
import {
  catalogItemMatchesTab,
  getExplorerSidebarConfigurationItems,
} from "./explorer-sidebar-tab-configuration";

type BuiltInPanelKind = Exclude<WorkspaceTabTarget["kind"], "plugin">;

function builtInItem(id: string, panelKind: BuiltInPanelKind): WorkspaceTabLaunchItem {
  return {
    id,
    label: id,
    disabled: false,
    pluginTarget: null,
    panelKind,
    launch: () => undefined,
  };
}

function pluginItem(id: string, target: PluginWorkspaceTabTarget): WorkspaceTabLaunchItem {
  return {
    id,
    label: id,
    disabled: false,
    panelKind: "plugin",
    pluginTarget: target,
    launch: () => undefined,
  };
}

function tab(target: WorkspaceTabTarget): WorkspaceTabDescriptor {
  return {
    key: `key:${target.kind}`,
    tabId: `tab:${target.kind}`,
    kind: target.kind,
    target,
  };
}

describe("Explorer sidebar tab configuration", () => {
  it("lists Explorer-only built-ins and every Explorer plugin panel", () => {
    const groups: readonly WorkspaceTabLaunchGroup[] = [
      {
        id: "tabs",
        label: null,
        items: [
          builtInItem("changes", "changes_tree"),
          builtInItem("files", "files"),
          builtInItem("terminal", "terminal"),
        ],
      },
      {
        id: "plugin-panels",
        label: null,
        items: [
          pluginItem("plugin:agent-crew:crew", {
            kind: "plugin",
            pluginId: "agent-crew",
            panelId: "crew",
            context: "agent",
            agentId: "agent-1",
          }),
          pluginItem("plugin:review:summary", {
            kind: "plugin",
            pluginId: "review",
            panelId: "summary",
            context: "workspace",
          }),
        ],
      },
      {
        id: "terminal-profiles",
        label: "Terminal profiles",
        items: [builtInItem("terminal-profile:fish", "terminal")],
      },
    ];

    expect(getExplorerSidebarConfigurationItems(groups).map((item) => item.id)).toEqual([
      "changes",
      "files",
      "plugin:agent-crew:crew",
      "plugin:review:summary",
    ]);
  });

  it("matches an agent plugin item only to its exact plugin, panel, context, and agent", () => {
    const item = pluginItem("plugin:agent-crew:crew", {
      kind: "plugin",
      pluginId: "agent-crew",
      panelId: "crew",
      context: "agent",
      agentId: "agent-1",
    });
    const targets: WorkspaceTabTarget[] = [
      {
        kind: "plugin",
        pluginId: "agent-crew",
        panelId: "crew",
        context: "agent",
        agentId: "agent-1",
      },
      {
        kind: "plugin",
        pluginId: "review",
        panelId: "crew",
        context: "agent",
        agentId: "agent-1",
      },
      {
        kind: "plugin",
        pluginId: "agent-crew",
        panelId: "summary",
        context: "agent",
        agentId: "agent-1",
      },
      {
        kind: "plugin",
        pluginId: "agent-crew",
        panelId: "crew",
        context: "workspace",
      },
      {
        kind: "plugin",
        pluginId: "agent-crew",
        panelId: "crew",
        context: "agent",
        agentId: "agent-2",
      },
    ];

    expect(targets.map((target) => catalogItemMatchesTab(item, tab(target)))).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});
