import type { GitHubService } from "../services/github-service.js";
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
  resolveRepositoryDefaultBranch: (repoRoot: string) => Promise<string>;
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
      return {
        kind: "checkout-github-pr",
        githubPrNumber: input.githubPrNumber,
        headRef: await resolveGitHubPrHeadRef({
          refName: input.refName,
          githubPrNumber: input.githubPrNumber,
          githubPrAttachment,
          repoRoot,
          deps,
        }),
        baseRefName: await resolveGitHubPrBaseRefName(githubPrAttachment, repoRoot, deps),
      };
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
    return {
      kind: "checkout-github-pr",
      githubPrNumber: input.githubPrNumber,
      headRef: await resolveGitHubPrHeadRef({
        refName: input.refName,
        githubPrNumber: input.githubPrNumber,
        githubPrAttachment,
        repoRoot,
        deps,
      }),
      baseRefName: await resolveGitHubPrBaseRefName(githubPrAttachment, repoRoot, deps),
    };
  }

  if (input.refName?.trim()) {
    return {
      kind: "branch-off",
      baseBranch: input.refName.trim(),
      newBranchName: deps.generateBranchName(input.worktreeSlug),
    };
  }

  if (githubPrAttachment) {
    return {
      kind: "checkout-github-pr",
      githubPrNumber: githubPrAttachment.number,
      headRef: await resolveGitHubPrAttachmentHeadRef(githubPrAttachment, repoRoot, deps),
      baseRefName: await resolveGitHubPrBaseRefName(githubPrAttachment, repoRoot, deps),
    };
  }

  return {
    kind: "branch-off",
    baseBranch: await resolveDefaultBranch(repoRoot, deps),
    newBranchName: deps.generateBranchName(input.worktreeSlug),
  };
}

async function resolveDefaultBranch(
  repoRoot: string,
  deps: ResolveWorktreeCreationIntentDeps,
): Promise<string> {
  const baseBranch = await deps.resolveRepositoryDefaultBranch(repoRoot);
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
  repoRoot: string;
  deps: ResolveWorktreeCreationIntentDeps;
}): Promise<string> {
  const trimmedRefName = params.refName?.trim();
  if (trimmedRefName) {
    return trimmedRefName;
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

async function resolveGitHubPrAttachmentHeadRef(
  attachment: Extract<AgentAttachment, { type: "github_pr" }>,
  repoRoot: string,
  deps: ResolveWorktreeCreationIntentDeps,
): Promise<string> {
  const trimmed = attachment.headRefName?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }
  return deps.github.getPullRequestHeadRef({ cwd: repoRoot, number: attachment.number });
}

async function resolveGitHubPrBaseRefName(
  attachment: Extract<AgentAttachment, { type: "github_pr" }> | null,
  repoRoot: string,
  deps: ResolveWorktreeCreationIntentDeps,
): Promise<string> {
  return attachment?.baseRefName?.trim() || (await resolveDefaultBranch(repoRoot, deps));
}
