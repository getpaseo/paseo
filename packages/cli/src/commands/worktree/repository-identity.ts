import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import type { CommandError } from "../../output/index.js";

export interface WorktreeRepositoryOptions {
  project?: string;
  repoRoot?: string;
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
  if (options.project && options.repoRoot) {
    throw commandError(
      "AMBIGUOUS_REPOSITORY_IDENTITY",
      "Use either --project or --repo-root, not both",
    );
  }
  if (options.project) return { projectId: options.project };
  if (options.repoRoot) return { repoRoot: options.repoRoot };

  const daemonHostname = client.getLastServerInfoMessage()?.hostname;
  if (client.isLocalDaemonConnection() && daemonHostname === hostname()) {
    const projects = (await client.listProjects()).projects;
    const mainPath = resolveLocalGitMainPath(cwd);
    const registeredProject =
      selectRegisteredProject(cwd, projects) ??
      (mainPath ? selectRegisteredProjectByCanonicalPath(mainPath, projects) : null);
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
      const relativePath = path.relative(project.projectRootPath, canonicalCwd);
      return (
        relativePath === "" ||
        (!relativePath.startsWith(`..${path.sep}`) &&
          relativePath !== ".." &&
          !path.isAbsolute(relativePath))
      );
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

function resolveLocalGitMainPath(cwd: string): string | null {
  const worktreeRoot = resolveLocalGitTopLevel(cwd);
  const commonDir = resolveGitPath(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (!worktreeRoot || !commonDir || path.basename(commonDir) !== ".git") return null;

  let canonicalCwd: string;
  let canonicalWorktreeRoot: string;
  let canonicalCommonDir: string;
  try {
    canonicalCwd = realpathSync.native(cwd);
    canonicalWorktreeRoot = realpathSync.native(worktreeRoot);
    canonicalCommonDir = realpathSync.native(commonDir);
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
  return path.join(path.dirname(canonicalCommonDir), relativePath);
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
