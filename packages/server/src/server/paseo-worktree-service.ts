import type { WorkspaceGitService } from "./workspace-git-service.js";
import { resolve } from "node:path";
import {
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";
import { generateWorkspaceId } from "./workspace-registry-model.js";
import {
  createWorktreeCore,
  type CreateWorktreeCoreDeps,
  type CreateWorktreeCoreInput,
} from "./worktree-core.js";
import { validateBranchSlug, type WorktreeConfig } from "../utils/worktree.js";
import { getCurrentBranch, localBranchExists, renameCurrentBranch } from "../utils/checkout-git.js";
import {
  markPaseoWorktreeFirstAgentBranchAutoNameAttempted,
  normalizeBaseRefName,
  readPaseoWorktreeMetadata,
  writePaseoWorktreeFirstAgentBranchAutoNameMetadata,
} from "../utils/worktree-metadata.js";
import type { WorktreeCreationIntent } from "./resolve-worktree-creation-intent.js";
import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
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
  projectRegistry: Pick<ProjectRegistry, "get" | "getOrCreateActiveByRoot" | "upsert">;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "list" | "upsert">;
  workspaceGitService: WorkspaceGitService;
}

export async function createPaseoWorktree(
  input: CreatePaseoWorktreeInput,
  deps: CreatePaseoWorktreeDeps,
): Promise<CreatePaseoWorktreeResult> {
  const createdWorktree = await createWorktreeCore(input, deps);
  maybeMarkFirstAgentBranchAutoNameEligible({ createdWorktree });
  const workspace = await upsertWorkspaceForWorktree({
    inputCwd: input.cwd,
    projectId: input.projectId,
    repoRoot: createdWorktree.repoRoot,
    worktree: createdWorktree.worktree,
    baseBranch: resolveIntentBaseBranch(createdWorktree.intent),
    title: resolveFirstAgentPromptTitle(input.firstAgentContext),
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

// The base branch is normalized to match worktree.json's baseRefName (origin/
// stripped). checkout-branch worktrees have no distinct base, so they stay null.
function resolveIntentBaseBranch(intent: WorktreeCreationIntent): string | null {
  switch (intent.kind) {
    case "branch-off":
      return normalizeBaseRefName(intent.baseBranch);
    case "checkout-change-request":
      return normalizeBaseRefName(intent.baseRefName);
    case "checkout-github-pr":
      return normalizeBaseRefName(intent.baseRefName);
    case "checkout-branch":
      return null;
  }
}

async function upsertWorkspaceForWorktree(options: {
  inputCwd: string;
  projectId?: string;
  repoRoot: string;
  worktree: WorktreeConfig;
  baseBranch?: string | null;
  title?: string | null;
  deps: Pick<
    CreatePaseoWorktreeDeps,
    "projectRegistry" | "workspaceRegistry" | "workspaceGitService"
  >;
}): Promise<PersistedWorkspaceRecord> {
  const normalizedCwd = resolve(options.worktree.worktreePath);
  const normalizedInputCwd = resolve(options.inputCwd);
  const normalizedRepoRoot = resolve(options.repoRoot);
  // Creation never deduplicates by directory: a worktree directory may back
  // more than one workspace. We still resolve the source project from the
  // originating checkout, but always mint a fresh workspace record.
  const sourceProjectId = await resolveSourceProjectIdForWorktree({
    inputCwd: normalizedInputCwd,
    projectId: options.projectId,
    repoRoot: normalizedRepoRoot,
    deps: options.deps,
  });
  const workspaceId = generateWorkspaceId();
  const now = new Date().toISOString();

  const workspace = createPersistedWorkspaceRecord({
    workspaceId,
    projectId: sourceProjectId,
    cwd: normalizedCwd,
    kind: "worktree",
    displayName: options.worktree.branchName || normalizedCwd,
    branch: options.worktree.branchName || null,
    baseBranch: options.baseBranch ?? null,
    isPaseoOwnedWorktree: true,
    mainRepoRoot: normalizedRepoRoot,
    title: options.title ?? null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });

  await options.deps.workspaceRegistry.upsert(workspace);
  return (await options.deps.workspaceRegistry.get(workspace.workspaceId)) ?? workspace;
}

async function resolveSourceProjectIdForWorktree(options: {
  inputCwd: string;
  projectId?: string;
  repoRoot: string;
  deps: Pick<
    CreatePaseoWorktreeDeps,
    "projectRegistry" | "workspaceRegistry" | "workspaceGitService"
  >;
}): Promise<string> {
  if (options.projectId) {
    const project = await options.deps.projectRegistry.get(options.projectId);
    if (!project || project.archivedAt) {
      throw new Error(`Project not found for worktree: ${options.projectId}`);
    }
    return (await refreshProjectKind(project, options.deps)).projectId;
  }

  const sourceWorkspace = await findWorkspaceForSource({
    inputCwd: options.inputCwd,
    repoRoot: options.repoRoot,
    workspaceRegistry: options.deps.workspaceRegistry,
  });

  if (sourceWorkspace) {
    const sourceProject = await options.deps.projectRegistry.get(sourceWorkspace.projectId);
    if (sourceProject) return (await refreshProjectKind(sourceProject, options.deps)).projectId;
    // COMPAT(worktreeMissingSourceProject): added in v0.1.107, remove after 2027-01-15.
    // Orphaned legacy workspace FKs fall through to exact-root allocation.
  }

  const project = await options.deps.projectRegistry.getOrCreateActiveByRoot({
    rootPath: options.repoRoot,
    kind: "git",
    displayName: options.repoRoot.split(/[\\/]/).findLast(Boolean) ?? options.repoRoot,
    timestamp: new Date().toISOString(),
  });
  return (await refreshProjectKind(project, options.deps)).projectId;
}

async function refreshProjectKind(
  project: PersistedProjectRecord,
  deps: Pick<CreatePaseoWorktreeDeps, "projectRegistry" | "workspaceGitService">,
): Promise<PersistedProjectRecord> {
  const checkout = await deps.workspaceGitService.getCheckout(project.rootPath);
  const kind: PersistedProjectRecord["kind"] = checkout.isGit ? "git" : "non_git";
  if (project.kind === kind) return project;

  const refreshed = { ...project, kind, updatedAt: new Date().toISOString() };
  await deps.projectRegistry.upsert(refreshed);
  return refreshed;
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
