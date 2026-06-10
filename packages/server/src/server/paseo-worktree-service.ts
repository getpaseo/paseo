import { promises as fs } from "node:fs";
import path from "node:path";

import type { WorkspaceGitService } from "./workspace-git-service.js";
import {
  type PersistedProjectRecord,
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
import { slugify, validateBranchSlug, type WorktreeConfig } from "../utils/worktree.js";
import { getCurrentBranch, localBranchExists, renameCurrentBranch } from "../utils/checkout-git.js";
import {
  markPaseoWorktreeFirstAgentBranchAutoNameAttempted,
  readPaseoWorktreeMetadata,
  writePaseoWorktreeFirstAgentBranchAutoNameMetadata,
} from "../utils/worktree-metadata.js";
import type { WorktreeCreationIntent } from "./resolve-worktree-creation-intent.js";
import { buildAgentBranchNameSeed } from "./agent/prompt-attachments.js";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";

export interface CreatePaseoWorktreeInput extends CreateWorktreeCoreInput {
  projectId?: string;
}

export interface CreatePaseoWorktreeResult {
  worktree: WorktreeConfig;
  intent: WorktreeCreationIntent;
  workspace: PersistedWorkspaceRecord;
  repoRoot: string;
  created: boolean;
  /** Root path of the project that owns this worktree.  For multi_git projects
   *  this is the parent folder that contains paseo.json; for standard git
   *  projects it equals repoRoot. */
  projectRootPath: string;
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
  // Route multi_git projects to dedicated handler
  if (input.projectId) {
    const project = await deps.projectRegistry.get(input.projectId);
    if (
      project &&
      !project.archivedAt &&
      project.kind === "multi_git" &&
      project.subRepos?.length
    ) {
      return createMultiGitWorktree(input, project, deps);
    }
  }

  const createdWorktree = await createWorktreeCore(input, deps);
  maybeMarkFirstAgentBranchAutoNameEligible({ createdWorktree });
  const { workspace, projectRootPath } = await upsertWorkspaceForWorktree({
    inputCwd: input.cwd,
    projectId: input.projectId,
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
    projectRootPath,
  };
}

async function createMultiGitWorktree(
  input: CreatePaseoWorktreeInput,
  project: PersistedProjectRecord,
  deps: CreatePaseoWorktreeDeps,
): Promise<CreatePaseoWorktreeResult> {
  const subRepos = project.subRepos!;

  // Step 1: Create a worktree for each sub-repo sequentially, using the same
  // branchSlug across all repos.  For the first sub-repo we let createWorktreeCore
  // generate/resolve the slug; for subsequent ones we re-use that slug so all
  // worktrees land on the same branch name.
  const subRepoWorktrees: Array<{ name: string; repoPath: string; worktreePath: string }> = [];
  let firstCreatedWorktree: Awaited<ReturnType<typeof createWorktreeCore>> | null = null;
  let resolvedBranchSlug: string | undefined;

  for (const subRepoPath of subRepos) {
    const folderName = path.basename(subRepoPath);

    const createdWorktree = await createWorktreeCore(
      {
        ...input,
        cwd: subRepoPath,
        // After the first sub-repo we lock in the slug so all repos use the same branch.
        worktreeSlug: resolvedBranchSlug ?? input.worktreeSlug,
      },
      deps,
    );

    if (!firstCreatedWorktree) {
      firstCreatedWorktree = createdWorktree;
      // Derive the slug from the actual branch name of the first worktree
      resolvedBranchSlug = createdWorktree.worktree.branchName;
      maybeMarkFirstAgentBranchAutoNameEligible({ createdWorktree });
    }

    subRepoWorktrees.push({
      name: folderName,
      repoPath: subRepoPath,
      worktreePath: createdWorktree.worktree.worktreePath,
    });

    deps.github.invalidate({ cwd: createdWorktree.worktree.worktreePath });
  }

  if (!firstCreatedWorktree || !resolvedBranchSlug) {
    throw new Error("No sub-repos produced a worktree");
  }

  // Step 2: Compute workspace root using the resolved slug and create the directory.
  // workspaceRoot acts as the cwd for the setup script — it is a plain directory,
  // not a git repo itself.
  const branchSlug = slugify(resolvedBranchSlug);
  const workspaceRoot = path.join(
    path.dirname(project.rootPath),
    path.basename(project.rootPath) + "-workspaces",
    branchSlug,
  );
  await fs.mkdir(workspaceRoot, { recursive: true });

  // Step 3: Upsert the project record (refresh timestamps).
  const now = new Date().toISOString();
  await deps.projectRegistry.upsert(
    createPersistedProjectRecord({
      projectId: project.projectId,
      rootPath: project.rootPath,
      kind: project.kind,
      displayName: project.displayName,
      customName: project.customName,
      subRepos: project.subRepos,
      createdAt: project.createdAt ?? now,
      updatedAt: now,
      archivedAt: null,
    }),
  );

  // Step 4: Create workspace record with cwd = workspaceRoot and kind = "directory".
  const normalizedWorkspaceRoot = normalizeWorkspaceId(workspaceRoot);
  const existingWorkspace = await deps.workspaceRegistry
    .list()
    .then((ws) => ws.find((w) => w.cwd === normalizedWorkspaceRoot) ?? null);

  const workspace = createPersistedWorkspaceRecord({
    workspaceId: normalizedWorkspaceRoot,
    projectId: project.projectId,
    cwd: normalizedWorkspaceRoot,
    kind: "directory",
    displayName: firstCreatedWorktree.worktree.branchName || normalizedWorkspaceRoot,
    subRepoWorktrees,
    createdAt: existingWorkspace?.createdAt ?? now,
    updatedAt: now,
    archivedAt: null,
  });

  await deps.workspaceRegistry.upsert(workspace);
  const persistedWorkspace = (await deps.workspaceRegistry.get(workspace.workspaceId)) ?? workspace;

  return {
    worktree: firstCreatedWorktree.worktree,
    intent: firstCreatedWorktree.intent,
    workspace: persistedWorkspace,
    repoRoot: firstCreatedWorktree.repoRoot,
    created: firstCreatedWorktree.created,
    projectRootPath: workspaceRoot,
  };
}

export async function attemptFirstAgentBranchAutoName(options: {
  cwd: string;
  firstAgentContext: FirstAgentContext | undefined;
  generateBranchNameFromContext: (input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }) => Promise<string | null>;
  getCurrentBranch?: typeof getCurrentBranch;
  renameCurrentBranch?: typeof renameCurrentBranch;
  localBranchExists?: typeof localBranchExists;
}): Promise<AttemptFirstAgentBranchAutoNameResult> {
  const firstAgentContext = options.firstAgentContext;
  if (!firstAgentContext || !buildAgentBranchNameSeed(firstAgentContext)) {
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

  const getCurrentBranchImpl = options.getCurrentBranch ?? getCurrentBranch;
  const placeholderBranchName = metadata.firstAgentBranchAutoName.placeholderBranchName;
  if ((await getCurrentBranchImpl(options.cwd)) !== placeholderBranchName) {
    markPaseoWorktreeFirstAgentBranchAutoNameAttempted(options.cwd);
    return { attempted: true, renamed: false, branchName: null };
  }

  markPaseoWorktreeFirstAgentBranchAutoNameAttempted(options.cwd);

  const branchName = await options.generateBranchNameFromContext({
    cwd: options.cwd,
    firstAgentContext,
  });
  if (!branchName) {
    return { attempted: true, renamed: false, branchName: null };
  }
  const validation = validateBranchSlug(branchName);
  if (!validation.valid || branchName === placeholderBranchName) {
    return { attempted: true, renamed: false, branchName: null };
  }
  if ((await getCurrentBranchImpl(options.cwd)) !== placeholderBranchName) {
    return { attempted: true, renamed: false, branchName: null };
  }

  const localBranchExistsImpl = options.localBranchExists ?? localBranchExists;
  const targetName = await findAvailableBranchName({
    cwd: options.cwd,
    desiredName: branchName,
    placeholderBranchName,
    localBranchExists: localBranchExistsImpl,
  });
  if (!targetName) {
    return { attempted: true, renamed: false, branchName: null };
  }

  const renameCurrentBranchImpl = options.renameCurrentBranch ?? renameCurrentBranch;
  const renamedBranch = await renameCurrentBranchImpl(options.cwd, targetName);
  return {
    attempted: true,
    renamed: true,
    branchName: renamedBranch.currentBranch ?? targetName,
  };
}

const MAX_BRANCH_NAME_SUFFIX_ATTEMPTS = 50;

async function findAvailableBranchName(options: {
  cwd: string;
  desiredName: string;
  placeholderBranchName: string;
  localBranchExists: (cwd: string, branchName: string) => Promise<boolean>;
}): Promise<string | null> {
  const { cwd, desiredName, placeholderBranchName } = options;
  if (!(await options.localBranchExists(cwd, desiredName))) {
    return desiredName;
  }
  for (let suffix = 2; suffix <= MAX_BRANCH_NAME_SUFFIX_ATTEMPTS; suffix++) {
    const candidate = `${desiredName}-${suffix}`;
    if (candidate === placeholderBranchName) {
      continue;
    }
    if (!(await options.localBranchExists(cwd, candidate))) {
      return candidate;
    }
  }
  return null;
}

function maybeMarkFirstAgentBranchAutoNameEligible(options: {
  createdWorktree: Awaited<ReturnType<typeof createWorktreeCore>>;
}): void {
  const { createdWorktree } = options;
  if (!createdWorktree.created || createdWorktree.intent.kind !== "branch-off") {
    return;
  }

  writePaseoWorktreeFirstAgentBranchAutoNameMetadata(createdWorktree.worktree.worktreePath, {
    placeholderBranchName: createdWorktree.worktree.branchName,
  });
}

async function upsertWorkspaceForWorktree(options: {
  inputCwd: string;
  projectId?: string;
  repoRoot: string;
  worktree: WorktreeConfig;
  deps: Pick<CreatePaseoWorktreeDeps, "projectRegistry" | "workspaceRegistry">;
}): Promise<{ workspace: PersistedWorkspaceRecord; projectRootPath: string }> {
  const normalizedCwd = normalizeWorkspaceId(options.worktree.worktreePath);
  const normalizedInputCwd = normalizeWorkspaceId(options.inputCwd);
  const normalizedRepoRoot = normalizeWorkspaceId(options.repoRoot);
  const existingWorkspace = await findWorkspaceByDirectory(
    normalizedCwd,
    options.deps.workspaceRegistry,
  );
  const sourceProject = await resolveSourceProjectForWorktree({
    inputCwd: normalizedInputCwd,
    projectId: options.projectId,
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
      customName: sourceProject.customName,
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
  const persistedWorkspace =
    (await options.deps.workspaceRegistry.get(workspace.workspaceId)) ?? workspace;
  return { workspace: persistedWorkspace, projectRootPath: sourceProject.rootPath };
}

interface SourceProjectForWorktree {
  projectId: string;
  rootPath: string;
  kind: "git";
  displayName: string;
  customName: string | null;
  createdAt: string | null;
}

function sourceProjectFromRecord(record: {
  projectId: string;
  rootPath: string;
  displayName: string;
  customName?: string | null;
  createdAt?: string | null;
}): SourceProjectForWorktree {
  return {
    projectId: record.projectId,
    rootPath: record.rootPath,
    kind: "git",
    displayName: record.displayName,
    customName: record.customName ?? null,
    createdAt: record.createdAt ?? null,
  };
}

async function resolveExplicitProjectForWorktree(options: {
  projectId: string;
  projectRegistry: Pick<ProjectRegistry, "get">;
}): Promise<SourceProjectForWorktree> {
  const project = await options.projectRegistry.get(options.projectId);
  if (!project || project.archivedAt) {
    throw new Error(`Project not found for worktree: ${options.projectId}`);
  }
  return sourceProjectFromRecord(project);
}

async function resolveWorkspaceProjectForWorktree(options: {
  sourceWorkspace: PersistedWorkspaceRecord;
  repoRoot: string;
  projectRegistry: Pick<ProjectRegistry, "get">;
}): Promise<SourceProjectForWorktree> {
  const sourceProject = await options.projectRegistry.get(options.sourceWorkspace.projectId);
  return sourceProjectFromRecord({
    projectId: options.sourceWorkspace.projectId,
    rootPath: sourceProject?.rootPath ?? options.repoRoot,
    displayName:
      sourceProject?.displayName ?? deriveProjectGroupingName(options.sourceWorkspace.projectId),
    customName: sourceProject?.customName ?? null,
    createdAt: sourceProject?.createdAt ?? null,
  });
}

async function resolveFallbackProjectForWorktree(options: {
  repoRoot: string;
  projectRegistry: Pick<ProjectRegistry, "get">;
}): Promise<SourceProjectForWorktree> {
  const existingFallbackProject = await options.projectRegistry.get(options.repoRoot);
  return sourceProjectFromRecord({
    projectId: options.repoRoot,
    rootPath: existingFallbackProject?.rootPath ?? options.repoRoot,
    displayName:
      existingFallbackProject?.displayName ?? deriveProjectGroupingName(options.repoRoot),
    customName: existingFallbackProject?.customName ?? null,
    createdAt: existingFallbackProject?.createdAt ?? null,
  });
}

async function resolveSourceProjectForWorktree(options: {
  inputCwd: string;
  projectId?: string;
  repoRoot: string;
  existingWorkspace: PersistedWorkspaceRecord | null;
  deps: Pick<CreatePaseoWorktreeDeps, "projectRegistry" | "workspaceRegistry">;
}): Promise<SourceProjectForWorktree> {
  if (options.projectId) {
    return resolveExplicitProjectForWorktree({
      projectId: options.projectId,
      projectRegistry: options.deps.projectRegistry,
    });
  }

  const sourceWorkspace =
    options.existingWorkspace ??
    (await findWorkspaceForSource({
      inputCwd: options.inputCwd,
      repoRoot: options.repoRoot,
      workspaceRegistry: options.deps.workspaceRegistry,
    }));

  if (sourceWorkspace) {
    return resolveWorkspaceProjectForWorktree({
      sourceWorkspace,
      repoRoot: options.repoRoot,
      projectRegistry: options.deps.projectRegistry,
    });
  }

  return resolveFallbackProjectForWorktree({
    repoRoot: options.repoRoot,
    projectRegistry: options.deps.projectRegistry,
  });
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
