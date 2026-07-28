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
  const projectRootPath = deriveProjectRootPath({ cwd, checkout });

  return {
    cwd,
    checkout,
    workspaceDirectoryKey: deriveWorkspaceDirectoryKey(cwd, checkout),
    workspaceKind: deriveWorkspaceKind(checkout),
    workspaceDisplayName: deriveWorkspaceDisplayName({ cwd, checkout }),
    projectKey: projectRootPath,
    projectName: deriveProjectGroupingName(projectRootPath),
    projectRootPath,
    projectKind: deriveProjectKind(checkout),
  };
}

function deriveWorkspaceDirectoryKey(cwd: string, checkout: ProjectCheckoutLitePayload): string {
  const worktreeRoot = checkout.worktreeRoot ? parseGitRevParsePath(checkout.worktreeRoot) : null;
  return worktreeRoot ?? resolve(cwd);
}

function deriveProjectGroupingName(projectKey: string): string {
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
