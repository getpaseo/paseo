import type { PluginWorktreeCreateRequest } from "@getpaseo/plugin/server";
import type { PluginLifecycle } from "./plugins/lifecycle/index.js";
import { createNameId } from "mnemonic-id";

import type { ForgeService } from "../services/forge-service.js";
import {
  createWorktree,
  resolveDefaultWorktreePath,
  slugify,
  validateBranchSlug,
  type CreatedWorktree,
} from "../utils/worktree.js";
import {
  resolveWorktreeCreationIntent,
  type ResolveWorktreeCreationIntentInput,
  UnsupportedForgeCheckoutTargetError,
  type WorktreeCreationIntent,
} from "./resolve-worktree-creation-intent.js";
import type { ChangeRequestCheckoutSource, FirstAgentContext } from "@getpaseo/protocol/messages";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { runGitCommand, runWithGitCommandPriority } from "../utils/run-git-command.js";

export interface CreateWorktreeCoreInput {
  cwd: string;
  worktreeSlug?: string;
  branchName?: string;
  refName?: string;
  action?: "branch-off" | "checkout";
  checkoutSource?: ChangeRequestCheckoutSource;
  githubPrNumber?: number;
  firstAgentContext?: FirstAgentContext;
  paseoHome?: string;
  worktreesRoot?: string;
}

export interface CreateWorktreeCoreDeps {
  lifecycle?: Pick<PluginLifecycle, "before">;
  github: ForgeService;
  workspaceGitService?: Pick<
    WorkspaceGitService,
    "resolveRepoRoot" | "resolveDefaultBranch" | "resolveForge"
  >;
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
}

export interface CreateWorktreeCoreResult {
  worktree: CreatedWorktree;
  intent: WorktreeCreationIntent;
  repoRoot: string;
  created: boolean;
}

export async function createWorktreeCore(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
): Promise<CreateWorktreeCoreResult> {
  return runWithGitCommandPriority("high", () => createWorktreeCoreWithPriority(input, deps));
}

async function createWorktreeCoreWithPriority(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
): Promise<CreateWorktreeCoreResult> {
  const repoRoot = await resolveWorktreeRepoRoot(input, deps.workspaceGitService);
  const requestedWorktreeSlug = input.worktreeSlug
    ? normalizeWorktreeSlug(input.worktreeSlug)
    : undefined;
  const requestedBranchName = input.branchName?.trim();

  let intentInput: ResolveWorktreeCreationIntentInput;
  if (input.action === "checkout") {
    intentInput = {
      action: "checkout",
      refName: input.refName,
      checkoutSource: input.checkoutSource,
      githubPrNumber: input.githubPrNumber,
      worktreeSlug: requestedWorktreeSlug,
    };
  } else if (input.checkoutSource !== undefined || input.githubPrNumber !== undefined) {
    intentInput = {
      checkoutSource: input.checkoutSource,
      githubPrNumber: input.githubPrNumber,
      refName: input.refName,
      worktreeSlug: requestedWorktreeSlug,
    };
  } else {
    const worktreeSlug = requestedWorktreeSlug ?? normalizeWorktreeSlug(createNameId());
    intentInput = {
      action: "branch-off",
      refName: input.refName,
      branchName: requestedBranchName,
      worktreeSlug,
    };
  }

  const forge = await resolveForge(repoRoot, deps, intentInput);
  let intent = await resolveWorktreeCreationIntent(intentInput, repoRoot, {
    forge: forge.forge,
    forgeService: forge.service,
    resolveDefaultBranch: (root) => resolveDefaultBranch(root, deps),
  });
  let normalizedSlug: string;

  switch (intent.kind) {
    case "branch-off": {
      normalizedSlug = requestedWorktreeSlug ?? normalizeWorktreeSlug(intent.branchName);
      break;
    }
    case "checkout-branch": {
      normalizedSlug = requestedWorktreeSlug ?? normalizeWorktreeSlug(intent.branchName);
      break;
    }
    case "checkout-change-request":
    case "checkout-github-pr": {
      normalizedSlug =
        requestedWorktreeSlug ?? normalizeWorktreeSlug(intent.localBranchName ?? intent.headRef);
      break;
    }
  }

  const defaultPath = await resolveDefaultWorktreePath({
    cwd: repoRoot,
    paseoHome: input.paseoHome,
    worktreesRoot: input.worktreesRoot,
    worktreeSlug: normalizedSlug,
  });
  const { stdout: sourceRoot } = await runGitCommand(["rev-parse", "--show-toplevel"], {
    cwd: input.cwd,
  });
  const sourceCheckout = sourceRoot.trim();
  const request = describeCreationRequest(intent, {
    repoRoot,
    sourceCheckout,
    slug: normalizedSlug,
    path: defaultPath,
  });
  const transformed = deps.lifecycle
    ? await deps.lifecycle.before("worktree.create.before", request)
    : request;
  normalizedSlug = validateWorktreeSlug(transformed.slug);
  intent = creationIntentFromRequest(transformed, intent);

  return {
    worktree: await createWorktree({
      cwd: repoRoot,
      worktreeSlug: normalizedSlug,
      worktreePath: transformed.path,
      source: intent,
      paseoHome: input.paseoHome,
      worktreesRoot: input.worktreesRoot,
    }),
    intent,
    repoRoot,
    created: true,
  };
}

function describeCreationRequest(
  intent: WorktreeCreationIntent,
  placement: Pick<PluginWorktreeCreateRequest, "repoRoot" | "sourceCheckout" | "slug" | "path">,
): PluginWorktreeCreateRequest {
  if (intent.kind === "branch-off")
    return {
      ...placement,
      kind: intent.kind,
      branch: intent.branchName,
      baseRef: intent.baseBranch,
    };
  if (intent.kind === "checkout-branch")
    return { ...placement, kind: intent.kind, branch: intent.branchName };
  const { localBranchName, baseRefName, ...facts } = intent;
  return {
    ...placement,
    ...facts,
    branch: localBranchName ?? intent.headRef,
    baseRef: baseRefName,
  };
}

function creationIntentFromRequest(
  request: PluginWorktreeCreateRequest,
  original: WorktreeCreationIntent,
): WorktreeCreationIntent {
  if (request.kind === "branch-off") {
    return { kind: request.kind, branchName: request.branch, baseBranch: request.baseRef };
  }
  if (request.kind === "checkout-branch") {
    return {
      kind: request.kind,
      branchName: request.branch,
    };
  }
  const {
    repoRoot: _repoRoot,
    sourceCheckout: _checkout,
    slug: _slug,
    path: _path,
    branch,
    baseRef,
    ...facts
  } = request;
  const keepLocalBranchName =
    branch !== request.headRef ||
    ((original.kind === "checkout-change-request" || original.kind === "checkout-github-pr") &&
      original.localBranchName !== undefined);
  return {
    ...facts,
    ...(keepLocalBranchName ? { localBranchName: branch } : {}),
    baseRefName: baseRef,
  };
}

async function resolveForge(
  repoRoot: string,
  deps: CreateWorktreeCoreDeps,
  intentInput: ResolveWorktreeCreationIntentInput,
): Promise<{ forge: string; service: ForgeService }> {
  const resolution = await deps.workspaceGitService?.resolveForge(repoRoot);
  if (!resolution) {
    if (intentInput.checkoutSource?.forge && intentInput.checkoutSource.forge !== "github") {
      throw new UnsupportedForgeCheckoutTargetError(intentInput.checkoutSource.forge);
    }
    // No recognized remote: fall back to GitHub, the wire-default forge.
    return { forge: "github", service: deps.github };
  }
  return { forge: resolution.forge, service: resolution.service };
}

async function resolveDefaultBranch(
  repoRoot: string,
  deps: CreateWorktreeCoreDeps,
): Promise<string> {
  const baseBranch = deps.resolveDefaultBranch
    ? await deps.resolveDefaultBranch(repoRoot)
    : await deps.workspaceGitService?.resolveDefaultBranch(repoRoot);
  if (!baseBranch) {
    throw new Error("Unable to resolve repository default branch");
  }
  return baseBranch;
}

export async function resolveWorktreeRepoRoot(
  input: Pick<CreateWorktreeCoreInput, "cwd" | "paseoHome">,
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">,
): Promise<string> {
  if (!workspaceGitService) {
    throw new Error("Create worktree requires WorkspaceGitService");
  }

  return workspaceGitService.resolveRepoRoot(input.cwd);
}

function validateWorktreeSlug(slug: string): string {
  const validation = validateBranchSlug(slug);
  if (!validation.valid) {
    throw new Error(`Invalid worktree name: ${validation.error}`);
  }
  return slug;
}

function normalizeWorktreeSlug(value: string): string {
  return validateWorktreeSlug(slugify(value));
}
