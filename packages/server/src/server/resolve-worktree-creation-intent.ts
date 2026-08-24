import type { ForgeService, PullRequestCheckoutTarget } from "../services/forge-service.js";
import type { WorktreeSource } from "../utils/worktree.js";

export type WorktreeCreationIntent = WorktreeSource;

export interface ResolveWorktreeCreationIntentInput {
  worktreeSlug?: string;
  branchName?: string;
  refName?: string;
  action?: "branch-off" | "checkout";
  checkoutSource?: {
    kind: "change_request";
    forge?: string;
    number: number;
    projectPath?: string;
  };
  /**
   * COMPAT(githubPrNumber): added in v0.1.106, remove after 2026-12-28.
   */
  githubPrNumber?: number;
}

export interface ResolveWorktreeCreationIntentDeps {
  forge: string;
  forgeService: ForgeService;
  resolveDefaultBranch: (repoRoot: string) => Promise<string>;
}

export class MissingCheckoutTargetError extends Error {
  readonly action = "checkout";

  constructor() {
    super('action "checkout" requires refName or checkoutSource');
    this.name = "MissingCheckoutTargetError";
  }
}

export class UnsupportedForgeCheckoutTargetError extends Error {
  readonly forge: string;

  constructor(forge: string) {
    super(`Checkout from change request is not supported for ${forge} yet`);
    this.name = "UnsupportedForgeCheckoutTargetError";
    this.forge = forge;
  }
}

export class CheckoutSourceForgeMismatchError extends Error {
  readonly checkoutSourceForge: string;
  readonly workspaceForge: string;

  constructor(params: { checkoutSourceForge: string; workspaceForge: string }) {
    super(
      `Checkout source is for ${params.checkoutSourceForge}, but this workspace resolved to ${params.workspaceForge}`,
    );
    this.name = "CheckoutSourceForgeMismatchError";
    this.checkoutSourceForge = params.checkoutSourceForge;
    this.workspaceForge = params.workspaceForge;
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
      branchName: input.branchName ?? input.worktreeSlug ?? "worktree",
    };
  }

  if (input.action === "checkout") {
    const changeRequest = resolveInputChangeRequest(input);
    if (changeRequest) {
      assertCheckoutSourceMatchesResolvedForge(changeRequest, deps);
      return resolvePrCheckoutIntent({
        refName: input.refName,
        changeRequestNumber: changeRequest.number,
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

  const changeRequest = resolveInputChangeRequest(input);
  if (changeRequest) {
    assertCheckoutSourceMatchesResolvedForge(changeRequest, deps);
    return resolvePrCheckoutIntent({
      refName: input.refName,
      changeRequestNumber: changeRequest.number,
      repoRoot,
      deps,
    });
  }

  if (input.refName?.trim()) {
    return {
      kind: "branch-off",
      baseBranch: input.refName.trim(),
      branchName: input.branchName ?? input.worktreeSlug ?? "worktree",
    };
  }

  return {
    kind: "branch-off",
    baseBranch: await resolveDefaultBranch(repoRoot, deps),
    branchName: input.branchName ?? input.worktreeSlug ?? "worktree",
  };
}

interface PrCheckoutIntentParams {
  refName?: string;
  changeRequestNumber: number;
  repoRoot: string;
  deps: ResolveWorktreeCreationIntentDeps;
}

function resolveInputChangeRequest(
  input: ResolveWorktreeCreationIntentInput,
): { number: number; forge?: string; projectPath?: string } | null {
  if (input.checkoutSource) {
    return {
      number: input.checkoutSource.number,
      ...(input.checkoutSource.forge ? { forge: input.checkoutSource.forge } : {}),
      ...(input.checkoutSource.projectPath
        ? { projectPath: input.checkoutSource.projectPath }
        : {}),
    };
  }
  if (input.githubPrNumber !== undefined) {
    return { number: input.githubPrNumber };
  }
  return null;
}

function assertCheckoutSourceMatchesResolvedForge(
  source: { forge?: string },
  deps: ResolveWorktreeCreationIntentDeps,
): void {
  if (source.forge && source.forge !== deps.forge) {
    throw new CheckoutSourceForgeMismatchError({
      checkoutSourceForge: source.forge,
      workspaceForge: deps.forge,
    });
  }
}

async function resolvePrCheckoutIntent(
  params: PrCheckoutIntentParams,
): Promise<Extract<WorktreeCreationIntent, { kind: "checkout-change-request" }>> {
  const { deps } = params;
  const service = deps.forgeService;
  const checkoutTarget = await resolvePrCheckoutTarget(params);
  const headRef = await resolvePrHeadRef({
    refName: params.refName,
    changeRequestNumber: params.changeRequestNumber,
    checkoutTarget,
    repoRoot: params.repoRoot,
    deps,
  });

  const canCrossRepo =
    hasCheckoutRefs(checkoutTarget) || service.supportsCrossRepoCheckoutWithoutRefs === true;
  if (checkoutTarget.isCrossRepository && !canCrossRepo) {
    throw new UnsupportedForgeCheckoutTargetError(deps.forge);
  }

  const baseRefName =
    checkoutTarget.baseRefName.trim() || (await resolveDefaultBranch(params.repoRoot, deps));
  const defaultRefs = service.defaultCheckoutRefs?.({
    changeRequestNumber: params.changeRequestNumber,
    headRef,
  }) ?? [{ remoteName: "origin", remoteRef: `refs/heads/${headRef}` }];
  const localBranchName = service.buildPrLocalBranchName?.({ headRef, checkoutTarget });
  const headRepositoryOwner = checkoutTarget.isCrossRepository
    ? checkoutTarget.headOwnerLogin?.trim() || undefined
    : undefined;
  const pushRemoteUrl = checkoutTarget.isCrossRepository
    ? checkoutTarget.headRepositorySshUrl || checkoutTarget.headRepositoryUrl || undefined
    : undefined;
  const trackOriginHead = !checkoutTarget.isCrossRepository;

  return {
    kind: "checkout-change-request",
    forge: deps.forge,
    changeRequestNumber: params.changeRequestNumber,
    headRef,
    ...(headRepositoryOwner ? { headRepositoryOwner } : {}),
    baseRefName,
    checkoutRefs: checkoutTarget.checkoutRefs ?? defaultRefs,
    ...(localBranchName && localBranchName !== headRef ? { localBranchName } : {}),
    ...(pushRemoteUrl ? { pushRemoteUrl } : {}),
    ...(trackOriginHead ? { trackOriginHead } : {}),
  };
}

function hasCheckoutRefs(target: PullRequestCheckoutTarget): boolean {
  return Array.isArray(target.checkoutRefs) && target.checkoutRefs.length > 0;
}

async function resolvePrCheckoutTarget(params: {
  changeRequestNumber: number;
  repoRoot: string;
  deps: ResolveWorktreeCreationIntentDeps;
}): Promise<PullRequestCheckoutTarget> {
  return params.deps.forgeService.getPullRequestCheckoutTarget({
    cwd: params.repoRoot,
    number: params.changeRequestNumber,
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

async function resolvePrHeadRef(params: {
  refName?: string;
  changeRequestNumber: number;
  checkoutTarget: PullRequestCheckoutTarget;
  repoRoot: string;
  deps: ResolveWorktreeCreationIntentDeps;
}): Promise<string> {
  const trimmedRefName = params.refName?.trim();
  if (trimmedRefName) {
    return trimmedRefName;
  }
  const checkoutTargetHeadRef = params.checkoutTarget.headRefName.trim();
  if (checkoutTargetHeadRef) {
    return checkoutTargetHeadRef;
  }
  return params.deps.forgeService.getPullRequestHeadRef({
    cwd: params.repoRoot,
    number: params.changeRequestNumber,
  });
}
