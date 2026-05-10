import { join } from "node:path";

import { getPaseoWorktreesRoot, isPaseoOwnedWorktreeCwd } from "../../utils/worktree.js";
import {
  archivePaseoWorktree,
  type ArchivePaseoWorktreeDependencies,
} from "../paseo-worktree-archive-service.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";

export interface ArchivePaseoWorktreeCommandDependencies extends Omit<
  ArchivePaseoWorktreeDependencies,
  "workspaceGitService"
> {
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot" | "listWorktrees">;
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
  const ownership = await isPaseoOwnedWorktreeCwd(resolvedTarget.targetPath, {
    paseoHome: dependencies.paseoHome,
  });

  if (!ownership.allowed) {
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
    requestId: input.requestId,
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
  const worktreesRoot = await getPaseoWorktreesRoot(repoRoot, dependencies.paseoHome);
  return join(worktreesRoot, worktreeSlug);
}
