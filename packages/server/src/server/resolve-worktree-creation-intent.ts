import type { GitHubPullRequestCheckoutTarget, GitHubService } from "../services/github-service.js";
import type { WorktreeSource } from "../utils/worktree.js";

export type WorktreeCreationIntent = WorktreeSource;

export type ResolveWorktreeCreationIntentInput =
  | {
      worktreeSlug: string;
      refName?: string;
      action?: "branch-off";
      githubPrNumber?: undefined;
    }
  | {
      worktreeSlug?: string;
      refName?: string;
      action: "checkout";
      githubPrNumber?: number;
    }
  | {
      worktreeSlug?: string;
      refName?: string;
      action?: undefined;
      githubPrNumber: number;
    };

export interface ResolveWorktreeCreationIntentDeps {
  github: GitHubService;
  resolveDefaultBranch: (repoRoot: string) => Promise<string>;
}

export class MissingCheckoutTargetError extends Error {
  readonly action = "checkout";

  constructor() {
    super('action "checkout" requires refName or githubPrNumber');
    this.name = "MissingCheckoutTargetError";
  }
}

export async function resolveWorktreeCreationIntent(
  input: ResolveWorktreeCreationIntentInput,
  repoRoot: string,
  deps: ResolveWorktreeCreationIntentDeps,
): Promise<WorktreeCreationIntent> {
  if (input.action === "branch-off") {
    return {
      kind: "branch-off",
      baseBranch: input.refName?.trim() || (await resolveDefaultBranch(repoRoot, deps)),
      branchName: input.worktreeSlug,
    };
  }

  if (input.action === "checkout") {
    if (input.githubPrNumber !== undefined) {
      return resolveGitHubPrCheckoutIntent({
        refName: input.refName,
        githubPrNumber: input.githubPrNumber,
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
      repoRoot,
      deps,
    });
  }

  if (input.refName?.trim()) {
    return {
      kind: "branch-off",
      baseBranch: input.refName.trim(),
      branchName: input.worktreeSlug,
    };
  }

  return {
    kind: "branch-off",
    baseBranch: await resolveDefaultBranch(repoRoot, deps),
    branchName: input.worktreeSlug,
  };
}

async function resolveGitHubPrCheckoutIntent(params: {
  refName?: string;
  githubPrNumber: number;
  repoRoot: string;
  deps: ResolveWorktreeCreationIntentDeps;
}): Promise<Extract<WorktreeCreationIntent, { kind: "checkout-github-pr" }>> {
  const checkoutTarget = await resolveGitHubPrCheckoutTarget(params);
  const headRef = await resolveGitHubPrHeadRef({
    refName: params.refName,
    githubPrNumber: params.githubPrNumber,
    checkoutTarget,
    repoRoot: params.repoRoot,
    deps: params.deps,
  });
  const baseRefName =
    checkoutTarget?.baseRefName?.trim() ||
    (await resolveDefaultBranch(params.repoRoot, params.deps));
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

async function resolveGitHubPrHeadRef(params: {
  refName?: string;
  githubPrNumber: number;
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
