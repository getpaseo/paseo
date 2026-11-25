import equal from "fast-deep-equal";
import type {
  PluginSubagent,
  PluginWorkspaceTab,
  PluginWorkspaceTabs,
} from "@getpaseo/plugin/client";
import type { WorkspaceRef } from "@getpaseo/plugin/client";
import { getWorkspacePaneDescriptors } from "@/screens/workspace/workspace-pane-state";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { collectAllPanes, collectAllTabs } from "@/stores/workspace-layout-actions";
import type { WorkspaceLayout } from "@/stores/workspace-layout-store";
import type { SubagentRow } from "@/subagents/select";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { entityRefs } from "../client-state/refs";

export const NO_PLUGIN_WORKSPACE_TABS: PluginWorkspaceTabs = Object.freeze({
  tabs: Object.freeze([]),
  activeTabId: null,
});

/**
 * A workspace's open tabs, pane by pane in strip order. The explorer is chrome beside the tab
 * strip and on desktop always holds Files and Changes, so its pane is left out.
 */
export function selectWorkspaceTabDescriptors(input: {
  layout: WorkspaceLayout | null;
  explorerPaneId: string | null;
}): { tabs: WorkspaceTabDescriptor[]; activeTabId: string | null } {
  const { layout, explorerPaneId } = input;
  if (!layout) return { tabs: [], activeTabId: null };
  const allTabs = collectAllTabs(layout.root);
  const panes = collectAllPanes(layout.root).filter((pane) => pane.id !== explorerPaneId);
  const seen = new Set<string>();
  const tabs: WorkspaceTabDescriptor[] = [];
  for (const pane of panes) {
    for (const tab of getWorkspacePaneDescriptors({ pane, tabs: allTabs })) {
      if (seen.has(tab.tabId)) continue;
      seen.add(tab.tabId);
      tabs.push(tab);
    }
  }
  const focusedTabId = panes.find((pane) => pane.id === layout.focusedPaneId)?.focusedTabId;
  return { tabs, activeTabId: focusedTabId && seen.has(focusedTabId) ? focusedTabId : null };
}

export function toPluginWorkspaceTab(
  workspace: WorkspaceRef,
  descriptor: WorkspaceTabDescriptor,
): PluginWorkspaceTab {
  const target = descriptor.target;
  const agentId = targetAgentId(target);
  return Object.freeze({
    id: descriptor.tabId,
    workspace,
    kind: target.kind,
    agent: agentId ? entityRefs.agent(workspace.hostId, agentId) : null,
    terminalId: target.kind === "terminal" ? target.terminalId : null,
    providerSubagent:
      target.kind === "provider_subagent"
        ? Object.freeze({
            parentAgent: entityRefs.agent(workspace.hostId, target.parentAgentId),
            id: target.subagentId,
          })
        : null,
    path: targetPath(target),
  });
}

function targetAgentId(target: WorkspaceTabTarget): string | null {
  if (target.kind === "agent") return target.agentId;
  if (target.kind === "plugin" && target.context === "agent") return target.agentId;
  return null;
}

function targetPath(target: WorkspaceTabTarget): string | null {
  if (target.kind === "file") return target.path;
  if (target.kind === "working_diff") return target.focusPath ?? null;
  return null;
}

/**
 * Keeps each tab's object while it is unchanged, and the list's array while every tab is, so a
 * plugin row keyed by tab re-renders only when its own tab changes.
 */
export function createWorkspaceTabsProjector(workspace: WorkspaceRef) {
  const tabsById = new Map<
    string,
    { descriptor: WorkspaceTabDescriptor; tab: PluginWorkspaceTab }
  >();
  let previous: PluginWorkspaceTabs = NO_PLUGIN_WORKSPACE_TABS;
  return (input: {
    tabs: readonly WorkspaceTabDescriptor[];
    activeTabId: string | null;
  }): PluginWorkspaceTabs => {
    const next: PluginWorkspaceTab[] = [];
    const live = new Set<string>();
    for (const descriptor of input.tabs) {
      live.add(descriptor.tabId);
      const cached = tabsById.get(descriptor.tabId);
      if (cached && equal(cached.descriptor.target, descriptor.target)) {
        next.push(cached.tab);
        continue;
      }
      const tab = toPluginWorkspaceTab(workspace, descriptor);
      tabsById.set(descriptor.tabId, { descriptor, tab });
      next.push(tab);
    }
    for (const id of tabsById.keys()) if (!live.has(id)) tabsById.delete(id);
    const sameTabs =
      next.length === previous.tabs.length && next.every((tab, i) => tab === previous.tabs[i]);
    if (sameTabs && input.activeTabId === previous.activeTabId) return previous;
    if (next.length === 0 && input.activeTabId === null) {
      previous = NO_PLUGIN_WORKSPACE_TABS;
      return previous;
    }
    previous = Object.freeze({
      tabs: sameTabs ? previous.tabs : Object.freeze(next),
      activeTabId: input.activeTabId,
    });
    return previous;
  };
}

/** The app-side row each subagent was projected from, for presentation, menus and opening. */
const subagentRows = new WeakMap<PluginSubagent, { row: SubagentRow; hostId: string }>();

export function readSubagentRow(
  subagent: PluginSubagent,
): { row: SubagentRow; hostId: string } | null {
  return subagentRows.get(subagent) ?? null;
}

export function toPluginSubagent(input: {
  hostId: string;
  parentAgentId: string;
  row: SubagentRow;
}): PluginSubagent {
  const { hostId, parentAgentId, row } = input;
  const parentAgent = entityRefs.agent(hostId, parentAgentId);
  const subagent: PluginSubagent =
    row.kind === "paseo"
      ? Object.freeze({
          kind: "agent",
          agent: entityRefs.agent(row.address.serverId, row.address.agentId),
          parentAgent,
          createdAt: row.createdAt.toISOString(),
        })
      : Object.freeze({
          kind: "provider",
          ref: Object.freeze({ parentAgent, id: row.id }),
          parentAgent,
          provider: row.provider,
          title: row.title,
          description: row.description,
          subtitle: row.subtitle,
          status: row.status,
          requiresAttention: row.requiresAttention,
          createdAt: row.createdAt.toISOString(),
        });
  subagentRows.set(subagent, { row, hostId });
  return subagent;
}

/**
 * Keeps each subagent's object while its row is unchanged. A row change (a title, a status)
 * yields a new object, so a plugin row reading its presentation re-renders with it.
 */
export function createSubagentsProjector(hostId: string, parentAgentId: string) {
  const byKey = new Map<string, { row: SubagentRow; subagent: PluginSubagent }>();
  let previous: readonly PluginSubagent[] = Object.freeze([]);
  return (rows: readonly SubagentRow[]): readonly PluginSubagent[] => {
    const next: PluginSubagent[] = [];
    const live = new Set<string>();
    for (const row of rows) {
      const key = `${row.kind}\0${row.id}`;
      live.add(key);
      const cached = byKey.get(key);
      if (cached && equal(cached.row, row)) {
        next.push(cached.subagent);
        continue;
      }
      const subagent = toPluginSubagent({ hostId, parentAgentId, row });
      byKey.set(key, { row, subagent });
      next.push(subagent);
    }
    for (const key of byKey.keys()) if (!live.has(key)) byKey.delete(key);
    if (next.length === previous.length && next.every((item, i) => item === previous[i])) {
      return previous;
    }
    previous = Object.freeze(next);
    return previous;
  };
}
