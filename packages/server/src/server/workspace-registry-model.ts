import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import type {
  ProjectCheckoutLitePayload,
  ProjectPlacementPayload,
} from "@getpaseo/protocol/messages";
import { parseGitRevParsePath } from "../utils/git-rev-parse-path.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";

export type PersistedProjectKind = "git" | "non_git";
export type PersistedWorkspaceKind = "local_checkout" | "worktree" | "directory";

export interface DirectoryProjectMembership {
  cwd: string;
  checkout: ProjectCheckoutLitePayload;
  workspaceDirectoryKey: string;
  workspaceKind: PersistedWorkspaceKind;
  workspaceDisplayName: string;
  projectKey: string;
  // Cross-host grouping/display key ("remote:...") or null. Distinct from
  // projectKey (the repo-root identity) so two clones of one remote are distinct
  // projects that still group across hosts. See #987.
  projectRemoteKey: string | null;
  projectName: string;
  projectRootPath: string;
  projectKind: PersistedProjectKind;
}

export interface DetectStaleWorkspacesInput {
  activeWorkspaces: PersistedWorkspaceRecord[];
  checkDirectoryExists: (cwd: string) => Promise<boolean>;
}

export function generateWorkspaceId(): string {
  return `wks_${randomBytes(8).toString("hex")}`;
}

// Path-derived grouping key for a workspace directory. This is NOT the opaque
// workspace identity (see generateWorkspaceId); never persist or compare it as one.
export function deriveWorkspaceDirectoryKey(
  cwd: string,
  checkout: ProjectCheckoutLitePayload,
): string {
  const worktreeRoot = checkout.worktreeRoot ? parseGitRevParsePath(checkout.worktreeRoot) : null;
  return worktreeRoot ?? resolve(cwd);
}

// Cross-host grouping and display key derived from the git remote (e.g.
// "remote:github.com/owner/repo"). NOT the project identity — two independent
// clones of one remote share this key but are distinct projects keyed by their
// root path. Null for non-git / no-remote / unparseable remotes. See #987.
export function deriveProjectRemoteKey(remoteUrl: string | null): string | null {
  if (!remoteUrl) {
    return null;
  }

  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return null;
  }

  let host: string | null = null;
  let remotePath: string | null = null;

  const scpLike = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (scpLike) {
    host = scpLike[1] ?? null;
    remotePath = scpLike[2] ?? null;
  } else if (trimmed.includes("://")) {
    try {
      const parsed = new URL(trimmed);
      host = parsed.hostname || null;
      remotePath = parsed.pathname ? parsed.pathname.replace(/^\/+/, "") : null;
    } catch {
      return null;
    }
  }

  if (!host || !remotePath) {
    return null;
  }

  let cleanedPath = remotePath.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (cleanedPath.endsWith(".git")) {
    cleanedPath = cleanedPath.slice(0, -4);
  }
  if (!cleanedPath.includes("/")) {
    return null;
  }

  const cleanedHost = host.toLowerCase();
  if (cleanedHost === "github.com") {
    return `remote:github.com/${cleanedPath}`;
  }

  return `remote:${cleanedHost}/${cleanedPath}`;
}

// Identity key for a project: the repository root. Two independent clones of the
// same remote have distinct roots (so they become distinct projects); a repo and
// its git worktrees share mainRepoRoot (so they group under one project). The
// remote-based grouping/display key now lives in deriveProjectRemoteKey. See #987.
export function deriveProjectGroupingKey(options: {
  cwd: string;
  mainRepoRoot: string | null;
}): string {
  const mainRepoRoot = options.mainRepoRoot?.trim();
  return mainRepoRoot ? mainRepoRoot : options.cwd;
}

export function deriveProjectGroupingName(projectKey: string): string {
  if (projectKey.startsWith("remote:")) {
    const remainder = projectKey.slice("remote:".length);
    const pathSegments = remainder.split("/").filter(Boolean).slice(1);
    if (pathSegments.length >= 2) {
      return pathSegments.slice(-2).join("/");
    }
    if (pathSegments.length === 1) {
      return pathSegments[0];
    }
    return projectKey;
  }

  const segments = projectKey.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || projectKey;
}

function deriveWorkspaceDirectoryName(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? cwd;
}

export function deriveWorkspaceDisplayName(input: {
  cwd: string;
  checkout: ProjectCheckoutLitePayload;
}): string {
  const branch = input.checkout.currentBranch?.trim() ?? null;
  if (branch && branch.toUpperCase() !== "HEAD") {
    return branch;
  }
  return deriveWorkspaceDirectoryName(input.cwd);
}

export function deriveProjectRootPath(input: {
  cwd: string;
  checkout: ProjectCheckoutLitePayload;
}): string {
  if (input.checkout.isGit && input.checkout.mainRepoRoot) {
    return input.checkout.mainRepoRoot;
  }
  return input.cwd;
}

export function deriveProjectKind(checkout: ProjectCheckoutLitePayload): PersistedProjectKind {
  return checkout.isGit ? "git" : "non_git";
}

export function deriveWorkspaceKind(checkout: ProjectCheckoutLitePayload): PersistedWorkspaceKind {
  if (!checkout.isGit) {
    return "directory";
  }
  return checkout.mainRepoRoot ? "worktree" : "local_checkout";
}

export function checkoutLiteFromGitSnapshot(
  cwd: string,
  git: {
    isGit: boolean;
    currentBranch: string | null;
    remoteUrl: string | null;
    repoRoot: string | null;
    isPaseoOwnedWorktree: boolean;
    mainRepoRoot: string | null;
  },
): ProjectCheckoutLitePayload {
  if (!git.isGit) {
    return {
      cwd,
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    };
  }
  if (git.isPaseoOwnedWorktree && git.mainRepoRoot) {
    return {
      cwd,
      isGit: true,
      currentBranch: git.currentBranch,
      remoteUrl: git.remoteUrl,
      worktreeRoot: git.repoRoot ?? cwd,
      isPaseoOwnedWorktree: true,
      mainRepoRoot: git.mainRepoRoot,
    };
  }
  return {
    cwd,
    isGit: true,
    currentBranch: git.currentBranch,
    remoteUrl: git.remoteUrl,
    worktreeRoot: git.repoRoot ?? cwd,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: git.mainRepoRoot,
  };
}

export async function detectStaleWorkspaces(
  input: DetectStaleWorkspacesInput,
): Promise<Set<string>> {
  const staleWorkspaceIds = new Set<string>();

  const existenceChecks = await Promise.all(
    input.activeWorkspaces.map(async (workspace) => ({
      workspace,
      exists: await input.checkDirectoryExists(workspace.cwd),
    })),
  );
  for (const { workspace, exists } of existenceChecks) {
    if (!exists) {
      staleWorkspaceIds.add(workspace.workspaceId);
    }
  }

  return staleWorkspaceIds;
}

export function buildProjectPlacementForCwd(input: {
  cwd: string;
  checkout: ProjectCheckoutLitePayload;
}): ProjectPlacementPayload {
  const membership = classifyDirectoryForProjectMembership(input);
  return {
    projectKey: membership.projectKey,
    remoteKey: membership.projectRemoteKey,
    projectName: membership.projectName,
    checkout: membership.checkout,
  };
}

export function classifyDirectoryForProjectMembership(input: {
  cwd: string;
  checkout: ProjectCheckoutLitePayload;
}): DirectoryProjectMembership {
  const normalizedCwd = resolve(input.cwd);
  const checkout: ProjectCheckoutLitePayload = {
    ...input.checkout,
    cwd: normalizedCwd,
  };

  const projectRootPath = deriveProjectRootPath({
    cwd: normalizedCwd,
    checkout,
  });
  // Project identity is the repository root (the worktree root, or the main repo
  // root for a linked worktree) — NOT the remote. Two independent clones of one
  // remote get distinct roots (so they are distinct projects); a repo and its
  // worktrees share mainRepoRoot (so they group under one project); a subpath of a
  // repo still resolves to the repo root. The remote key drives cross-host grouping
  // and display only. See #987.
  const projectKey = deriveProjectGroupingKey({
    cwd: checkout.worktreeRoot ?? normalizedCwd,
    mainRepoRoot: checkout.mainRepoRoot,
  });
  const projectRemoteKey = deriveProjectRemoteKey(checkout.remoteUrl);

  return {
    cwd: normalizedCwd,
    checkout,
    workspaceDirectoryKey: deriveWorkspaceDirectoryKey(normalizedCwd, checkout),
    workspaceKind: deriveWorkspaceKind(checkout),
    workspaceDisplayName: deriveWorkspaceDisplayName({
      cwd: normalizedCwd,
      checkout,
    }),
    projectKey,
    projectRemoteKey,
    projectName: deriveProjectGroupingName(projectRemoteKey ?? projectKey),
    projectRootPath,
    projectKind: deriveProjectKind(checkout),
  };
}
