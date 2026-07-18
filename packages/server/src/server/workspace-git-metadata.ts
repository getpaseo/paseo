import { basename } from "path";
import { createHash } from "node:crypto";
import { parseGitHubRemoteUrl } from "@getpaseo/protocol/git-remote";
import { slugify } from "../utils/worktree.js";

export function parseGitHubRepoFromRemote(remoteUrl: string): string | null {
  return parseGitHubRemoteUrl(remoteUrl)?.repo ?? null;
}

export function parseGitHubRepoNameFromRemote(remoteUrl: string): string | null {
  const githubRepo = parseGitHubRepoFromRemote(remoteUrl);
  if (!githubRepo) {
    return null;
  }

  return githubRepo.split("/").pop() || null;
}

export function deriveProjectSlug(cwd: string, remoteUrl: string | null = null): string {
  const githubRepoName = remoteUrl ? parseGitHubRepoNameFromRemote(remoteUrl) : null;
  const sourceName = githubRepoName ?? basename(cwd);
  return slugify(sourceName) || "untitled";
}

export function deriveProjectServiceSlug(project: { projectId: string; rootPath: string }): string {
  const identity = createHash("sha256").update(project.projectId).digest("hex").slice(0, 8);
  return `${deriveProjectSlug(project.rootPath)}-${identity}`;
}
