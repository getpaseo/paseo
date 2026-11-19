import type { ForgeService, PullRequestCheckoutTarget } from "../services/forge-service.js";
import type { WorktreeCheckoutRef, WorktreeSource } from "../utils/worktree.js";

export type WorktreeCreationIntent = Exclude<
  WorktreeSource,
  { kind: "restore" | "restore-from-base" | "restore-commit" }
>;

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
  /** Fetches the first ref a remote serves into a local ref, and returns that remote's name. */
  fetchRef: (input: FetchRefInput) => Promise<string>;
}

export interface FetchRefInput {
  repoRoot: string;
  sources: WorktreeCheckoutRef[];
  destination: string;
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
    const branchName = input.branchName ?? input.worktreeSlug ?? "worktree";
    const changeRequest = resolveInputChangeRequest(input);
    if (changeRequest) {
      return {
        kind: "branch-off",
        ...(await fetchChangeRequestHead({ input, changeRequest, repoRoot, deps })),
        branchName,
      };
    }
    return {
      kind: "branch-off",
      baseBranch: input.refName?.trim() || (await resolveDefaultBranch(repoRoot, deps)),
      branchName,
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

/**
 * Fetches a change request's head, so a new branch can start from it without checking the change
 * request out. The head lands outside `refs/remotes`, which base branch pickers list. The remote
 * that serves the change request is the repository it merges into, which is `upstream` in a fork
 * clone. The base comes from that remote: a same-repository change request's own branch, so its
 * pull request stacks on the change request, or a fork's target branch, since the fork's branch is
 * not in this repository.
 */
async function fetchChangeRequestHead(params: {
  input: ResolveWorktreeCreationIntentInput;
  changeRequest: { number: number; forge?: string };
  repoRoot: string;
  deps: ResolveWorktreeCreationIntentDeps;
}): Promise<{ baseBranch: string; startPoint: string }> {
  const { input, changeRequest, repoRoot, deps } = params;
  assertCheckoutSourceMatchesResolvedForge(changeRequest, deps);
  const checkout = await resolvePrCheckoutIntent({
    refName: input.refName,
    changeRequestNumber: changeRequest.number,
    repoRoot,
    deps,
  });
  const startPoint = `refs/paseo/change-requests/${changeRequest.number}`;
  const remote = await deps.fetchRef({
    repoRoot,
    sources: checkout.checkoutRefs,
    destination: startPoint,
  });
  const baseName = checkout.trackOriginHead ? checkout.headRef : checkout.baseRefName;
  const baseBranch = `refs/remotes/${remote}/${baseName}`;
  try {
    // Compared as the remote has it, not as a local branch last pulled.
    await deps.fetchRef({
      repoRoot,
      sources: [{ remoteName: remote, remoteRef: `refs/heads/${baseName}` }],
      destination: baseBranch,
    });
    return { baseBranch, startPoint };
  } catch {
    // Without the remote's copy, the base resolves as any base branch name does.
    return { baseBranch: baseName, startPoint };
  }
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

async function resolvePrCheckoutIntent(params: PrCheckoutIntentParams): Promise<
  Extract<WorktreeCreationIntent, { kind: "checkout-change-request" }> & {
    checkoutRefs: WorktreeCheckoutRef[];
  }
> {
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
  const trackOriginHead =
    !checkoutTarget.isCrossRepository && checkoutTarget.headRefKind !== "pull-ref";

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
