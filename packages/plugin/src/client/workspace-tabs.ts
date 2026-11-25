import type { ComponentType } from "react";
import type { WorkspaceIndicator } from "../contracts.js";
import type { AgentRef, WorkspaceRef } from "../refs.js";

/** What a tab shows. New kinds can appear; render an unknown kind with its presentation. */
export type PluginWorkspaceTabKind =
  | "agent"
  | "provider_subagent"
  | "terminal"
  | "browser"
  | "file"
  | "working_diff"
  | "changes_tree"
  | "files"
  | "pull_request"
  | "draft"
  | "new_tab"
  | "plugin"
  | "setup"
  | "commit_diff"
  | (string & {});

/** A provider-run subagent (a Claude Code task, a Codex thread) that is not a Paseo agent. */
export interface PluginProviderSubagentRef {
  readonly parentAgent: AgentRef;
  readonly id: string;
}

/** One open tab in a workspace. The same tab keeps the same object while it is unchanged. */
export interface PluginWorkspaceTab {
  /** Unique within the workspace, and stable across launches. */
  readonly id: string;
  readonly workspace: WorkspaceRef;
  readonly kind: PluginWorkspaceTabKind;
  /** The agent an agent tab or an agent's plugin panel shows; otherwise null. */
  readonly agent: AgentRef | null;
  /** Set for terminal tabs; read the terminal with `useTerminal`. */
  readonly terminalId: string | null;
  /** Set for provider subagent tabs. */
  readonly providerSubagent: PluginProviderSubagentRef | null;
  /** Workspace-relative path for file and diff tabs. */
  readonly path: string | null;
}

export interface PluginWorkspaceTabs {
  /** Pane by pane in strip order. The explorer's Files and Changes tabs are left out. */
  readonly tabs: readonly PluginWorkspaceTab[];
  /** The tab the workspace shows when it opens. */
  readonly activeTabId: string | null;
}

/** A subagent of an agent, as the agent's subagents track lists it, oldest first. */
export type PluginSubagent =
  | {
      readonly kind: "agent";
      readonly agent: AgentRef;
      readonly parentAgent: AgentRef;
      readonly createdAt: string;
    }
  | {
      readonly kind: "provider";
      readonly ref: PluginProviderSubagentRef;
      readonly parentAgent: AgentRef;
      readonly provider: string;
      /** The subagent type, which repeats across a fan-out. */
      readonly title: string | null;
      /** The task it was given. Prefer it over `title` to name a row. */
      readonly description: string | null;
      readonly subtitle: string | null;
      readonly status: string;
      readonly requiresAttention: boolean;
      readonly createdAt: string;
    };

export interface PluginTabIconProps {
  size: number;
  color: string;
  strokeWidth?: number;
}

/** How Paseo draws a tab or a subagent row in its own tab strip. */
export interface PluginTabPresentation {
  readonly label: string;
  readonly subtitle: string;
  readonly tooltip: string;
  /** The tab has unsaved changes. */
  readonly modified: boolean;
  /** The label is a placeholder until the title loads. */
  readonly loading: boolean;
  /** The agent status dot Paseo draws on the icon, or null when it draws none. */
  readonly indicator: WorkspaceIndicator | null;
  readonly Icon: ComponentType<PluginTabIconProps>;
}

export interface PluginTabMenuProps {
  tab: PluginWorkspaceTab;
  /** Names the trigger for accessibility. Defaults to the tab's label. */
  label?: string;
  testID?: string;
}

export interface PluginSubagentMenuProps {
  subagent: PluginSubagent;
  /** The workspace whose list shows the row. Close looks there first, then in the subagent's own. */
  workspace: WorkspaceRef;
  label?: string;
  testID?: string;
}
