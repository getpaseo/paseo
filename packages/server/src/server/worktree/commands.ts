import { join } from "node:path";

import { getPaseoWorktreesRoot, isPaseoOwnedWorktreeCwd } from "../../utils/worktree.js";
import {
  archiveByScope,
  resolveWorkspaceIdAtPath,
  type ArchiveDependencies,
  type ArchiveScope,
} from "../workspace-archive-service.js";
import type {
  CreatePaseoWorktreeInput,
  CreatePaseoWorktreeResult,
} from "../paseo-worktree-service.js";
import { toWorktreeWireError, type WorktreeWireError } from "../worktree-errors.js";
import type { WorkspaceGitService, WorkspaceGitWorktreeInfo } from "../workspace-git-service.js";

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

export interface ArchiveCommandDependencies extends Omit<
  ArchiveDependencies,
  "workspaceGitService"
> {
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot" | "listWorktrees">;
}

export interface ArchiveCommandInput {
  requestId: string;
  repoRoot?: string | null;
  worktreePath?: string;
  worktreeSlug?: string;
  branchName?: string;
  workspaceId?: string;
  scope?: ArchiveScope["kind"];
}

export type ArchiveCommandResult =
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

export async function archiveCommand(
  dependencies: ArchiveCommandDependencies,
  input: ArchiveCommandInput,
): Promise<ArchiveCommandResult> {
  const resolvedTarget = await resolveArchiveTarget(dependencies, input);
  const scope = input.scope ?? "workspace";

  if (scope === "worktree") {
    const ownership = await isPaseoOwnedWorktreeCwd(resolvedTarget.targetPath, {
      paseoHome: dependencies.paseoHome,
      worktreesRoot: dependencies.paseoWorktreesBaseRoot,
    });

    if (!ownership.allowed) {
      return {
        ok: false,
        code: "NOT_ALLOWED",
        message: "Worktree is not a Paseo-owned worktree",
        removedAgents: [],
      };
    }

    const result = await archiveByScope(dependencies, {
      scope: { kind: "worktree", targetPath: resolvedTarget.targetPath },
      repoRoot: ownership.repoRoot ?? resolvedTarget.repoRoot ?? null,
      repoWorktreesRoot: ownership.worktreeRoot,
      paseoWorktreesBaseRoot: dependencies.paseoWorktreesBaseRoot,
      requestId: input.requestId,
    });

    return {
      ok: true,
      removedAgents: result.archivedAgentIds,
    };
  }

  const workspaceId =
    input.workspaceId ?? (await resolveWorkspaceIdAtPath(dependencies, resolvedTarget.targetPath));

  if (!workspaceId) {
    dependencies.sessionLogger?.warn(
      { targetPath: resolvedTarget.targetPath },
      "Could not resolve workspace for archive; skipping",
    );
    return {
      ok: true,
      removedAgents: [],
    };
  }

  const result = await archiveByScope(dependencies, {
    scope: { kind: "workspace", workspaceId },
    repoRoot: resolvedTarget.repoRoot,
    paseoWorktreesBaseRoot: dependencies.paseoWorktreesBaseRoot,
    requestId: input.requestId,
  });

  return {
    ok: true,
    removedAgents: result.archivedAgentIds,
  };
}

interface ResolvedArchiveTarget {
  targetPath: string;
  repoRoot: string | null;
}

async function resolveArchiveTarget(
  dependencies: ArchiveCommandDependencies,
  input: ArchiveCommandInput,
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
  dependencies: ArchiveCommandDependencies,
  repoRoot: string,
  worktreeSlug: string,
): Promise<string> {
  const worktreesRoot = await getPaseoWorktreesRoot(
    repoRoot,
    dependencies.paseoHome,
    dependencies.paseoWorktreesBaseRoot,
  );
  return join(worktreesRoot, worktreeSlug);
}
