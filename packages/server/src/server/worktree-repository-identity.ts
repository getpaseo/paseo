import { realpathSync } from "node:fs";
import { isAbsolute, parse, resolve, sep } from "node:path";
import type { ProjectRegistry, WorkspaceRegistry } from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";

export interface WorktreeRepositoryIdentityInput {
  projectId?: string;
  repoRoot?: string;
  cwd?: string;
  worktreePath?: string;
}

export interface ResolvedWorktreeRepository {
  projectId: string;
  repoRoot: string;
}

export interface LegacyWorktreeRepositoryIdentityDependencies {
  workspaceRegistry: Pick<WorkspaceRegistry, "list">;
  workspaceGitService: Pick<WorkspaceGitService, "listWorktrees">;
}

/**
 * Resolves a worktree command to one active daemon-owned project. Request paths
 * must already be absolute roots on this host, so a remote caller cannot smuggle
 * its own current directory into a Git mutation.
 */
export async function resolveWorktreeRepositoryIdentity(
  input: WorktreeRepositoryIdentityInput,
  projectRegistry: Pick<ProjectRegistry, "get" | "list">,
  legacyDependencies?: LegacyWorktreeRepositoryIdentityDependencies,
): Promise<ResolvedWorktreeRepository> {
  if (!input.projectId && !input.repoRoot) {
    const legacyPath = input.cwd ?? input.worktreePath;
    if (!legacyPath) {
      throw new Error(
        "projectId, repoRoot, cwd, or worktreePath is required for a worktree command",
      );
    }
    if (!legacyDependencies) {
      throw new Error("Legacy worktree repository resolution is unavailable");
    }
    return resolveLegacyWorktreeRepositoryIdentity(legacyPath, projectRegistry, legacyDependencies);
  }

  return resolveRegisteredWorktreeRepositoryIdentity(input, projectRegistry);
}

async function resolveRegisteredWorktreeRepositoryIdentity(
  input: WorktreeRepositoryIdentityInput,
  projectRegistry: Pick<ProjectRegistry, "get" | "list">,
): Promise<ResolvedWorktreeRepository> {
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

async function resolveLegacyWorktreeRepositoryIdentity(
  legacyPath: string,
  projectRegistry: Pick<ProjectRegistry, "list">,
  dependencies: LegacyWorktreeRepositoryIdentityDependencies,
): Promise<ResolvedWorktreeRepository> {
  // COMPAT(legacyWorktreeRepositoryPaths): added in v0.2.6 on 2026-08-01;
  // remove after 2027-02-01 once supported clients send repository identity.
  const requestedPath = canonicalizeExistingRoot(legacyPath);
  if (!requestedPath) {
    throw new Error(
      "Legacy cwd or worktreePath must be an existing absolute path on the daemon host",
    );
  }

  const projects = (await projectRegistry.list())
    .filter((project) => project.archivedAt === null)
    .map((project) => ({ project, repoRoot: canonicalizeExistingRoot(project.rootPath) }))
    .filter(
      (entry): entry is { project: (typeof entry)["project"]; repoRoot: string } =>
        entry.repoRoot !== null,
    );
  const lexicalProjectMatches = projects.filter(({ project }) => project.rootPath === legacyPath);
  if (lexicalProjectMatches.length === 1) {
    const match = lexicalProjectMatches[0]!;
    return { projectId: match.project.projectId, repoRoot: match.repoRoot };
  }
  const canonicalProjectMatches = projects.filter(({ repoRoot }) => repoRoot === requestedPath);
  if (canonicalProjectMatches.length === 1) {
    const match = canonicalProjectMatches[0]!;
    return { projectId: match.project.projectId, repoRoot: match.repoRoot };
  }
  if (lexicalProjectMatches.length > 1 || canonicalProjectMatches.length > 1) {
    throw new Error("Legacy path identifies multiple active daemon projects");
  }

  const projectsById = new Map(projects.map((entry) => [entry.project.projectId, entry]));
  const workspaceProjectIds = new Set(
    (await dependencies.workspaceRegistry.list())
      .filter(
        (workspace) =>
          workspace.archivedAt === null &&
          [workspace.cwd, workspace.worktreeRoot]
            .filter((path): path is string => path !== null)
            .some((path) => canonicalizeExistingRoot(path) === requestedPath),
      )
      .map((workspace) => workspace.projectId)
      .filter((projectId) => projectsById.has(projectId)),
  );
  const worktreeOwners = new Map<string, (typeof projects)[number]>();
  await Promise.all(
    projects.map(async (entry) => {
      try {
        const worktrees = await dependencies.workspaceGitService.listWorktrees(entry.repoRoot, {
          force: true,
          reason: "legacy-worktree-repository-identity",
        });
        if (
          worktrees.some((worktree) => canonicalizeExistingRoot(worktree.path) === requestedPath)
        ) {
          worktreeOwners.set(entry.project.projectId, entry);
        }
      } catch {
        // An unavailable registered project cannot establish ownership of the caller's path.
      }
    }),
  );
  const exactOwnerProjectIds = new Set([...workspaceProjectIds, ...worktreeOwners.keys()]);
  if (exactOwnerProjectIds.size === 1) {
    const match = projectsById.get([...exactOwnerProjectIds][0]!)!;
    return { projectId: match.project.projectId, repoRoot: match.repoRoot };
  }
  if (exactOwnerProjectIds.size > 1) {
    throw new Error("Legacy path has conflicting exact workspace or worktree owners");
  }

  const containingProjectMatches = projects.filter(({ repoRoot }) =>
    requestedPath.startsWith(repoRoot.endsWith(sep) ? repoRoot : `${repoRoot}${sep}`),
  );
  const deepestRootLength = Math.max(
    0,
    ...containingProjectMatches.map(({ repoRoot }) => repoRoot.length),
  );
  const deepestProjectMatches = containingProjectMatches.filter(
    ({ repoRoot }) => repoRoot.length === deepestRootLength,
  );
  if (deepestProjectMatches.length === 1) {
    const match = deepestProjectMatches[0]!;
    return { projectId: match.project.projectId, repoRoot: match.repoRoot };
  }
  if (deepestProjectMatches.length > 1) {
    throw new Error("Legacy path identifies multiple equally deep active daemon projects");
  }
  throw new Error("Legacy cwd or worktreePath does not identify daemon-owned repository state");
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
  const root = parse(value).root;
  let normalized = value;
  while (normalized.length > root.length && normalized.endsWith(sep)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}
