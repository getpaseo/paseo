import { execSync } from "child_process";
import { basename } from "path";
import { slugify } from "../utils/worktree.js";
import { READ_ONLY_GIT_ENV } from "./checkout-git-utils.js";

export type WorkspaceGitMetadata = {
  projectKind: "git" | "directory";
  projectDisplayName: string;
  workspaceDisplayName: string;
  gitRemote: string | null;
  isWorktree: boolean;
};

export function readGitCommand(cwd: string, command: string): string | null {
  try {
    const output = execSync(command, {
      cwd,
      env: READ_ONLY_GIT_ENV,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

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

export function deriveProjectSlug(cwd: string): string {
  const gitRemote = readGitCommand(cwd, "git config --get remote.origin.url");
  const githubRepoName = gitRemote ? parseGitHubRepoNameFromRemote(gitRemote) : null;
  const sourceName = githubRepoName ?? basename(cwd);
  return slugify(sourceName) || "untitled";
}

export function detectWorkspaceGitMetadata(
  cwd: string,
  directoryName: string,
): WorkspaceGitMetadata {
  const gitDir = readGitCommand(cwd, "git rev-parse --git-dir");
  if (!gitDir) {
    return {
      projectKind: "directory",
      projectDisplayName: directoryName,
      workspaceDisplayName: directoryName,
      gitRemote: null,
      isWorktree: false,
    };
  }

  const gitRemote = readGitCommand(cwd, "git config --get remote.origin.url");
  const githubRepo = gitRemote ? parseGitHubRepoFromRemote(gitRemote) : null;
  const branchName = readGitCommand(cwd, "git symbolic-ref --short HEAD");
  const gitCommonDir = readGitCommand(cwd, "git rev-parse --git-common-dir");
  const isWorktree = gitCommonDir !== null && gitDir !== gitCommonDir;

  return {
    projectKind: "git",
    projectDisplayName: githubRepo ?? directoryName,
    workspaceDisplayName: branchName ?? directoryName,
    gitRemote,
    isWorktree,
  };
}
