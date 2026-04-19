import { basename } from "path";
import { parseGitHubRemoteUrl } from "../utils/github-remote.js";
import { slugify } from "../utils/worktree.js";

export interface WorkspaceGitMetadata {
  projectKind: "git" | "directory";
  projectDisplayName: string;
  workspaceDisplayName: string;
  gitRemote: string | null;
  isWorktree: boolean;
  projectSlug: string;
  repoRoot: string | null;
  currentBranch: string | null;
  remoteUrl: string | null;
}

export function parseGitHubRepoFromRemote(remoteUrl: string): string | null {
  return parseGitHubRemoteUrl(remoteUrl)?.repo ?? null;
}

export function parseGitHubRepoNameFromRemote(remoteUrl: string): string | null {
  const githubRepo = parseGitHubRepoFromRemote(remoteUrl);
  if (!githubRepo) {
    return null;
  }

  const repoName = githubRepo.split("/").pop();
  return repoName && repoName.length > 0 ? repoName : null;
}

export function deriveProjectSlug(cwd: string, remoteUrl: string | null = null): string {
  const githubRepoName = remoteUrl ? parseGitHubRepoNameFromRemote(remoteUrl) : null;
  const sourceName = githubRepoName ?? basename(cwd);
  return slugify(sourceName) || "untitled";
}

export function buildWorkspaceGitMetadataFromSnapshot(input: {
  cwd: string;
  directoryName: string;
  isGit: boolean;
  repoRoot: string | null;
  mainRepoRoot: string | null;
  currentBranch: string | null;
  remoteUrl: string | null;
}): WorkspaceGitMetadata {
  if (!input.isGit) {
    return {
      projectKind: "directory",
      projectDisplayName: input.directoryName,
      workspaceDisplayName: input.directoryName,
      gitRemote: null,
      isWorktree: false,
      projectSlug: deriveProjectSlug(input.cwd, null),
      repoRoot: null,
      currentBranch: null,
      remoteUrl: null,
    };
  }

  const githubRepo = input.remoteUrl ? parseGitHubRepoFromRemote(input.remoteUrl) : null;
  const isWorktree =
    input.mainRepoRoot !== null && input.repoRoot !== null && input.mainRepoRoot !== input.repoRoot;

  return {
    projectKind: "git",
    projectDisplayName: githubRepo ?? input.directoryName,
    workspaceDisplayName: input.currentBranch ?? input.directoryName,
    gitRemote: input.remoteUrl,
    isWorktree,
    projectSlug: deriveProjectSlug(input.cwd, input.remoteUrl),
    repoRoot: input.repoRoot,
    currentBranch: input.currentBranch,
    remoteUrl: input.remoteUrl,
  };
}
