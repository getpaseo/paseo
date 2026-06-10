import { join } from "node:path";

import { getPaseoWorktreesRoot, isPaseoOwnedWorktreeCwd } from "../../utils/worktree.js";
import {
  archivePaseoWorktree,
  type ArchivePaseoWorktreeDependencies,
} from "../paseo-worktree-archive-service.js";
import type {
  CreatePaseoWorktreeInput,
  CreatePaseoWorktreeResult,
} from "../paseo-worktree-service.js";
import { toWorktreeWireError, type WorktreeWireError } from "../worktree-errors.js";
import type { WorkspaceGitService, WorkspaceGitWorktreeInfo } from "../workspace-git-service.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import { normalizeWorkspaceId } from "../workspace-registry-model.js";

export interface ListPaseoWorktreesCommandDependencies {
  workspaceGitService: Pick<WorkspaceGitService, "listWorktrees">;
}

export interface ListPaseoWorktreesCommandInput {
  cwd: string;
  reason?: string;
}

export async function listPaseoWorktreesCommand(
  dependencies: ListPaseoWorktreesCommandDependencies,
  input: ListPaseoWorktreesCommandInput,
): Promise<WorkspaceGitWorktreeInfo[]> {
  if (input.reason) {
    return dependencies.workspaceGitService.listWorktrees(input.cwd, { reason: input.reason });
  }
  return dependencies.workspaceGitService.listWorktrees(input.cwd);
}

type CreatePaseoWorktreeWorkflow<Result extends CreatePaseoWorktreeResult> = (
  input: CreatePaseoWorktreeInput,
) => Promise<Result>;

export interface CreatePaseoWorktreeCommandDependencies<
  Result extends CreatePaseoWorktreeResult = CreatePaseoWorktreeResult,
> {
  paseoHome?: string;
  worktreesRoot?: string;
  createPaseoWorktreeWorkflow?: CreatePaseoWorktreeWorkflow<Result>;
}

export type CreatePaseoWorktreeCommandInput = Omit<
  CreatePaseoWorktreeInput,
  "paseoHome" | "runSetup"
> & {
  paseoHome?: string;
  worktreesRoot?: string;
};

export type CreatePaseoWorktreeCommandResult<Result extends CreatePaseoWorktreeResult> =
  | {
      ok: true;
      createdWorktree: Result;
    }
  | {
      ok: false;
      error: WorktreeWireError;
      cause: unknown;
    };

export async function createPaseoWorktreeCommand<Result extends CreatePaseoWorktreeResult>(
  dependencies: CreatePaseoWorktreeCommandDependencies<Result>,
  input: CreatePaseoWorktreeCommandInput,
): Promise<CreatePaseoWorktreeCommandResult<Result>> {
  try {
    if (!dependencies.createPaseoWorktreeWorkflow) {
      throw new Error("Paseo worktree service is not configured");
    }

    const createdWorktree = await dependencies.createPaseoWorktreeWorkflow({
      ...input,
      runSetup: false,
      paseoHome: input.paseoHome ?? dependencies.paseoHome,
      worktreesRoot: input.worktreesRoot ?? dependencies.worktreesRoot,
    });
    return { ok: true, createdWorktree };
  } catch (error) {
    return {
      ok: false,
      error: toWorktreeWireError(error),
      cause: error,
    };
  }
}

export interface ArchivePaseoWorktreeCommandDependencies extends Omit<
  ArchivePaseoWorktreeDependencies,
  "workspaceGitService"
> {
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot" | "listWorktrees">;
  /** Optional registry used to look up subRepoWorktrees for multi_git workspaces. */
  workspaceRegistry?: Pick<WorkspaceRegistry, "get">;
}

export interface ArchivePaseoWorktreeCommandInput {
  requestId: string;
  repoRoot?: string | null;
  worktreePath?: string;
  worktreeSlug?: string;
  branchName?: string;
}

export type ArchivePaseoWorktreeCommandResult =
  | {
      ok: true;
      removedAgents: string[];
    }
  | {
      ok: false;
      code: "NOT_ALLOWED";
      message: string;
      removedAgents: [];
    };

export async function archivePaseoWorktreeCommand(
  dependencies: ArchivePaseoWorktreeCommandDependencies,
  input: ArchivePaseoWorktreeCommandInput,
): Promise<ArchivePaseoWorktreeCommandResult> {
  const resolvedTarget = await resolveArchiveTarget(dependencies, input);

  // For multi_git workspaces the workspace record carries subRepoWorktrees.
  // Look it up so the archive step can clean up all sub-repo worktrees, and so
  // we can bypass the Paseo-ownership check (workspaceRoot is not under the
  // Paseo worktrees base root — it lives next to the project directory).
  let subRepoWorktrees: Array<{ name: string; repoPath: string; worktreePath: string }> | undefined;
  if (dependencies.workspaceRegistry) {
    try {
      const workspaceId = normalizeWorkspaceId(resolvedTarget.targetPath);
      const workspace = await dependencies.workspaceRegistry.get(workspaceId);
      if (workspace?.subRepoWorktrees?.length) {
        subRepoWorktrees = workspace.subRepoWorktrees;
      }
    } catch {
      // best-effort: if lookup fails, proceed without subRepoWorktrees
    }
  }

  const isMultiGit = subRepoWorktrees !== undefined;

  const ownership = await isPaseoOwnedWorktreeCwd(resolvedTarget.targetPath, {
    paseoHome: dependencies.paseoHome,
    worktreesRoot: dependencies.worktreesRoot,
  });

  // Multi-git workspaces live outside the Paseo worktrees base root (the
  // workspaceRoot is placed next to the project dir), so they never pass the
  // ownership check. Allow archive if we confirmed this is a multi_git workspace.
  if (!ownership.allowed && !isMultiGit) {
    return {
      ok: false,
      code: "NOT_ALLOWED",
      message: "Worktree is not a Paseo-owned worktree",
      removedAgents: [],
    };
  }

  const repoRoot = ownership.repoRoot ?? resolvedTarget.repoRoot ?? null;

  const removedAgents = await archivePaseoWorktree(dependencies, {
    targetPath: resolvedTarget.targetPath,
    repoRoot,
    worktreesRoot: ownership.worktreeRoot,
    worktreesBaseRoot: dependencies.worktreesRoot,
    requestId: input.requestId,
    subRepoWorktrees,
  });

  return {
    ok: true,
    removedAgents,
  };
}

interface ResolvedArchiveTarget {
  targetPath: string;
  repoRoot: string | null;
}

async function resolveArchiveTarget(
  dependencies: ArchivePaseoWorktreeCommandDependencies,
  input: ArchivePaseoWorktreeCommandInput,
): Promise<ResolvedArchiveTarget> {
  const repoRoot = input.repoRoot ?? null;
  if (input.worktreePath) {
    return { targetPath: input.worktreePath, repoRoot };
  }

  if (input.worktreeSlug) {
    if (!repoRoot) {
      throw new Error("repoRoot is required when worktreeSlug is supplied");
    }
    return {
      targetPath: await resolveWorktreeSlugPath(dependencies, repoRoot, input.worktreeSlug),
      repoRoot,
    };
  }

  if (repoRoot && input.branchName) {
    const worktrees = await dependencies.workspaceGitService.listWorktrees(repoRoot);
    const match = worktrees.find((entry) => entry.branchName === input.branchName);
    if (!match) {
      throw new Error(`Paseo worktree not found for branch ${input.branchName}`);
    }
    return { targetPath: match.path, repoRoot };
  }

  throw new Error("worktreePath, worktreeSlug, or repoRoot+branchName is required");
}

async function resolveWorktreeSlugPath(
  dependencies: ArchivePaseoWorktreeCommandDependencies,
  repoRoot: string,
  worktreeSlug: string,
): Promise<string> {
  const worktreesRoot = await getPaseoWorktreesRoot(
    repoRoot,
    dependencies.paseoHome,
    dependencies.worktreesRoot,
  );
  return join(worktreesRoot, worktreeSlug);
}
