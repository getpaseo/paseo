import type { WorkspaceDescriptor } from "@/stores/session-store";

export type WorkspaceArchiveConfirmationKind = "chat" | "worktree" | "none";

// Chat workspaces archive straight to deletion (conversation + scratch files, no
// recovery), so they always get a destructive confirmation regardless of
// workspaceKind. Worktree risk confirmation only applies otherwise.
export function resolveWorkspaceArchiveConfirmationKind(input: {
  isChatWorkspace: boolean;
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
}): WorkspaceArchiveConfirmationKind {
  if (input.isChatWorkspace) {
    return "chat";
  }
  return input.workspaceKind === "worktree" ? "worktree" : "none";
}
