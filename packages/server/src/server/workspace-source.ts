import { expandTilde } from "../utils/path.js";
import type { ProjectRegistry } from "./workspace-registry.js";

export interface WorktreeWorkspaceSource {
  cwd?: string;
  projectId?: string;
}

export async function resolveWorktreeSourceCwd(
  source: WorktreeWorkspaceSource,
  projectRegistry: Pick<ProjectRegistry, "get">,
): Promise<string> {
  if (source.cwd) {
    return expandTilde(source.cwd);
  }
  if (!source.projectId) {
    throw new Error("cwd or projectId is required for a worktree-backed workspace");
  }

  const project = await projectRegistry.get(source.projectId);
  if (!project || project.archivedAt) {
    throw new Error(`Project not found: ${source.projectId}`);
  }
  return project.rootPath;
}
