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
    const registeredProject = selectRegisteredProject(cwd, (await client.listProjects()).projects);
    if (registeredProject) return { projectId: registeredProject.projectId };
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

  return (
    projects
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
      })
      .sort((left, right) => right.projectRootPath.length - left.projectRootPath.length)[0] ?? null
  );
}

function resolveLocalGitTopLevel(cwd: string): string | null {
  try {
    const output = execFileSync("git", ["rev-parse", "--show-toplevel"], {
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
