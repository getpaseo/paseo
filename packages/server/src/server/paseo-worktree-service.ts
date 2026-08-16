import { resolve } from "node:path";

import type { WorkspaceGitService } from "./workspace-git-service.js";
import { getRealpathAwareRelativePath } from "../utils/path.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";
import type { WorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import {
  type CreateWorktreeCoreDeps,
  type CreateWorktreeCoreInput,
  planWorktreeCore,
} from "./worktree-core.js";
import { validateBranchSlug, type WorktreeConfig } from "../utils/worktree.js";
import { getCurrentBranch, localBranchExists, renameCurrentBranch } from "../utils/checkout-git.js";
import {
  markPaseoWorktreeFirstAgentBranchAutoNameAttempted,
  normalizeBaseRefName,
  readPaseoWorktreeMetadata,
} from "../utils/worktree-metadata.js";
import type { WorktreeCreationIntent } from "./resolve-worktree-creation-intent.js";
import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
import { buildAgentBranchNameSeed } from "./agent/prompt-attachments.js";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";
import { runWithGitCommandPriority } from "../utils/run-git-command.js";
import type { WorkspaceRuntimeService } from "./workspace-runtime/index.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";

export interface CreatePaseoWorktreeInput extends CreateWorktreeCoreInput {
  projectId?: string;
  title?: string;
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
  workspaceGitService: WorkspaceGitService;
  workspaceProvisioning: Pick<WorkspaceProvisioningService, "reserveRuntimeWorktreeWorkspace">;
  workspaceRuntime: WorkspaceRuntimeService;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "remove" | "update">;
}

export async function createPaseoWorktree(
  input: CreatePaseoWorktreeInput,
  deps: CreatePaseoWorktreeDeps,
): Promise<CreatePaseoWorktreeResult> {
  return runWithGitCommandPriority("high", () => createPaseoWorktreeWithPriority(input, deps));
}

async function createPaseoWorktreeWithPriority(
  input: CreatePaseoWorktreeInput,
  deps: CreatePaseoWorktreeDeps,
): Promise<CreatePaseoWorktreeResult> {
  const workspaceCwdPlan = await planWorkspaceCwdForWorktree(input.cwd, deps.workspaceGitService);
  const plan = await planWorktreeCore(input, deps);
  const branchName = resolveIntentBranch(plan.intent);
  const workspace = await deps.workspaceProvisioning.reserveRuntimeWorktreeWorkspace({
    sourceCwd: workspaceCwdPlan.inputCwd,
    projectId: input.projectId,
    repoRoot: plan.repoRoot,
    branch: branchName,
    baseBranch: resolveIntentBaseBranch(plan.intent),
    title: input.title?.trim() || resolveFirstAgentPromptTitle(input.firstAgentContext),
    expectsInitialAgent: Boolean(input.firstAgentContext),
  });
  try {
    const placement = await deps.workspaceRuntime.create({
      workspaceId: workspace.workspaceId,
      runtimeId: "worktree",
      project: { id: workspace.projectId, source: { kind: "host-directory", path: plan.repoRoot } },
      placement: {
        kind: "resolved-worktree",
        source: plan.intent,
        worktreeSlug: plan.worktreeSlug,
        ...(workspaceCwdPlan.relativeWorkspaceCwd
          ? { relativeCwd: workspaceCwdPlan.relativeWorkspaceCwd }
          : {}),
      },
      markFirstAgentBranchAutoName: plan.intent.kind === "branch-off",
      seedPaseoConfigFrom: workspaceCwdPlan.inputCwd,
    });
    if (!placement.hostVisiblePath) {
      throw new Error(`Worktree runtime has no host-visible path: ${workspace.workspaceId}`);
    }
    const worktreeRoot = resolvePublicWorktreeRoot(
      placement.hostVisiblePath,
      workspaceCwdPlan.relativeWorkspaceCwd,
    );
    const persistedWorkspace = await deps.workspaceRegistry.update(
      workspace.workspaceId,
      (record) => ({ ...record, worktreeRoot }),
    );
    if (!persistedWorkspace) {
      throw new Error(`Created workspace record is missing: ${workspace.workspaceId}`);
    }
    const worktree = {
      branchName,
      worktreePath: worktreeRoot,
    };
    deps.github.invalidate({ cwd: worktree.worktreePath });

    return {
      worktree,
      intent: plan.intent,
      workspace: persistedWorkspace,
      repoRoot: plan.repoRoot,
      created: placement.materializedFreshContent,
    };
  } catch (error) {
    await deps.workspaceRuntime
      .destroy(workspace.workspaceId)
      .catch(() => deps.workspaceRegistry.remove(workspace.workspaceId));
    throw error;
  }
}

function resolvePublicWorktreeRoot(compatibilityCwd: string, relativeWorkspaceCwd: string): string {
  if (!relativeWorkspaceCwd) return compatibilityCwd;
  const depth = relativeWorkspaceCwd.split(/[\\/]/u).filter(Boolean).length;
  return resolve(compatibilityCwd, ...Array.from({ length: depth }, () => ".."));
}

async function planWorkspaceCwdForWorktree(
  inputCwd: string,
  workspaceGitService: Pick<WorkspaceGitService, "getCheckout">,
): Promise<{ inputCwd: string; relativeWorkspaceCwd: string }> {
  const normalizedInputCwd = resolve(inputCwd);
  const sourceCheckout = await workspaceGitService.getCheckout(normalizedInputCwd);
  const sourceWorktreePath = sourceCheckout.worktreeRoot ?? normalizedInputCwd;
  const relativeWorkspaceCwd = getRealpathAwareRelativePath(sourceWorktreePath, normalizedInputCwd);
  if (relativeWorkspaceCwd === null) {
    throw new Error(`Workspace cwd is outside its source worktree: ${normalizedInputCwd}`);
  }
  return { inputCwd: normalizedInputCwd, relativeWorkspaceCwd };
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

function resolveIntentBranch(intent: WorktreeCreationIntent): string {
  switch (intent.kind) {
    case "branch-off":
    case "checkout-branch":
      return intent.branchName;
    case "checkout-change-request":
    case "checkout-github-pr":
      return intent.localBranchName ?? intent.headRef;
  }
}
