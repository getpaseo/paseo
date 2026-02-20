import type { ProjectPlacementPayload } from "@server/shared/messages";
import { deriveProjectKey, deriveProjectName } from "@/utils/agent-grouping";

function normalizeWorkingDirectory(cwd: string): string {
  const trimmed = cwd.trim();
  return trimmed.length > 0 ? trimmed : ".";
}

export function deriveProjectPlacementFromCwd(cwd: string): ProjectPlacementPayload {
  const normalizedCwd = normalizeWorkingDirectory(cwd);
  const projectKey = deriveProjectKey(normalizedCwd);

  return {
    projectKey,
    projectName: deriveProjectName(projectKey),
    checkout: {
      cwd: normalizedCwd,
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    },
  };
}

export function resolveProjectPlacement(input: {
  projectPlacement: ProjectPlacementPayload | null | undefined;
  cwd: string;
}): ProjectPlacementPayload {
  return input.projectPlacement ?? deriveProjectPlacementFromCwd(input.cwd);
}
