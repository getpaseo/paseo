import { execCommand } from "../../../utils/spawn.js";
import { parseGitHubRemoteUrl } from "../../../utils/github-remote.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";

export class JulesRepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JulesRepoError";
  }
}

export async function resolveGitHubRepo(
  cwd: string,
  workspaceGitService: Pick<WorkspaceGitService, "resolveRepoRoot">,
): Promise<{ owner: string; name: string }> {
  const repoRoot = await workspaceGitService.resolveRepoRoot(cwd);
  let remoteUrl: string;
  try {
    const { stdout } = await execCommand("git", ["remote", "get-url", "origin"], {
      cwd: repoRoot,
      timeout: 10_000,
      envOverlay: { GIT_TERMINAL_PROMPT: "0" },
    });
    remoteUrl = stdout.trim();
  } catch (error) {
    throw new JulesRepoError(
      `Jules requires a GitHub origin remote. Failed to read origin: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const parsed = parseGitHubRemoteUrl(remoteUrl);
  if (!parsed) {
    throw new JulesRepoError(
      `Jules requires a GitHub origin remote; got '${remoteUrl || "unknown"}'`,
    );
  }

  return { owner: parsed.owner, name: parsed.name };
}
