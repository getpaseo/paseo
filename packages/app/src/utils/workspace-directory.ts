import { normalizeWorkspacePath } from "@/utils/workspace-identity";

export function resolveWorkspaceDirectory(input: {
  workspaceDirectory: string | null | undefined;
}): string | null {
  return normalizeWorkspacePath(input.workspaceDirectory);
}

export function requireWorkspaceDirectory(input: {
  workspaceId?: string;
  workspaceDirectory: string | null | undefined;
}): string {
  const workspaceDirectory = resolveWorkspaceDirectory({
    workspaceDirectory: input.workspaceDirectory,
  });
  if (!workspaceDirectory) {
    throw new Error(
      input.workspaceId
        ? `Workspace directory is missing for workspace ${input.workspaceId}`
        : "Workspace directory is missing.",
    );
  }
  return workspaceDirectory;
}
