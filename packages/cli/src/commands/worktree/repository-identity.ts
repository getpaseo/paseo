import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
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

export function resolveWorktreeRepositoryIdentity(
  options: WorktreeRepositoryOptions,
  client: {
    getLastServerInfoMessage(): { hostname?: string | null } | null;
    isLocalDaemonConnection(): boolean;
  },
  cwd: string = process.cwd(),
): WorktreeRepositoryIdentity {
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
    return { repoRoot: resolveLocalGitTopLevel(cwd) ?? cwd };
  }
  throw commandError(
    "REPOSITORY_IDENTITY_REQUIRED",
    "Specify --project or --repo-root when the daemon is not on this host",
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
