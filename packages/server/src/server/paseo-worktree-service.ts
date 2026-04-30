import { basename } from "node:path";

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
import { validateBranchSlug } from "../utils/worktree.js";
import { renameCurrentBranch } from "../utils/checkout-git.js";
import {
  markPaseoWorktreeFirstAgentBranchAutoNameAttempted,
  readPaseoWorktreeMetadata,
  writePaseoWorktreeFirstAgentBranchAutoNameMetadata,
} from "../utils/worktree-metadata.js";
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

export interface AttemptFirstAgentBranchAutoNameResult {
  attempted: boolean;
  renamed: boolean;
  branchName: string | null;
}

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
  maybeMarkFirstAgentBranchAutoNameEligible({ input, createdWorktree });
  const worktree = await maybeAutoNameCreatedWorktree({
    input,
    createdWorktree,
    deps,
  });
  const workspace = await upsertWorkspaceForWorktree({
    inputCwd: input.cwd,
    repoRoot: createdWorktree.repoRoot,
    worktree,
    deps,
  });

  deps.github.invalidate({ cwd: worktree.worktreePath });

  return {
    worktree,
    intent: createdWorktree.intent,
    workspace,
    repoRoot: createdWorktree.repoRoot,
    created: createdWorktree.created,
  };
}

export async function attemptFirstAgentBranchAutoName(options: {
  cwd: string;
  nameContext?: string;
  generateBranchName: (seed: string | undefined) => string;
  renameCurrentBranch?: typeof renameCurrentBranch;
}): Promise<AttemptFirstAgentBranchAutoNameResult> {
  const nameContext = options.nameContext?.trim();
  if (!nameContext) {
    return { attempted: false, renamed: false, branchName: null };
  }

  let metadata: ReturnType<typeof readPaseoWorktreeMetadata>;
  try {
    metadata = readPaseoWorktreeMetadata(options.cwd);
  } catch {
    return { attempted: false, renamed: false, branchName: null };
  }
  if (
    !metadata ||
    metadata.version !== 2 ||
    metadata.firstAgentBranchAutoName?.status !== "pending"
  ) {
    return { attempted: false, renamed: false, branchName: null };
  }

  markPaseoWorktreeFirstAgentBranchAutoNameAttempted(options.cwd);

  const branchName = options.generateBranchName(nameContext);
  const validation = validateBranchSlug(branchName);
  if (!validation.valid || branchName === metadata.firstAgentBranchAutoName.placeholderBranchName) {
    return { attempted: true, renamed: false, branchName: null };
  }

  const renameCurrentBranchImpl = options.renameCurrentBranch ?? renameCurrentBranch;
  const renamedBranch = await renameCurrentBranchImpl(options.cwd, branchName);
  return {
    attempted: true,
    renamed: true,
    branchName: renamedBranch.currentBranch ?? branchName,
  };
}

function maybeMarkFirstAgentBranchAutoNameEligible(options: {
  input: CreatePaseoWorktreeInput;
  createdWorktree: Awaited<ReturnType<typeof createWorktreeCore>>;
}): void {
  const { input, createdWorktree } = options;
  if (
    !createdWorktree.created ||
    input.worktreeSlug ||
    createdWorktree.intent.kind !== "branch-off"
  ) {
    return;
  }

  writePaseoWorktreeFirstAgentBranchAutoNameMetadata(createdWorktree.worktree.worktreePath, {
    placeholderBranchName: createdWorktree.worktree.branchName,
  });
}

async function maybeAutoNameCreatedWorktree(options: {
  input: CreatePaseoWorktreeInput;
  createdWorktree: Awaited<ReturnType<typeof createWorktreeCore>>;
  deps: Pick<CreatePaseoWorktreeDeps, "generateBranchName">;
}): Promise<WorktreeConfig> {
  const { input, createdWorktree, deps } = options;
  const nameContext = input.nameContext?.trim();
  if (
    !nameContext ||
    input.worktreeSlug ||
    !createdWorktree.created ||
    createdWorktree.intent.kind !== "branch-off"
  ) {
    return createdWorktree.worktree;
  }

  const generatedPlaceholderName = basename(createdWorktree.worktree.worktreePath);
  if (
    !generatedPlaceholderName ||
    createdWorktree.worktree.branchName !== generatedPlaceholderName
  ) {
    return createdWorktree.worktree;
  }

  markPaseoWorktreeFirstAgentBranchAutoNameAttempted(createdWorktree.worktree.worktreePath);

  const branchName = deps.generateBranchName(nameContext);
  const validation = validateBranchSlug(branchName);
  if (!validation.valid || branchName === createdWorktree.worktree.branchName) {
    return createdWorktree.worktree;
  }

  const renamedBranch = await renameCurrentBranch(
    createdWorktree.worktree.worktreePath,
    branchName,
  );
  return {
    ...createdWorktree.worktree,
    branchName: renamedBranch.currentBranch ?? branchName,
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
