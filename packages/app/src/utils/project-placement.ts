import type { ProjectPlacementPayload } from "@getpaseo/protocol/messages";
import { deriveProjectKey, deriveProjectName } from "@/utils/agent-grouping";

function normalizeWorkingDirectory(cwd: string): string {
  const trimmed = cwd.trim();
  return trimmed.length > 0 ? trimmed : ".";
}

/**
 * Stand-in placement for agents the daemon sent without one. `worktreesRoot` is
 * `server_info.worktreesRoot`; without it a worktree cwd cannot be told from a checkout.
 */
export function deriveProjectPlacementFromCwd(
  cwd: string,
  worktreesRoot?: string | null,
): ProjectPlacementPayload {
  const normalizedCwd = normalizeWorkingDirectory(cwd);
  const projectKey = deriveProjectKey(normalizedCwd, worktreesRoot);

  return {
    projectKey,
    projectName: deriveProjectName(projectKey),
    workspaceName: null,
    checkout: {
      cwd: normalizedCwd,
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    },
  };
}

export function resolveProjectPlacement(input: {
  projectPlacement: ProjectPlacementPayload | null | undefined;
  cwd: string;
  worktreesRoot?: string | null;
}): ProjectPlacementPayload {
  return input.projectPlacement ?? deriveProjectPlacementFromCwd(input.cwd, input.worktreesRoot);
}
