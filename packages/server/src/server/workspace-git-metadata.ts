import { basename } from "path";
import { slugify } from "../utils/worktree.js";

export type WorkspaceGitMetadata = {
  projectKind: "git" | "directory";
  projectDisplayName: string;
  workspaceDisplayName: string;
  gitRemote: string | null;
  isWorktree: boolean;
  projectSlug: string;
  repoRoot: string | null;
  currentBranch: string | null;
  remoteUrl: string | null;
};

export function parseGitHubRepoFromRemote(remoteUrl: string): string | null {
  let cleaned = remoteUrl.trim();
  if (!cleaned) {
    return null;
  }

  if (cleaned.startsWith("git@github.com:")) {
    cleaned = cleaned.slice("git@github.com:".length);
  } else {
    let parsed: URL;
    try {
      parsed = new URL(cleaned);
    } catch {
      return null;
    }

    if (parsed.hostname !== "github.com") {
      return null;
    }

    try {
      cleaned = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    } catch {
      return null;
    }
  }

  if (cleaned.endsWith(".git")) {
    cleaned = cleaned.slice(0, -".git".length);
  }

  if (!cleaned.includes("/")) {
    return null;
  }

  return cleaned;
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
