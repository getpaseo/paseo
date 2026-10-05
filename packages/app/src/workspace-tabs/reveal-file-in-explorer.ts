import { buildExplorerRevealKey, resolveExplorerRevealPath } from "@/file-explorer/reveal";
import { useExplorerRevealStore } from "@/file-explorer/reveal-store";
import { buildWorkspaceExplorerStateKey } from "@/hooks/use-file-explorer-actions";
import { openExplorerSidebarView, type ExplorerSidebarInput } from "./explorer-sidebar";

export interface RevealFileInExplorerInput extends ExplorerSidebarInput {
  workspaceId: string;
  /** A file tab path: absolute, or relative to the workspace root. */
  path: string;
}

export type RevealFileInExplorerResult = "revealing" | "outside-workspace" | "unavailable";

/**
 * Shows Explorer on Files and asks its tree to expand to, select, and scroll to the file.
 * Workspace focus stays on the caller's tab. The tree never follows tab changes on its own;
 * this is the only way it moves to a file.
 */
export function revealFileInExplorer(input: RevealFileInExplorerInput): RevealFileInExplorerResult {
  const { checkout } = input;
  const workspaceStateKey = checkout
    ? buildWorkspaceExplorerStateKey({
        workspaceId: input.workspaceId,
        workspaceRoot: checkout.cwd,
      })
    : null;
  if (!checkout || !workspaceStateKey) {
    return "unavailable";
  }
  const path = resolveExplorerRevealPath({ path: input.path, workspaceRoot: checkout.cwd });
  if (!path) {
    return "outside-workspace";
  }
  // Recorded before opening, so a tree that mounts or becomes visible during the open finds it.
  // Rolled back when nothing opened, so it cannot replay on a later, unrelated open.
  const store = useExplorerRevealStore.getState();
  const requestId = store.requestReveal({ serverId: checkout.serverId, workspaceStateKey, path });
  if (!openExplorerSidebarView({ ...input, view: "files" })) {
    store.completeReveal({
      key: buildExplorerRevealKey({ serverId: checkout.serverId, workspaceStateKey }),
      requestId,
    });
    return "unavailable";
  }
  return "revealing";
}
