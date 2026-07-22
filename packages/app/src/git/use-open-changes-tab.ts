import { useCallback, useMemo } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { buildReviewDraftScopeKey, useResolvedDiffMode } from "@/review";
import { usePanelStore } from "@/stores/panel-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  buildWorkspaceTabPersistenceKey,
  type WorkspaceWorkingDiffTabTarget,
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

  const openChangesTab = useCallback(
    (path: string) => {
      if (!persistenceKey) {
        return;
      }
      const focusRequestId = Date.now();
      let target: WorkspaceWorkingDiffTabTarget;
      if (mode === "base") {
        if (!baseRef) {
          return;
        }
        target = {
          kind: "working_diff",
          focusPath: path,
          focusRequestId,
          mode: "base",
          baseRef,
          ignoreWhitespace,
        };
      } else {
        target = {
          kind: "working_diff",
          focusPath: path,
          focusRequestId,
          mode: "uncommitted",
          baseRef: baseRef ?? null,
          ignoreWhitespace,
        };
      }
      const tabId = openWorkspaceTabFocused(persistenceKey, target);
      if (tabId && isMobile) {
        showMobileAgent();
      }
    },
    [
      baseRef,
      ignoreWhitespace,
      isMobile,
      mode,
      openWorkspaceTabFocused,
      persistenceKey,
      showMobileAgent,
    ],
  );

  if (!gitStatus || !persistenceKey || (mode === "base" && !baseRef)) {
    return undefined;
  }
  return openChangesTab;
}
