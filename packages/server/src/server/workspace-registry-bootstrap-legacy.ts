import { resolve } from "node:path";

import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";

import { parseGitRevParsePath } from "../utils/git-rev-parse-path.js";
import { createRealpathAwarePathMatcher, getRealpathAwareRelativePath } from "../utils/path.js";
import { deriveProjectKey, deriveProjectGroupingDisplayName } from "./project-key.js";
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
  projectId: string;
  projectKey: string;
  projectName: string;
  projectRootPath: string;
  projectKind: PersistedProjectKind;
}

export function classifyDirectoryForProjectMembership(input: {
  cwd: string;
  checkout: ProjectCheckoutLitePayload;
  serverId?: string;
}): DirectoryProjectMembership {
  const cwd = resolve(input.cwd);
  const checkout: ProjectCheckoutLitePayload = { ...input.checkout, cwd };
  const projectKey = deriveProjectKey({
    rootPath: cwd,
    remoteUrl: checkout.remoteUrl,
    worktreeRoot: checkout.worktreeRoot,
    mainRepoRoot: checkout.mainRepoRoot,
    serverId: input.serverId,
  });
  const projectRootPath = deriveProjectRootPath({ cwd, checkout });

  return {
    cwd,
    checkout,
    workspaceDirectoryKey: deriveWorkspaceDirectoryKey(cwd, checkout),
    workspaceKind: deriveWorkspaceKind(checkout),
    workspaceDisplayName: deriveWorkspaceDisplayName({ cwd, checkout }),
    // Legacy registry bootstrap historically used the grouping identity as the
    // host-local project ID. Preserve that ID shape while keeping the new,
    // canonical cross-host identity in projectKey.
    projectId: projectKey.startsWith("remote:") ? projectKey : projectRootPath,
    projectKey,
    projectName: deriveProjectGroupingDisplayName({
      rootPath: cwd,
      remoteUrl: checkout.remoteUrl,
      worktreeRoot: checkout.worktreeRoot,
    }),
    projectRootPath,
    projectKind: deriveProjectKind(checkout),
  };
}

function deriveWorkspaceDirectoryKey(cwd: string, checkout: ProjectCheckoutLitePayload): string {
  const worktreeRoot = checkout.worktreeRoot ? parseGitRevParsePath(checkout.worktreeRoot) : null;
  const selectedRoot = resolve(cwd);
  return worktreeRoot && createRealpathAwarePathMatcher(worktreeRoot)(selectedRoot)
    ? worktreeRoot
    : selectedRoot;
}

function deriveProjectRootPath(input: {
  cwd: string;
  checkout: ProjectCheckoutLitePayload;
}): string {
  if (!input.checkout.isGit || !input.checkout.mainRepoRoot) return input.cwd;
  const worktreeRoot = input.checkout.worktreeRoot
    ? parseGitRevParsePath(input.checkout.worktreeRoot)
    : null;
  if (!worktreeRoot) return input.checkout.mainRepoRoot;
  const selectedPath = getRealpathAwareRelativePath(worktreeRoot, input.cwd);
  return selectedPath
    ? resolve(input.checkout.mainRepoRoot, selectedPath)
    : input.checkout.mainRepoRoot;
}
