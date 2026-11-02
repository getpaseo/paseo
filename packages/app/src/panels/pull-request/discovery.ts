import { useEffect } from "react";
import { useIsMobilePanelActive } from "@/mobile-panels/provider";
import { shouldDiscoverPullRequest } from "./activity";
import { useCheckoutPrStatusQuery } from "@/git/use-pr-status-query";
import { useSettings } from "@/hooks/use-settings";
import {
  useWorkspaceLayoutStore,
  useWorkspaceLayoutStoreHydrated,
} from "@/stores/workspace-layout-store";
import { autoOpenWorkspacePullRequest } from "@/workspace-tabs/open-supporting-view";
import { getPullRequestIdentity } from "./state";
/** Workspace discovery remains independent from whether an ordinary PR tab exists. */
export function useWorkspacePullRequestDiscovery(input: {
  workspaceKey: string | null;
  serverId: string;
  cwd: string | null;
  workspaceActive: boolean;
  isGit: boolean;
  layoutMode: "compact" | "single-pane" | "split-panes";
  explorerOpen: boolean;
}): boolean {
  const settledExplorerActive = useIsMobilePanelActive("file-explorer");
  const enabled = shouldDiscoverPullRequest({
    workspaceActive: input.workspaceActive,
    isGit: input.isGit,
    splitLayout: input.layoutMode === "split-panes",
    explorerActive: input.layoutMode === "compact" ? settledExplorerActive : input.explorerOpen,
  });
  const hasPullRequest = useHasPullRequest({ serverId: input.serverId, cwd: input.cwd, enabled });
  usePullRequestAutoAdd({ workspaceKey: input.workspaceKey, hasPullRequest, enabled });
  return hasPullRequest;
}

/**
 * Whether this workspace's branch has a pull request.
 */
export function useHasPullRequest(input: {
  serverId: string;
  cwd: string | null;
  enabled: boolean;
}): boolean {
  const status = useCheckoutPrStatusQuery({
    serverId: input.serverId,
    cwd: input.cwd || "",
    enabled: input.enabled,
  }).status;
  return getPullRequestIdentity(status) !== null;
}

/** Connects desktop PR detection to the persisted layout after hydration. */
export function usePullRequestAutoAdd(input: {
  workspaceKey: string | null;
  hasPullRequest: boolean;
  enabled: boolean;
}): void {
  const hydrated = useWorkspaceLayoutStoreHydrated();
  const preferredDestination = useSettings((settings) => settings.pullRequestOpenLocation);
  const splitLayout = useWorkspaceLayoutStore((state) => state.layoutMode === "split-panes");
  const destination = splitLayout ? preferredDestination : "explorer";
  useEffect(() => {
    if (hydrated && input.enabled && input.hasPullRequest) {
      autoOpenWorkspacePullRequest({ workspaceKey: input.workspaceKey, destination });
    }
  }, [hydrated, input.enabled, input.hasPullRequest, input.workspaceKey, destination]);
}
