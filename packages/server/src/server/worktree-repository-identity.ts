import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { ProjectRegistry } from "./workspace-registry.js";

export interface WorktreeRepositoryIdentityInput {
  projectId?: string;
  repoRoot?: string;
}

export interface ResolvedWorktreeRepository {
  projectId: string;
  repoRoot: string;
}

/**
 * Resolves a worktree command to one active daemon-owned project. Request paths
 * must already be absolute roots on this host, so a remote caller cannot smuggle
 * its own current directory into a Git mutation.
 */
export async function resolveWorktreeRepositoryIdentity(
  input: WorktreeRepositoryIdentityInput,
  projectRegistry: Pick<ProjectRegistry, "get" | "list">,
): Promise<ResolvedWorktreeRepository> {
  if (!input.projectId && !input.repoRoot) {
    throw new Error("projectId or repoRoot is required for a worktree command");
  }

  const project = input.projectId ? await projectRegistry.get(input.projectId) : null;
  if (input.projectId && (!project || project.archivedAt)) {
    throw new Error(`Project not found: ${input.projectId}`);
  }

  if (project) {
    const repoRoot = canonicalizeExistingRoot(project.rootPath);
    if (!repoRoot) {
      throw new Error(`Project root is unavailable: ${project.rootPath}`);
    }
    if (input.repoRoot) {
      const requestedRoot = canonicalizeExistingRoot(input.repoRoot);
      if (!requestedRoot || requestedRoot !== repoRoot) {
        throw new Error("projectId and repoRoot do not identify the same project");
      }
    }
    return { projectId: project.projectId, repoRoot };
  }

  const projects = (await projectRegistry.list()).filter(
    (candidate) => candidate.archivedAt === null,
  );
  const lexicalMatches = projects.filter((candidate) => candidate.rootPath === input.repoRoot);
  if (lexicalMatches.length === 1) {
    const matchingProject = lexicalMatches[0]!;
    const repoRoot = canonicalizeExistingRoot(matchingProject.rootPath);
    if (!repoRoot) {
      throw new Error(`Project root is unavailable: ${matchingProject.rootPath}`);
    }
    return { projectId: matchingProject.projectId, repoRoot };
  }
  if (lexicalMatches.length > 1) {
    throw new Error("repoRoot identifies multiple active daemon projects; specify projectId");
  }

  const requestedRoot = canonicalizeExistingRoot(input.repoRoot!);
  if (!requestedRoot) {
    throw new Error("repoRoot must be an existing absolute path on the daemon host");
  }
  const canonicalMatches = projects.filter(
    (candidate) => canonicalizeExistingRoot(candidate.rootPath) === requestedRoot,
  );
  if (canonicalMatches.length === 0) {
    throw new Error("repoRoot does not identify an active daemon project");
  }
  if (canonicalMatches.length > 1) {
    throw new Error("repoRoot identifies multiple active daemon projects; specify projectId");
  }
  const matchingProject = canonicalMatches[0]!;
  return { projectId: matchingProject.projectId, repoRoot: requestedRoot };
}

export function canonicalizeExistingRoot(value: string): string | null {
  if (!isAbsolute(value)) return null;
  try {
    return stripTrailingSeparators(realpathSync.native(resolve(value)));
  } catch {
    return null;
  }
}

function stripTrailingSeparators(value: string): string {
  let normalized = value;
  while (normalized.length > 1 && normalized.endsWith(sep)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}
