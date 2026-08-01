import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import type { CommandError } from "../../output/index.js";

export interface WorktreeRepositoryOptions {
  project?: string;
  repoRoot?: string;
  cwd?: string;
  host?: string;
}

export interface WorktreeRepositoryIdentity {
  projectId?: string;
  repoRoot?: string;
}

export async function resolveWorktreeRepositoryIdentity(
  options: WorktreeRepositoryOptions,
  client: {
    getLastServerInfoMessage(): { hostname?: string | null } | null;
    isLocalDaemonConnection(): boolean;
    listProjects(): Promise<{
      projects: Array<{ projectId: string; projectRootPath: string }>;
    }>;
  },
  cwd: string = process.cwd(),
): Promise<WorktreeRepositoryIdentity> {
  const identityOptions = [options.project, options.repoRoot, options.cwd].filter(Boolean);
  if (identityOptions.length > 1) {
    throw commandError(
      "AMBIGUOUS_REPOSITORY_IDENTITY",
      "Use only one of --project, --repo-root, or --cwd",
    );
  }
  if (options.project) return { projectId: options.project };
  const explicitRepoRoot = options.repoRoot ?? options.cwd;
  if (explicitRepoRoot) return { repoRoot: explicitRepoRoot };

  const daemonHostname = client.getLastServerInfoMessage()?.hostname;
  if (client.isLocalDaemonConnection() && daemonHostname === hostname()) {
    const projects = (await client.listProjects()).projects;
    const gitContext = resolveLocalGitProjectContext(cwd);
    const registeredProject = gitContext
      ? selectRegisteredProjectByCanonicalPath(
          gitContext.projectSelectionPath,
          projects,
          gitContext.repositoryBoundary,
        )
      : selectRegisteredProject(cwd, projects);
    if (registeredProject) {
      return {
        projectId: registeredProject.projectId,
        repoRoot: registeredProject.projectRootPath,
      };
    }
    return { repoRoot: resolveLocalGitTopLevel(cwd) ?? cwd };
  }
  throw commandError(
    "REPOSITORY_IDENTITY_REQUIRED",
    "Specify --project or --repo-root when the daemon is not on this host",
  );
}

function selectRegisteredProject(
  cwd: string,
  projects: Array<{ projectId: string; projectRootPath: string }>,
): { projectId: string; projectRootPath: string } | null {
  let canonicalCwd: string;
  try {
    canonicalCwd = realpathSync.native(cwd);
  } catch {
    return null;
  }

  return selectRegisteredProjectByCanonicalPath(canonicalCwd, projects);
}

function selectRegisteredProjectByCanonicalPath(
  canonicalCwd: string,
  projects: Array<{ projectId: string; projectRootPath: string }>,
  repositoryBoundary?: string,
): { projectId: string; projectRootPath: string } | null {
  const containingProjects = projects
    .map((project) => {
      try {
        return { ...project, projectRootPath: realpathSync.native(project.projectRootPath) };
      } catch {
        return null;
      }
    })
    .filter((project): project is { projectId: string; projectRootPath: string } => {
      if (!project) return false;
      if (repositoryBoundary && !isPathWithin(repositoryBoundary, project.projectRootPath)) {
        return false;
      }
      return isPathWithin(project.projectRootPath, canonicalCwd);
    });
  const deepestRootLength = Math.max(
    0,
    ...containingProjects.map((project) => project.projectRootPath.length),
  );
  const deepestProjects = containingProjects.filter(
    (project) => project.projectRootPath.length === deepestRootLength,
  );
  if (deepestProjects.length > 1) {
    throw commandError(
      "AMBIGUOUS_REPOSITORY_IDENTITY",
      "Caller path identifies multiple equally deep registered projects; specify --project",
    );
  }
  return deepestProjects[0] ?? null;
}

function resolveLocalGitTopLevel(cwd: string): string | null {
  return resolveGitPath(cwd, ["rev-parse", "--show-toplevel"]);
}

interface LocalGitProjectContext {
  projectSelectionPath: string;
  repositoryBoundary: string;
}

function resolveLocalGitProjectContext(cwd: string): LocalGitProjectContext | null {
  const worktreeRoot = resolveLocalGitTopLevel(cwd);
  const commonDir = resolveGitPath(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (!worktreeRoot) return null;

  let canonicalCwd: string;
  let canonicalWorktreeRoot: string;
  try {
    canonicalCwd = realpathSync.native(cwd);
    canonicalWorktreeRoot = realpathSync.native(worktreeRoot);
  } catch {
    return null;
  }
  const relativePath = path.relative(canonicalWorktreeRoot, canonicalCwd);
  if (
    relativePath.startsWith(`..${path.sep}`) ||
    relativePath === ".." ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  if (!commonDir || path.basename(commonDir) !== ".git") {
    return {
      projectSelectionPath: canonicalCwd,
      repositoryBoundary: canonicalWorktreeRoot,
    };
  }

  try {
    const canonicalCommonDir = realpathSync.native(commonDir);
    const mainRepositoryRoot = path.dirname(canonicalCommonDir);
    return {
      projectSelectionPath: path.join(mainRepositoryRoot, relativePath),
      repositoryBoundary: mainRepositoryRoot,
    };
  } catch {
    return null;
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== ".." &&
      !path.isAbsolute(relativePath))
  );
}

function resolveGitPath(cwd: string, args: string[]): string | null {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!output.endsWith("\n")) return null;
    return output.length > 1 ? output.slice(0, -1) : null;
  } catch {
    return null;
  }
}

function commandError(code: string, message: string): CommandError {
  return { code, message };
}
