import type { WorkspaceGitService } from "./workspace-git-service.js";
import {
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";
import { deriveProjectGroupingName, normalizeWorkspaceId } from "./workspace-registry-model.js";
import {
  createWorktreeCore,
  type CreateWorktreeCoreDeps,
  type CreateWorktreeCoreInput,
} from "./worktree-core.js";
import type { WorktreeConfig } from "../utils/worktree.js";
import type { WorktreeCreationIntent } from "./resolve-worktree-creation-intent.js";

export interface CreatePaseoWorktreeInput extends CreateWorktreeCoreInput {}

export interface CreatePaseoWorktreeResult {
  worktree: WorktreeConfig;
  intent: WorktreeCreationIntent;
  workspace: PersistedWorkspaceRecord;
  repoRoot: string;
  created: boolean;
}

export type CreatePaseoWorktreeFn = (
  input: CreatePaseoWorktreeInput,
  options?: {
    resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
  },
) => Promise<CreatePaseoWorktreeResult>;

export interface CreatePaseoWorktreeDeps extends CreateWorktreeCoreDeps {
  projectRegistry: Pick<ProjectRegistry, "get" | "upsert">;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "list" | "upsert">;
  workspaceGitService: WorkspaceGitService;
}

export async function createPaseoWorktree(
  input: CreatePaseoWorktreeInput,
  deps: CreatePaseoWorktreeDeps,
): Promise<CreatePaseoWorktreeResult> {
  const createdWorktree = await createWorktreeCore(input, deps);
  const workspace = await upsertWorkspaceForWorktree({
    inputCwd: input.cwd,
    repoRoot: createdWorktree.repoRoot,
    worktree: createdWorktree.worktree,
    deps,
  });

  deps.github.invalidate({ cwd: createdWorktree.worktree.worktreePath });

  return {
    worktree: createdWorktree.worktree,
    intent: createdWorktree.intent,
    workspace,
    repoRoot: createdWorktree.repoRoot,
    created: createdWorktree.created,
  };
}

async function upsertWorkspaceForWorktree(options: {
  inputCwd: string;
  repoRoot: string;
  worktree: WorktreeConfig;
  deps: Pick<CreatePaseoWorktreeDeps, "projectRegistry" | "workspaceRegistry">;
}): Promise<PersistedWorkspaceRecord> {
  const normalizedCwd = normalizeWorkspaceId(options.worktree.worktreePath);
  const normalizedInputCwd = normalizeWorkspaceId(options.inputCwd);
  const normalizedRepoRoot = normalizeWorkspaceId(options.repoRoot);
  const existingWorkspace = await findWorkspaceByDirectory(
    normalizedCwd,
    options.deps.workspaceRegistry,
  );
  const sourceProject = await resolveSourceProjectForWorktree({
    inputCwd: normalizedInputCwd,
    repoRoot: normalizedRepoRoot,
    existingWorkspace,
    deps: options.deps,
  });
  const workspaceId = normalizedCwd;
  const now = new Date().toISOString();

  await options.deps.projectRegistry.upsert(
    createPersistedProjectRecord({
      projectId: sourceProject.projectId,
      rootPath: sourceProject.rootPath,
      kind: sourceProject.kind,
      displayName: sourceProject.displayName,
      createdAt: sourceProject.createdAt ?? now,
      updatedAt: now,
      archivedAt: null,
    }),
  );

  const workspace = createPersistedWorkspaceRecord({
    workspaceId,
    projectId: sourceProject.projectId,
    cwd: normalizedCwd,
    kind: "worktree",
    displayName: options.worktree.branchName || normalizedCwd,
    createdAt: existingWorkspace?.createdAt ?? now,
    updatedAt: now,
    archivedAt: null,
  });

  await options.deps.workspaceRegistry.upsert(workspace);
  return (await options.deps.workspaceRegistry.get(workspace.workspaceId)) ?? workspace;
}

async function resolveSourceProjectForWorktree(options: {
  inputCwd: string;
  repoRoot: string;
  existingWorkspace: PersistedWorkspaceRecord | null;
  deps: Pick<CreatePaseoWorktreeDeps, "projectRegistry" | "workspaceRegistry">;
}): Promise<{
  projectId: string;
  rootPath: string;
  kind: "git";
  displayName: string;
  createdAt: string | null;
}> {
  const sourceWorkspace =
    options.existingWorkspace ??
    (await findWorkspaceForSource({
      inputCwd: options.inputCwd,
      repoRoot: options.repoRoot,
      workspaceRegistry: options.deps.workspaceRegistry,
    }));
  const sourceProject = sourceWorkspace
    ? await options.deps.projectRegistry.get(sourceWorkspace.projectId)
    : null;

  if (sourceWorkspace) {
    return {
      projectId: sourceWorkspace.projectId,
      rootPath: sourceProject?.rootPath ?? options.repoRoot,
      kind: "git",
      displayName:
        sourceProject?.displayName ?? deriveProjectGroupingName(sourceWorkspace.projectId),
      createdAt: sourceProject?.createdAt ?? null,
    };
  }

  const existingFallbackProject = await options.deps.projectRegistry.get(options.repoRoot);
  return {
    projectId: options.repoRoot,
    rootPath: existingFallbackProject?.rootPath ?? options.repoRoot,
    kind: "git",
    displayName:
      existingFallbackProject?.displayName ?? deriveProjectGroupingName(options.repoRoot),
    createdAt: existingFallbackProject?.createdAt ?? null,
  };
}

async function findWorkspaceForSource(options: {
  inputCwd: string;
  repoRoot: string;
  workspaceRegistry: Pick<WorkspaceRegistry, "list">;
}): Promise<PersistedWorkspaceRecord | null> {
  const workspaces = await options.workspaceRegistry.list();
  return (
    workspaces.find((workspace) => workspace.cwd === options.inputCwd && !workspace.archivedAt) ??
    workspaces.find((workspace) => workspace.cwd === options.repoRoot && !workspace.archivedAt) ??
    null
  );
}

async function findWorkspaceByDirectory(
  cwd: string,
  workspaceRegistry: Pick<WorkspaceRegistry, "list">,
): Promise<PersistedWorkspaceRecord | null> {
  const workspaces = await workspaceRegistry.list();
  return workspaces.find((workspace) => workspace.cwd === cwd) ?? null;
}
