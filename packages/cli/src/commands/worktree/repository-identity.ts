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
  client: { getLastServerInfoMessage(): { hostname?: string | null } | null },
  environment: NodeJS.ProcessEnv = process.env,
): WorktreeRepositoryIdentity {
  if (options.project && options.repoRoot) {
    throw commandError(
      "AMBIGUOUS_REPOSITORY_IDENTITY",
      "Use either --project or --repo-root, not both",
    );
  }
  if (options.project) return { projectId: options.project };
  if (options.repoRoot) return { repoRoot: options.repoRoot };

  // An explicitly selected endpoint does not prove that its filesystem is local.
  if (options.host || environment.PASEO_HOST) {
    throw commandError(
      "REPOSITORY_IDENTITY_REQUIRED",
      "Specify --project or --repo-root when using an explicit daemon host",
    );
  }

  const daemonHostname = client.getLastServerInfoMessage()?.hostname;
  if (daemonHostname && daemonHostname === hostname()) {
    return { repoRoot: process.cwd() };
  }
  throw commandError(
    "REPOSITORY_IDENTITY_REQUIRED",
    "Specify --project or --repo-root when the daemon is not on this host",
  );
}

function commandError(code: string, message: string): CommandError {
  return { code, message };
}
