import { basename, resolve } from "node:path";

import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";

import { parseGitRevParsePath } from "../utils/git-rev-parse-path.js";
import { deriveProjectGroupKey } from "./project-group-key.js";
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
  const projectKey = deriveProjectGroupKey({
    rootPath: cwd,
    remoteUrl: checkout.remoteUrl,
    worktreeRoot: checkout.worktreeRoot,
    mainRepoRoot: checkout.mainRepoRoot,
  });

  return {
    cwd,
    checkout,
    workspaceDirectoryKey: deriveWorkspaceDirectoryKey(cwd, checkout),
    workspaceKind: deriveWorkspaceKind(checkout),
    workspaceDisplayName: deriveWorkspaceDisplayName({ cwd, checkout }),
    projectKey,
    projectName: deriveProjectGroupingName(projectKey, cwd),
    projectRootPath: deriveProjectRootPath({ cwd, checkout }),
    projectKind: deriveProjectKind(checkout),
  };
}

function deriveWorkspaceDirectoryKey(cwd: string, checkout: ProjectCheckoutLitePayload): string {
  const worktreeRoot = checkout.worktreeRoot ? parseGitRevParsePath(checkout.worktreeRoot) : null;
  const selectedRoot = resolve(cwd);
  return worktreeRoot && resolve(worktreeRoot) === selectedRoot ? worktreeRoot : selectedRoot;
}

function deriveProjectGroupingName(projectKey: string, selectedRoot: string): string {
  if (projectKey.includes("#subdir:")) return basename(selectedRoot);
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
