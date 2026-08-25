import type { OpenInSidePanePreferences } from "@/hooks/use-settings";
import type { ExplorerCheckoutContext } from "@/stores/explorer-checkout-context";
import {
  openExplorerSidebarView,
  usesCompactExplorerSidebar,
  type ExplorerSidebarView,
} from "@/workspace-tabs/explorer-sidebar";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import {
  openPreferredWorkspaceTarget,
  type OpenInSidePaneSource,
} from "@/workspace-tabs/open-beside";

export type WorkspaceSupportingView = "changes" | "pull-request";

interface SupportingViewRoute {
  explorerView: ExplorerSidebarView;
  target: WorkspaceTabTarget;
  source: OpenInSidePaneSource;
}

const SUPPORTING_VIEW_ROUTES: Record<WorkspaceSupportingView, SupportingViewRoute> = {
  changes: {
    explorerView: "changes",
    target: { kind: "working_diff" },
    source: "changesLinks",
  },
  "pull-request": {
    explorerView: "pr",
    target: { kind: "pull_request" },
    source: "pullRequests",
  },
};

interface OpenWorkspaceSupportingViewInput {
  view: WorkspaceSupportingView;
  isCompact: boolean;
  workspaceKey: string | null;
  checkout: ExplorerCheckoutContext | null;
  preferences: OpenInSidePanePreferences;
  supportsPaneSplits?: boolean;
}

/** Opens supporting workspace content in the shell appropriate for the current layout. */
export function openWorkspaceSupportingView(
  input: OpenWorkspaceSupportingViewInput,
): string | null {
  const route = SUPPORTING_VIEW_ROUTES[input.view];
  if (usesCompactExplorerSidebar(input)) {
    openExplorerSidebarView({
      isCompact: input.isCompact,
      supportsPaneSplits: input.supportsPaneSplits,
      workspaceKey: input.workspaceKey,
      checkout: input.checkout,
      view: route.explorerView,
    });
    return null;
  }
  return openPreferredWorkspaceTarget({
    isCompact: input.isCompact,
    workspaceKey: input.workspaceKey,
    target: route.target,
    source: route.source,
    preferences: input.preferences,
  });
}
