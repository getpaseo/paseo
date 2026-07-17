import { resolve } from "node:path";

import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";

import { parseGitRevParsePath } from "../utils/git-rev-parse-path.js";
import {
  deriveProjectKind,
  deriveWorkspaceDisplayName,
  deriveWorkspaceKind,
  type PersistedProjectKind,
  type PersistedWorkspaceKind,
} from "./workspace-registry-model.js";

// COMPAT(legacyRegistryBootstrap): added in v0.1.109 on 2026-07-15; remove after
// 2027-01-15, once every supported install has materialized its registry files.
interface DirectoryProjectMembership {
  cwd: string;
  checkout: ProjectCheckoutLitePayload;
  workspaceDirectoryKey: string;
  workspaceKind: PersistedWorkspaceKind;
  workspaceDisplayName: string;
  projectKey: string;
  projectName: string;
  projectRootPath: string;
  projectKind: PersistedProjectKind;
}

export function classifyDirectoryForProjectMembership(input: {
  cwd: string;
  checkout: ProjectCheckoutLitePayload;
}): DirectoryProjectMembership {
  const cwd = resolve(input.cwd);
  const checkout: ProjectCheckoutLitePayload = { ...input.checkout, cwd };
  const projectKey = deriveProjectGroupingKey({
    cwd: checkout.worktreeRoot ?? cwd,
    remoteUrl: checkout.remoteUrl,
    mainRepoRoot: checkout.mainRepoRoot,
  });

  return {
    cwd,
    checkout,
    workspaceDirectoryKey: deriveWorkspaceDirectoryKey(cwd, checkout),
    workspaceKind: deriveWorkspaceKind(checkout),
    workspaceDisplayName: deriveWorkspaceDisplayName({ cwd, checkout }),
    projectKey,
    projectName: deriveProjectGroupingName(projectKey),
    projectRootPath: deriveProjectRootPath({ cwd, checkout }),
    projectKind: deriveProjectKind(checkout),
  };
}

function deriveWorkspaceDirectoryKey(cwd: string, checkout: ProjectCheckoutLitePayload): string {
  const worktreeRoot = checkout.worktreeRoot ? parseGitRevParsePath(checkout.worktreeRoot) : null;
  return worktreeRoot ?? resolve(cwd);
}

function deriveRemoteProjectKey(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;

  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

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

  if (!host || !remotePath) return null;

  let cleanedPath = remotePath.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (cleanedPath.endsWith(".git")) cleanedPath = cleanedPath.slice(0, -4);
  if (!cleanedPath.includes("/")) return null;

  return `remote:${host.toLowerCase()}/${cleanedPath}`;
}

function deriveProjectGroupingKey(options: {
  cwd: string;
  remoteUrl: string | null;
  mainRepoRoot: string | null;
}): string {
  const remoteKey = deriveRemoteProjectKey(options.remoteUrl);
  if (remoteKey) return remoteKey;

  const mainRepoRoot = options.mainRepoRoot?.trim();
  return mainRepoRoot || options.cwd;
}

function deriveProjectGroupingName(projectKey: string): string {
  if (projectKey.startsWith("remote:")) {
    const pathSegments = projectKey.slice("remote:".length).split("/").filter(Boolean).slice(1);
    if (pathSegments.length >= 2) return pathSegments.slice(-2).join("/");
    if (pathSegments.length === 1) return pathSegments[0];
    return projectKey;
  }

  const segments = projectKey.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || projectKey;
}

function deriveProjectRootPath(input: {
  cwd: string;
  checkout: ProjectCheckoutLitePayload;
}): string {
  return input.checkout.isGit && input.checkout.mainRepoRoot
    ? input.checkout.mainRepoRoot
    : input.cwd;
}
