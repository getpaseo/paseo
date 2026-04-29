import { resolve } from "node:path";

import { getCheckoutStatusLite, getMainRepoRoot } from "../utils/checkout-git.js";
import type { ProjectCheckoutLitePayload, ProjectPlacementPayload } from "../shared/messages.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";

export type PersistedProjectKind = "git" | "non_git";
export type PersistedWorkspaceKind = "local_checkout" | "worktree" | "directory";
export type DetectStaleWorkspacesInput = {
  activeWorkspaces: PersistedWorkspaceRecord[];
  checkDirectoryExists: (cwd: string) => Promise<boolean>;
};

export function normalizeWorkspaceId(cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed) {
    return cwd;
  }
  return resolve(trimmed);
}

export function deriveWorkspaceId(cwd: string, checkout: ProjectCheckoutLitePayload): string {
  return checkout.worktreeRoot ?? normalizeWorkspaceId(cwd);
}

function deriveRemoteProjectKey(remoteUrl: string | null): string | null {
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

export function deriveProjectGroupingKey(options: {
  cwd: string;
  remoteUrl: string | null;
  mainRepoRoot: string | null;
}): string {
  const remoteKey = deriveRemoteProjectKey(options.remoteUrl);
  if (remoteKey) {
    return remoteKey;
  }

  // Group every git worktree (whether or not it was created via hubcode) under
  // the main repo root. The placement layer is responsible for resolving the
  // main repo for any non-bare worktree before calling this helper.
  const mainRepoRoot = options.mainRepoRoot?.trim();
  if (mainRepoRoot) {
    return mainRepoRoot;
  }

  return options.cwd;
}

export function deriveProjectGroupingName(projectKey: string): string {
  const githubRemotePrefix = "remote:github.com/";
  if (projectKey.startsWith(githubRemotePrefix)) {
    return projectKey.slice(githubRemotePrefix.length) || projectKey;
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
  // A git checkout is a worktree (vs the main local checkout) iff we have a
  // separate main repo root recorded for it. The placement layer resolves the
  // main repo for any non-bare git worktree, regardless of hubcode ownership.
  return checkout.mainRepoRoot ? "worktree" : "local_checkout";
}

export async function detectStaleWorkspaces(
  input: DetectStaleWorkspacesInput,
): Promise<Set<string>> {
  const staleWorkspaceIds = new Set<string>();

  for (const workspace of input.activeWorkspaces) {
    const dirExists = await input.checkDirectoryExists(workspace.cwd);
    if (!dirExists) {
      staleWorkspaceIds.add(workspace.workspaceId);
    }
  }

  return staleWorkspaceIds;
}

export async function buildProjectPlacementForCwd(input: {
  cwd: string;
  hubcodeHome: string;
}): Promise<ProjectPlacementPayload> {
  const normalizedCwd = normalizeWorkspaceId(input.cwd);
  const checkout = await getCheckoutStatusLite(normalizedCwd, { hubcodeHome: input.hubcodeHome })
    .then(async (status): Promise<ProjectCheckoutLitePayload> => {
      if (!status.isGit) {
        return {
          cwd: normalizedCwd,
          isGit: false,
          currentBranch: null,
          remoteUrl: null,
          worktreeRoot: null,
          isHubcodeOwnedWorktree: false,
          mainRepoRoot: null,
        };
      }

      if (status.isHubcodeOwnedWorktree && status.mainRepoRoot) {
        return {
          cwd: normalizedCwd,
          isGit: true,
          currentBranch: status.currentBranch,
          remoteUrl: status.remoteUrl,
          worktreeRoot: status.worktreeRoot,
          isHubcodeOwnedWorktree: true,
          mainRepoRoot: status.mainRepoRoot,
        };
      }

      // For non-hubcode git checkouts, also resolve the main repo root so that
      // regular `git worktree add` worktrees get grouped under their parent
      // repo and reported with kind="worktree". The shared schema currently
      // only allows `mainRepoRoot` to be set when `isHubcodeOwnedWorktree=true`,
      // so we reuse that union here. Downstream consumers that need to
      // distinguish hubcode-owned worktrees from any-git-worktree must consult
      // `isHubcodeOwnedWorktreeCwd` directly rather than rely on the placement
      // payload.
      let mainRepoRoot: string | null = null;
      try {
        const candidate = await getMainRepoRoot(normalizedCwd);
        if (candidate && candidate !== status.worktreeRoot) {
          mainRepoRoot = candidate;
        }
      } catch {
        // Fall back to the bare-checkout shape if main-repo discovery fails.
      }

      if (mainRepoRoot) {
        return {
          cwd: normalizedCwd,
          isGit: true,
          currentBranch: status.currentBranch,
          remoteUrl: status.remoteUrl,
          worktreeRoot: status.worktreeRoot,
          isHubcodeOwnedWorktree: true,
          mainRepoRoot,
        };
      }

      return {
        cwd: normalizedCwd,
        isGit: true,
        currentBranch: status.currentBranch,
        remoteUrl: status.remoteUrl,
        worktreeRoot: status.worktreeRoot,
        isHubcodeOwnedWorktree: false,
        mainRepoRoot: null,
      };
    })
    .catch(
      (): ProjectCheckoutLitePayload => ({
        cwd: normalizedCwd,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isHubcodeOwnedWorktree: false,
        mainRepoRoot: null,
      }),
    );

  const projectKey = deriveProjectGroupingKey({
    cwd: checkout.worktreeRoot ?? normalizedCwd,
    remoteUrl: checkout.remoteUrl,
    mainRepoRoot: checkout.mainRepoRoot,
  });

  return {
    projectKey,
    projectName: deriveProjectGroupingName(projectKey),
    checkout,
  };
}
