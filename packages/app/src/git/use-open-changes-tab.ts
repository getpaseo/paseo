import { useCallback, useMemo } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { buildReviewDraftScopeKey, useResolvedDiffMode } from "@/review";
import { usePanelStore } from "@/stores/panel-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  buildWorkspaceTabPersistenceKey,
  type WorkspaceWorkingDiffComparison,
} from "@/stores/workspace-tabs-store";

interface UseOpenChangesTabInput {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
}

/**
 * Opens the workspace's Changes tab focused on one file, reusing the tab when it
 * already exists. Shared by the Changes pane and the Files explorer so the "Open
 * in Changes tab" action behaves identically in both kebab menus.
 *
 * Returns undefined when the checkout can't produce a Changes tab (not a git
 * repo, no persistence key, or a base comparison with no base ref), which lets
 * callers drop the action from the menu instead of offering a no-op.
 */
export function useOpenChangesTab({
  serverId,
  workspaceId,
  cwd,
}: UseOpenChangesTabInput): ((path: string) => void) | undefined {
  const isMobile = useIsCompactFormFactor();
  const { preferences } = useChangesPreferences();
  const ignoreWhitespace = preferences.hideWhitespace;
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const openWorkspaceTabFocused = useWorkspaceLayoutStore((state) => state.openTabFocused);
  const { status } = useCheckoutStatusQuery({ serverId, cwd });
  const gitStatus = status && status.isGit ? status : null;
  const baseRef = gitStatus?.baseRef ?? undefined;
  const persistenceKey = useMemo(
    () => buildWorkspaceTabPersistenceKey({ serverId, workspaceId: workspaceId ?? cwd }),
    [cwd, serverId, workspaceId],
  );
  const scopeKey = useMemo(
    () => buildReviewDraftScopeKey({ serverId, workspaceId, cwd, baseRef, ignoreWhitespace }),
    [baseRef, cwd, ignoreWhitespace, serverId, workspaceId],
  );
  const mode = useResolvedDiffMode({
    scopeKey,
    hasUncommittedChanges: Boolean(gitStatus?.isDirty),
  });

  // A base comparison without a base ref has nothing to compare against.
  const comparison = useMemo<WorkspaceWorkingDiffComparison | null>(() => {
    if (mode === "base") {
      return baseRef ? { mode: "base", baseRef } : null;
    }
    return { mode: "uncommitted", baseRef: baseRef ?? null };
  }, [baseRef, mode]);

  const openChangesTab = useCallback(
    (path: string) => {
      if (!persistenceKey || !comparison) {
        return;
      }
      const tabId = openWorkspaceTabFocused(persistenceKey, {
        kind: "working_diff",
        focusPath: path,
        focusRequestId: Date.now(),
        ignoreWhitespace,
        ...comparison,
      });
      if (tabId && isMobile) {
        showMobileAgent();
      }
    },
    [
      comparison,
      ignoreWhitespace,
      isMobile,
      openWorkspaceTabFocused,
      persistenceKey,
      showMobileAgent,
    ],
  );

  if (!gitStatus || !persistenceKey || !comparison) {
    return undefined;
  }
  return openChangesTab;
}
