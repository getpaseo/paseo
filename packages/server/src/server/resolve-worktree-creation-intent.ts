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
   * COMPAT(githubPrNumber): legacy GitHub checkout input retained when
   * checkoutSource shipped in v0.2.0-beta.1. Remove after 2027-01-17 once the
   * supported client floor is >= v0.2.0.
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
    return resolveBranchOffIntent(input, repoRoot, deps);
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

    const refName = input.refName?.trim();
    if (refName) {
      return resolveCheckoutBranchIntent(refName);
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

function resolveCheckoutBranchIntent(refName: string): WorktreeCreationIntent {
  const localPrefix = "refs/heads/";
  if (refName.startsWith(localPrefix)) {
    return {
      kind: "checkout-branch",
      branchName: refName.slice(localPrefix.length),
      target: { kind: "local", refName },
    };
  }

  const remotePrefix = "refs/remotes/";
  if (refName.startsWith(remotePrefix)) {
    const remoteAndHead = refName.slice(remotePrefix.length);
    const separator = remoteAndHead.indexOf("/");
    if (separator > 0 && separator < remoteAndHead.length - 1) {
      const remoteName = remoteAndHead.slice(0, separator);
      const headRef = remoteAndHead.slice(separator + 1);
      return {
        kind: "checkout-branch",
        branchName: headRef,
        target: { kind: "remote", refName, remoteName, headRef },
      };
    }
  }

  return { kind: "checkout-branch", branchName: refName };
}

interface PrCheckoutIntentParams {
  refName?: string;
  changeRequestNumber: number;
  repoRoot: string;
  deps: ResolveWorktreeCreationIntentDeps;
}

async function resolveBranchOffIntent(
  input: ResolveWorktreeCreationIntentInput,
  repoRoot: string,
  deps: ResolveWorktreeCreationIntentDeps,
): Promise<WorktreeCreationIntent> {
  const changeRequest = resolveInputChangeRequest(input);
  if (!changeRequest) {
    return {
      kind: "branch-off",
      baseBranch: input.refName?.trim() || (await resolveDefaultBranch(repoRoot, deps)),
      branchName: input.branchName ?? input.worktreeSlug ?? "worktree",
    };
  }

  assertCheckoutSourceMatchesResolvedForge(changeRequest, deps);
  const checkoutIntent = await resolvePrCheckoutIntent({
    refName: input.refName,
    changeRequestNumber: changeRequest.number,
    repoRoot,
    deps,
  });
  return {
    kind: "branch-off-change-request",
    forge: checkoutIntent.forge,
    changeRequestNumber: checkoutIntent.changeRequestNumber,
    headRef: checkoutIntent.headRef,
    baseRefName: checkoutIntent.baseRefName,
    checkoutRefs: checkoutIntent.checkoutRefs ?? [],
    branchName: input.branchName ?? input.worktreeSlug ?? "worktree",
  };
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
  const crossRepository = resolveCrossRepositoryFields(checkoutTarget);
  const trackOriginHead = !checkoutTarget.isCrossRepository;

  return {
    kind: "checkout-change-request",
    forge: deps.forge,
    changeRequestNumber: params.changeRequestNumber,
    headRef,
    ...crossRepository,
    baseRefName,
    checkoutRefs: checkoutTarget.checkoutRefs ?? defaultRefs,
    ...(localBranchName && localBranchName !== headRef ? { localBranchName } : {}),
    ...(trackOriginHead ? { trackOriginHead } : {}),
  };
}

function resolveCrossRepositoryFields(target: PullRequestCheckoutTarget): {
  headRepositoryOwner?: string;
  headRepository?: string;
  pushRemoteUrl?: string;
} {
  if (!target.isCrossRepository) return {};
  const headRepositoryOwner = target.headOwnerLogin?.trim() || undefined;
  const headRepository = resolveHeadRepository(target);
  const pushRemoteUrl = target.headRepositorySshUrl || target.headRepositoryUrl || undefined;
  return {
    ...(headRepositoryOwner ? { headRepositoryOwner } : {}),
    ...(headRepository ? { headRepository } : {}),
    ...(pushRemoteUrl ? { pushRemoteUrl } : {}),
  };
}

function resolveHeadRepository(target: PullRequestCheckoutTarget): string | undefined {
  const url = target.headRepositoryUrl ?? target.headRepositorySshUrl;
  if (!url) return target.headOwnerLogin?.trim() || "unknown repository";
  const path = url
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .filter(Boolean);
  const repository = path.at(-1);
  const owner = target.headOwnerLogin?.trim() || path.at(-2);
  return (owner && repository ? `${owner}/${repository}` : repository) ?? "unknown repository";
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
