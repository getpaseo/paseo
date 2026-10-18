import type { Logger } from "pino";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { WorkspaceGitService } from "./workspace-git-service.js";
import { getRealpathAwareRelativePath } from "../utils/path.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";
import type { WorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import {
  createWorktreeCore,
  type CreateWorktreeCoreDeps,
  type CreateWorktreeCoreInput,
} from "./worktree-core.js";
import {
  mapWorkspaceRelativeCwdToWorktree,
  rollbackCreatedPaseoWorktree,
  seedPaseoConfigFile,
  validateBranchSlug,
  type WorktreeConfig,
} from "../utils/worktree.js";
import { getCurrentBranch, localBranchExists, renameCurrentBranch } from "../utils/checkout-git.js";
import {
  markPaseoWorktreeFirstAgentBranchAutoNameAttempted,
  markPaseoWorktreeFirstAgentBranchAutoNameSucceeded,
  readPaseoWorktreeMetadata,
  writePaseoWorktreeFirstAgentBranchAutoNameMetadata,
} from "../utils/worktree-metadata.js";
import type { WorktreeCreationIntent } from "./resolve-worktree-creation-intent.js";
import { buildAgentBranchNameSeed } from "./agent/prompt-attachments.js";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";
import { createRunGitCommand, runWithGitCommandPriority } from "../utils/run-git-command.js";

export interface CreatePaseoWorktreeInput extends CreateWorktreeCoreInput {
  workspaceId?: string;
  projectId?: string;
  title?: string;
  workspaceIntent?: string;
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
  workspaceProvisioning: Pick<WorkspaceProvisioningService, "createWorkspaceForWorktree">;
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
  const createdWorktree = await createWorktreeCore(input, deps);
  try {
    if (!input.branchName?.trim()) maybeMarkFirstAgentBranchAutoNameEligible({ createdWorktree });
    const workspaceCwd = mapWorkspaceRelativeCwdToWorktree({
      relativeWorkspaceCwd: workspaceCwdPlan.relativeWorkspaceCwd,
      targetWorktreePath: createdWorktree.worktree.worktreePath,
    });
    if (!(await isDirectory(workspaceCwd))) {
      throw new Error(`Selected project directory is missing from the worktree: ${workspaceCwd}`);
    }

    if (createdWorktree.created) {
      await seedPaseoConfigFile({
        sourceCwd: workspaceCwdPlan.inputCwd,
        targetCwd: workspaceCwd,
      });
    }
    const workspace = await deps.workspaceProvisioning.createWorkspaceForWorktree({
      sourceCwd: workspaceCwdPlan.inputCwd,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      repoRoot: createdWorktree.repoRoot,
      cwd: workspaceCwd,
      worktreeRoot: createdWorktree.worktree.worktreePath,
      branch: createdWorktree.worktree.branchName || null,
      baseBranch: createdWorktree.worktree.comparisonBaseRef,
      title: input.title?.trim() || null,
      intent: input.workspaceIntent,
      expectsInitialAgent: Boolean(input.firstAgentContext),
      ...(createdWorktree.intent.kind === "checkout-change-request" &&
      createdWorktree.intent.headRepository
        ? {
            untrustedSource: {
              kind: "change_request" as const,
              forge: createdWorktree.intent.forge,
              number: createdWorktree.intent.changeRequestNumber,
              headRepository: createdWorktree.intent.headRepository,
            },
          }
        : {}),
    });

    deps.github.invalidate({ cwd: createdWorktree.worktree.worktreePath });

    return {
      worktree: createdWorktree.worktree,
      intent: createdWorktree.intent,
      workspace,
      repoRoot: createdWorktree.repoRoot,
      created: createdWorktree.created,
    };
  } catch (error) {
    if (!createdWorktree.created) {
      throw error;
    }
    return rollbackCreatedPaseoWorktree(
      {
        cwd: createdWorktree.repoRoot,
        worktreePath: createdWorktree.worktree.worktreePath,
        ...(input.runSetup === false ? { teardownCwds: [] } : {}),
        paseoHome: input.paseoHome,
        worktreesBaseRoot: input.worktreesRoot,
      },
      error,
    );
  }
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
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

interface AutoNameOptions {
  cwd: string;
  firstAgentContext: FirstAgentContext | undefined;
  generateBranchNameFromContext: (input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }) => Promise<string | null>;
  getCurrentBranch?: typeof getCurrentBranch;
  renameCurrentBranch?: typeof renameCurrentBranch;
  localBranchExists?: typeof localBranchExists;
  isBranchPublished?: typeof isAutoNameBranchPublished;
  logger?: Pick<Logger, "info">;
}

const autoNameInFlight = new Map<string, Promise<AttemptFirstAgentBranchAutoNameResult>>();

export function attemptFirstAgentBranchAutoName(
  options: AutoNameOptions,
): Promise<AttemptFirstAgentBranchAutoNameResult> {
  const key = resolve(options.cwd);
  const existing = autoNameInFlight.get(key);
  if (existing) return existing;
  const operation = attemptAutoName(options).finally(() => autoNameInFlight.delete(key));
  autoNameInFlight.set(key, operation);
  return operation;
}

const runAutoNameGit = createRunGitCommand("workspace-auto-name");

export async function isAutoNameBranchPublished(cwd: string, branch: string): Promise<boolean> {
  const upstream = await runAutoNameGit(
    ["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`],
    { cwd },
  );
  if (upstream.stdout.trim()) return true;
  const remotes = await runAutoNameGit(["remote"], { cwd });
  for (const remote of remotes.stdout.trim().split("\n").filter(Boolean)) {
    // Query the remote itself: a push without -u need not have a tracking ref.
    const refs = await runAutoNameGit(["ls-remote", "--heads", remote, `refs/heads/${branch}`], {
      cwd,
    });
    if (refs.stdout.trim()) return true;
  }
  return false;
}

async function attemptAutoName(
  options: AutoNameOptions,
): Promise<AttemptFirstAgentBranchAutoNameResult> {
  const firstAgentContext = options.firstAgentContext;
  if (!firstAgentContext || !buildAgentBranchNameSeed(firstAgentContext)) {
    return skipAutoName(options, "First message unavailable", false);
  }

  const autoName = readEligibleAutoNameMetadata(options.cwd);
  if (!autoName) return skipAutoName(options, "No pending provisional branch metadata", false);

  const getCurrentBranchImpl = options.getCurrentBranch ?? getCurrentBranch;
  const placeholderBranchName = autoName.placeholderBranchName;
  if (
    ["main", "paseo-local"].includes(placeholderBranchName) ||
    (await getCurrentBranchImpl(options.cwd)) !== placeholderBranchName
  ) {
    markPaseoWorktreeFirstAgentBranchAutoNameAttempted(options.cwd);
    return skipAutoName(options, "Provisional branch changed or protected", true);
  }

  markPaseoWorktreeFirstAgentBranchAutoNameAttempted(options.cwd);

  const branchName = await options.generateBranchNameFromContext({
    cwd: options.cwd,
    firstAgentContext,
  });
  if (!branchName) {
    return skipAutoName(options, "Generation returned no branch", true);
  }
  const validation = validateBranchSlug(branchName);
  if (!validation.valid || branchName === placeholderBranchName) {
    return skipAutoName(options, "Generated branch is invalid or unchanged", true);
  }
  const localBranchExistsImpl = options.localBranchExists ?? localBranchExists;
  const targetName = await findAvailableBranchName({
    cwd: options.cwd,
    desiredName: branchName,
    placeholderBranchName,
    localBranchExists: localBranchExistsImpl,
  });
  if (!targetName) {
    return skipAutoName(options, "No available branch name", true);
  }

  if (
    (await (options.isBranchPublished ?? isAutoNameBranchPublished)(
      options.cwd,
      placeholderBranchName,
    )) ||
    (await getCurrentBranchImpl(options.cwd)) !== placeholderBranchName
  ) {
    return skipAutoName(options, "Branch published or concurrently changed", true);
  }
  const renameCurrentBranchImpl = options.renameCurrentBranch ?? renameCurrentBranch;
  const renamedBranch = await renameCurrentBranchImpl(options.cwd, targetName);
  markPaseoWorktreeFirstAgentBranchAutoNameSucceeded(
    options.cwd,
    renamedBranch.currentBranch ?? targetName,
  );
  return {
    attempted: true,
    renamed: true,
    branchName: renamedBranch.currentBranch ?? targetName,
  };
}

function skipAutoName(
  options: AutoNameOptions,
  reason: string,
  attempted: boolean,
): AttemptFirstAgentBranchAutoNameResult {
  options.logger?.info({ cwd: options.cwd, reason }, "Worktree branch naming skipped");
  return { attempted, renamed: false, branchName: null };
}

function readEligibleAutoNameMetadata(cwd: string) {
  try {
    const metadata = readPaseoWorktreeMetadata(cwd);
    if (metadata?.version !== 2 || metadata.firstAgentBranchAutoName?.status === "succeeded")
      return null;
    return metadata.firstAgentBranchAutoName ?? null;
  } catch {
    return null;
  }
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
