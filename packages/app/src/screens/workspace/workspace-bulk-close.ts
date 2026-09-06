import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { i18n } from "@/i18n/i18next";

export interface BulkClosableTabGroups {
  archiveAgentTabs: Array<{ tabId: string; agentId: string }>;
  layoutOnlyAgentTabs: Array<{ tabId: string; agentId: string }>;
  terminalTabs: Array<{ tabId: string; terminalId: string }>;
  otherTabs: Array<{ tabId: string; target: WorkspaceTabDescriptor["target"] }>;
}

export interface BulkCloseConfirmationLabels {
  all: (input: { agents: number; terminals: number; tabs: number }) => string;
  agentsAndTerminals: (input: { agents: number; terminals: number }) => string;
  terminalsAndTabs: (input: { terminals: number; tabs: number }) => string;
  agentsAndTabs: (input: { agents: number; tabs: number }) => string;
  terminals: (input: { terminals: number }) => string;
  tabs: (input: { tabs: number }) => string;
  agents: (input: { agents: number }) => string;
}

export const DEFAULT_BULK_CLOSE_CONFIRMATION_LABELS: BulkCloseConfirmationLabels = {
  all: ({ agents, terminals, tabs }) =>
    `This will archive ${agents} agent(s), close ${terminals} terminal(s), and close ${tabs} tab(s). Any running process in a closed terminal will be stopped immediately.`,
  agentsAndTerminals: ({ agents, terminals }) =>
    `This will archive ${agents} agent(s) and close ${terminals} terminal(s). Any running process in a closed terminal will be stopped immediately.`,
  terminalsAndTabs: ({ terminals, tabs }) =>
    `This will close ${terminals} terminal(s) and close ${tabs} tab(s). Any running process in a closed terminal will be stopped immediately.`,
  agentsAndTabs: ({ agents, tabs }) =>
    `This will archive ${agents} agent(s) and close ${tabs} tab(s).`,
  terminals: ({ terminals }) =>
    `This will close ${terminals} terminal(s). Any running process in a closed terminal will be stopped immediately.`,
  tabs: ({ tabs }) => `This will close ${tabs} tab(s).`,
  agents: ({ agents }) => `This will archive ${agents} agent(s).`,
};

export type BulkCloseSelection = "before" | "after" | "others";

interface SelectBulkCloseTabsInput {
  tabs: WorkspaceTabDescriptor[];
  anchorTabId: string;
  selection: BulkCloseSelection;
}

export function selectBulkCloseTabs(input: SelectBulkCloseTabsInput): WorkspaceTabDescriptor[] {
  const { tabs, anchorTabId, selection } = input;
  const anchorIndex = tabs.findIndex((tab) => tab.tabId === anchorTabId);
  if (anchorIndex < 0) {
    return [];
  }

  let candidates: WorkspaceTabDescriptor[];
  if (selection === "before") {
    candidates = tabs.slice(0, anchorIndex);
  } else if (selection === "after") {
    candidates = tabs.slice(anchorIndex + 1);
  } else {
    candidates = tabs.filter((tab) => tab.tabId !== anchorTabId);
  }
  return candidates.filter((tab) => tab.isPinned !== true);
}

interface BulkCloseTabsRequest {
  tabsToClose: WorkspaceTabDescriptor[];
  title: string;
  logLabel: string;
}

interface WorkspaceTabBulkCloseLabels {
  beforeTitle: string;
  afterTitle: string;
  othersTitle: string;
}

interface CreateWorkspaceTabBulkCloseActionsInput {
  closeTabs: (input: BulkCloseTabsRequest) => Promise<boolean>;
  labels: WorkspaceTabBulkCloseLabels;
}

export interface WorkspaceTabBulkCloseActions {
  closeTabsBefore: (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => Promise<void>;
  closeTabsAfter: (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => Promise<void>;
  closeOtherTabs: (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => Promise<void>;
}

interface CloseSelectedTabsInput {
  selection: BulkCloseSelection;
  tabId: string;
  paneTabs: WorkspaceTabDescriptor[];
}

export function createWorkspaceTabBulkCloseActions(
  input: CreateWorkspaceTabBulkCloseActionsInput,
): WorkspaceTabBulkCloseActions {
  const titles: Record<BulkCloseSelection, string> = {
    before: input.labels.beforeTitle,
    after: input.labels.afterTitle,
    others: input.labels.othersTitle,
  };
  const logLabels: Record<BulkCloseSelection, string> = {
    before: "to the left",
    after: "to the right",
    others: "from close other tabs",
  };
  async function closeSelectedTabs(args: CloseSelectedTabsInput): Promise<void> {
    const { selection, tabId, paneTabs } = args;
    await input.closeTabs({
      tabsToClose: selectBulkCloseTabs({ tabs: paneTabs, anchorTabId: tabId, selection }),
      title: titles[selection],
      logLabel: logLabels[selection],
    });
  }

  return {
    closeTabsBefore: (tabId, paneTabs) =>
      closeSelectedTabs({ selection: "before", tabId, paneTabs }),
    closeTabsAfter: (tabId, paneTabs) => closeSelectedTabs({ selection: "after", tabId, paneTabs }),
    closeOtherTabs: (tabId, paneTabs) =>
      closeSelectedTabs({ selection: "others", tabId, paneTabs }),
  };
}

interface CloseWorkspaceTabWithCleanupInput {
  tabId: string;
  target?: WorkspaceTabDescriptor["target"];
}

interface CloseBulkWorkspaceTabsInput {
  client: Pick<DaemonClient, "closeItems"> | null;
  groups: BulkClosableTabGroups;
  closeTab: (tabId: string, action: () => Promise<void>) => Promise<void>;
  closeWorkspaceTabWithCleanup: (input: CloseWorkspaceTabWithCleanupInput) => void;
  closeLayoutOnlyAgent: (agentId: string) => Promise<void>;
  logLabel: string;
  warn?: (message: string, payload: object) => void;
}

export function classifyBulkClosableTabs(
  tabs: WorkspaceTabDescriptor[],
  resolveAgentCloseKind: (agentId: string) => "archive" | "layout-only" = () => "archive",
): BulkClosableTabGroups {
  const groups: BulkClosableTabGroups = {
    archiveAgentTabs: [],
    layoutOnlyAgentTabs: [],
    terminalTabs: [],
    otherTabs: [],
  };

  for (const tab of tabs) {
    if (tab.target.kind === "agent") {
      const agentTab = { tabId: tab.tabId, agentId: tab.target.agentId };
      if (resolveAgentCloseKind(tab.target.agentId) === "layout-only") {
        groups.layoutOnlyAgentTabs.push(agentTab);
      } else {
        groups.archiveAgentTabs.push(agentTab);
      }
      continue;
    }
    if (tab.target.kind === "terminal") {
      groups.terminalTabs.push({ tabId: tab.tabId, terminalId: tab.target.terminalId });
      continue;
    }
    groups.otherTabs.push({ tabId: tab.tabId, target: tab.target });
  }

  return groups;
}

export function buildBulkCloseConfirmationMessage(
  input: BulkClosableTabGroups,
  labels: BulkCloseConfirmationLabels = DEFAULT_BULK_CLOSE_CONFIRMATION_LABELS,
): string {
  const { archiveAgentTabs, layoutOnlyAgentTabs, terminalTabs, otherTabs } = input;
  const tabCount = layoutOnlyAgentTabs.length + otherTabs.length;
  if (archiveAgentTabs.length > 0 && terminalTabs.length > 0 && tabCount > 0) {
    return labels.all({
      agents: archiveAgentTabs.length,
      terminals: terminalTabs.length,
      tabs: tabCount,
    });
  }
  if (archiveAgentTabs.length > 0 && terminalTabs.length > 0) {
    return labels.agentsAndTerminals({
      agents: archiveAgentTabs.length,
      terminals: terminalTabs.length,
    });
  }
  if (terminalTabs.length > 0 && tabCount > 0) {
    return labels.terminalsAndTabs({
      terminals: terminalTabs.length,
      tabs: tabCount,
    });
  }
  if (archiveAgentTabs.length > 0 && tabCount > 0) {
    return labels.agentsAndTabs({
      agents: archiveAgentTabs.length,
      tabs: tabCount,
    });
  }
  if (terminalTabs.length > 0) {
    return labels.terminals({ terminals: terminalTabs.length });
  }
  if (tabCount > 0) {
    return labels.tabs({ tabs: tabCount });
  }
  return labels.agents({ agents: archiveAgentTabs.length });
}

export async function closeBulkWorkspaceTabs(input: CloseBulkWorkspaceTabsInput): Promise<void> {
  const {
    client,
    groups,
    closeTab,
    closeWorkspaceTabWithCleanup,
    closeLayoutOnlyAgent,
    logLabel,
    warn,
  } = input;
  const hasDestructiveTabs = groups.archiveAgentTabs.length > 0 || groups.terminalTabs.length > 0;

  for (const { tabId, agentId } of groups.layoutOnlyAgentTabs) {
    await closeTab(tabId, async () => {
      try {
        await closeLayoutOnlyAgent(agentId);
      } catch (error) {
        warn?.(`[WorkspaceScreen] Failed to close subagent tab ${logLabel}`, { error, agentId });
        return;
      }
      closeWorkspaceTabWithCleanup({
        tabId,
        target: { kind: "agent", agentId },
      });
    });
  }

  if (hasDestructiveTabs && client) {
    void client
      .closeItems({
        agentIds: groups.archiveAgentTabs.map((tab) => tab.agentId),
        terminalIds: groups.terminalTabs.map((tab) => tab.terminalId),
      })
      .catch((error) => {
        warn?.(`[WorkspaceScreen] Failed to bulk close tabs ${logLabel}`, { error });
      });
  } else if (hasDestructiveTabs) {
    warn?.(`[WorkspaceScreen] Failed to bulk close tabs ${logLabel}`, {
      error: new Error(i18n.t("common.errors.daemonClientUnavailable")),
    });
  }

  await Promise.all([
    ...groups.archiveAgentTabs.map(({ tabId, agentId }) =>
      closeTab(tabId, async () => {
        closeWorkspaceTabWithCleanup({
          tabId,
          target: { kind: "agent", agentId },
        });
      }),
    ),
    ...groups.terminalTabs.map(({ tabId, terminalId }) =>
      closeTab(tabId, async () => {
        closeWorkspaceTabWithCleanup({
          tabId,
          target: { kind: "terminal", terminalId },
        });
      }),
    ),
    ...groups.otherTabs.map(({ tabId, target }) =>
      closeTab(tabId, async () => {
        closeWorkspaceTabWithCleanup({ tabId, target });
      }),
    ),
  ]);
}
