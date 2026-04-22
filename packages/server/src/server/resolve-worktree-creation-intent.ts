import type { GitHubPullRequestCheckoutTarget, GitHubService } from "../services/github-service.js";
import type { AgentAttachment } from "./messages.js";
import { findGitHubPrAttachment } from "./agent/prompt-attachments.js";
import type { WorktreeSource } from "../utils/worktree.js";

export type WorktreeCreationIntent = WorktreeSource;

export interface ResolveWorktreeCreationIntentInput {
  worktreeSlug?: string;
  refName?: string;
  action?: "branch-off" | "checkout";
  githubPrNumber?: number;
  attachments?: AgentAttachment[];
}

export interface ResolveWorktreeCreationIntentDeps {
  github: GitHubService;
  resolveDefaultBranch: (repoRoot: string) => Promise<string>;
  generateBranchName: (seed: string | undefined) => string;
}

export class MissingCheckoutTargetError extends Error {
  readonly action = "checkout";

  constructor() {
    super('action "checkout" requires refName or githubPrNumber');
    this.name = "MissingCheckoutTargetError";
  }
}

export class ConflictingGitHubPullRequestIntentError extends Error {
  readonly explicitGitHubPrNumber: number;
  readonly attachmentGitHubPrNumber: number;

  constructor(params: { explicitGitHubPrNumber: number; attachmentGitHubPrNumber: number }) {
    super(
      `Conflicting GitHub PR intent: explicit PR #${params.explicitGitHubPrNumber} does not match attachment PR #${params.attachmentGitHubPrNumber}`,
    );
    this.name = "ConflictingGitHubPullRequestIntentError";
    this.explicitGitHubPrNumber = params.explicitGitHubPrNumber;
    this.attachmentGitHubPrNumber = params.attachmentGitHubPrNumber;
  }
}

export async function resolveWorktreeCreationIntent(
  input: ResolveWorktreeCreationIntentInput,
  repoRoot: string,
  deps: ResolveWorktreeCreationIntentDeps,
): Promise<WorktreeCreationIntent> {
  const githubPrAttachment = findGitHubPrAttachment(input.attachments);
  assertGitHubPrIntentAgreesWithAttachment({
    githubPrNumber: input.githubPrNumber,
    githubPrAttachment,
  });

  if (input.action === "branch-off") {
    return {
      kind: "branch-off",
      baseBranch: input.refName?.trim() || (await resolveDefaultBranch(repoRoot, deps)),
      newBranchName: deps.generateBranchName(input.worktreeSlug),
    };
  }

  if (input.action === "checkout") {
    if (input.githubPrNumber !== undefined) {
      return resolveGitHubPrCheckoutIntent({
        refName: input.refName,
        githubPrNumber: input.githubPrNumber,
        githubPrAttachment,
        repoRoot,
        deps,
      });
    }

    const branchName = input.refName?.trim();
    if (branchName) {
      return {
        kind: "checkout-branch",
        branchName,
      };
    }

    throw new MissingCheckoutTargetError();
  }

  if (input.githubPrNumber !== undefined) {
    return resolveGitHubPrCheckoutIntent({
      refName: input.refName,
      githubPrNumber: input.githubPrNumber,
      githubPrAttachment,
      repoRoot,
      deps,
    });
  }

  if (input.refName?.trim()) {
    return {
      kind: "branch-off",
      baseBranch: input.refName.trim(),
      newBranchName: deps.generateBranchName(input.worktreeSlug),
    };
  }

  if (githubPrAttachment) {
    return resolveGitHubPrCheckoutIntent({
      githubPrNumber: githubPrAttachment.number,
      githubPrAttachment,
      repoRoot,
      deps,
    });
  }

  return {
    kind: "branch-off",
    baseBranch: await resolveDefaultBranch(repoRoot, deps),
    newBranchName: deps.generateBranchName(input.worktreeSlug),
  };
}

async function resolveGitHubPrCheckoutIntent(params: {
  refName?: string;
  githubPrNumber: number;
  githubPrAttachment: Extract<AgentAttachment, { type: "github_pr" }> | null;
  repoRoot: string;
  deps: ResolveWorktreeCreationIntentDeps;
}): Promise<Extract<WorktreeCreationIntent, { kind: "checkout-github-pr" }>> {
  const checkoutTarget = await resolveGitHubPrCheckoutTarget(params);
  const headRef = await resolveGitHubPrHeadRef({
    refName: params.refName,
    githubPrNumber: params.githubPrNumber,
    githubPrAttachment: params.githubPrAttachment,
    checkoutTarget,
    repoRoot: params.repoRoot,
    deps: params.deps,
  });
  const baseRefName =
    checkoutTarget?.baseRefName?.trim() ||
    (await resolveGitHubPrBaseRefName(params.githubPrAttachment, params.repoRoot, params.deps));
  const localBranchName = buildGitHubPrLocalBranchName({ headRef, checkoutTarget });
  const pushRemoteUrl = checkoutTarget
    ? checkoutTarget.headRepositorySshUrl || checkoutTarget.headRepositoryUrl || undefined
    : undefined;

  return {
    kind: "checkout-github-pr",
    githubPrNumber: params.githubPrNumber,
    headRef,
    baseRefName,
    ...(localBranchName !== headRef ? { localBranchName } : {}),
    ...(pushRemoteUrl ? { pushRemoteUrl } : {}),
  };
}

async function resolveGitHubPrCheckoutTarget(params: {
  githubPrNumber: number;
  repoRoot: string;
  deps: ResolveWorktreeCreationIntentDeps;
}): Promise<GitHubPullRequestCheckoutTarget | null> {
  if (!params.deps.github.getPullRequestCheckoutTarget) {
    return null;
  }
  return params.deps.github.getPullRequestCheckoutTarget({
    cwd: params.repoRoot,
    number: params.githubPrNumber,
  });
}

async function resolveDefaultBranch(
  repoRoot: string,
  deps: ResolveWorktreeCreationIntentDeps,
): Promise<string> {
  const baseBranch = await deps.resolveDefaultBranch(repoRoot);
  if (!baseBranch) {
    throw new Error("Unable to resolve repository default branch");
  }
  return baseBranch;
}

function assertGitHubPrIntentAgreesWithAttachment(params: {
  githubPrNumber?: number;
  githubPrAttachment: Extract<AgentAttachment, { type: "github_pr" }> | null;
}): void {
  if (
    params.githubPrNumber !== undefined &&
    params.githubPrAttachment &&
    params.githubPrNumber !== params.githubPrAttachment.number
  ) {
    throw new ConflictingGitHubPullRequestIntentError({
      explicitGitHubPrNumber: params.githubPrNumber,
      attachmentGitHubPrNumber: params.githubPrAttachment.number,
    });
  }
}

async function resolveGitHubPrHeadRef(params: {
  refName?: string;
  githubPrNumber: number;
  githubPrAttachment: Extract<AgentAttachment, { type: "github_pr" }> | null;
  checkoutTarget?: GitHubPullRequestCheckoutTarget | null;
  repoRoot: string;
  deps: ResolveWorktreeCreationIntentDeps;
}): Promise<string> {
  const trimmedRefName = params.refName?.trim();
  if (trimmedRefName) {
    return trimmedRefName;
  }
  const checkoutTargetHeadRef = params.checkoutTarget?.headRefName.trim();
  if (checkoutTargetHeadRef) {
    return checkoutTargetHeadRef;
  }
  if (params.githubPrAttachment) {
    const attachmentHeadRef = params.githubPrAttachment.headRefName?.trim();
    if (attachmentHeadRef) {
      return attachmentHeadRef;
    }
  }
  return params.deps.github.getPullRequestHeadRef({
    cwd: params.repoRoot,
    number: params.githubPrNumber,
  });
}

function buildGitHubPrLocalBranchName(params: {
  headRef: string;
  checkoutTarget: GitHubPullRequestCheckoutTarget | null;
}): string {
  const owner = params.checkoutTarget?.isCrossRepository
    ? normalizeGitHubOwnerForBranch(params.checkoutTarget.headOwnerLogin)
    : null;
  return owner ? `${owner}/${params.headRef}` : params.headRef;
}

function normalizeGitHubOwnerForBranch(owner: string | null): string | null {
  const normalized = owner?.trim().toLowerCase() ?? "";
  return /^[a-z0-9-]+$/.test(normalized) ? normalized : null;
}

async function resolveGitHubPrBaseRefName(
  attachment: Extract<AgentAttachment, { type: "github_pr" }> | null,
  repoRoot: string,
  deps: ResolveWorktreeCreationIntentDeps,
): Promise<string> {
  return attachment?.baseRefName?.trim() || (await resolveDefaultBranch(repoRoot, deps));
}
