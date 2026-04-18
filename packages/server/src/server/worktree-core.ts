import { v4 as uuidv4 } from "uuid";

import type { GitHubService } from "../services/github-service.js";
import { getCheckoutStatus, resolveRepositoryDefaultBranch } from "../utils/checkout-git.js";
import {
  createWorktree,
  resolveExistingWorktreeForSlug,
  slugify,
  validateBranchSlug,
  type WorktreeConfig,
} from "../utils/worktree.js";
import {
  resolveWorktreeCreationIntent,
  type ResolveWorktreeCreationIntentInput,
  type WorktreeCreationIntent,
} from "./resolve-worktree-creation-intent.js";

export interface CreateWorktreeCoreInput extends ResolveWorktreeCreationIntentInput {
  cwd: string;
  paseoHome?: string;
  runSetup?: boolean;
}

export interface CreateWorktreeCoreDeps {
  github: GitHubService;
  resolveRepositoryDefaultBranch: (repoRoot: string) => Promise<string>;
  generateBranchName: (seed: string | undefined) => string;
}

export interface CreateWorktreeCoreResult {
  worktree: WorktreeConfig;
  intent: WorktreeCreationIntent;
  repoRoot: string;
  created: boolean;
}

export async function createWorktreeCore(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
): Promise<CreateWorktreeCoreResult> {
  const repoRoot = await resolveWorktreeRepoRoot(input);
  const requestedSlug = input.worktreeSlug ? slugify(input.worktreeSlug) : undefined;

  const intent = await resolveWorktreeCreationIntent(
    { ...input, worktreeSlug: requestedSlug },
    repoRoot,
    deps,
  );
  let normalizedSlug: string;

  switch (intent.kind) {
    case "branch-off": {
      normalizedSlug = validateWorktreeSlug(requestedSlug ?? slugify(intent.newBranchName));
      break;
    }
    case "checkout-branch": {
      normalizedSlug = validateWorktreeSlug(requestedSlug ?? slugify(intent.branchName));
      break;
    }
    case "checkout-github-pr": {
      normalizedSlug = validateWorktreeSlug(requestedSlug ?? slugify(intent.headRef));
      break;
    }
  }

  const existingWorktree = await resolveExistingWorktreeForSlug({
    slug: normalizedSlug,
    repoRoot,
    paseoHome: input.paseoHome,
  });
  if (existingWorktree) {
    return { worktree: existingWorktree, intent, repoRoot, created: false };
  }

  return {
    worktree: await createWorktree({
      cwd: repoRoot,
      worktreeSlug: normalizedSlug,
      source: intent,
      runSetup: input.runSetup ?? true,
      paseoHome: input.paseoHome,
    }),
    intent,
    repoRoot,
    created: true,
  };
}

export function createWorktreeCoreDeps(github: GitHubService): CreateWorktreeCoreDeps {
  return {
    github,
    resolveRepositoryDefaultBranch: resolveDefaultBranch,
    generateBranchName: (seed) => slugify(seed ?? uuidv4()),
  };
}

async function resolveDefaultBranch(repoRoot: string): Promise<string> {
  const baseBranch = await resolveRepositoryDefaultBranch(repoRoot);
  if (!baseBranch) {
    throw new Error("Unable to resolve repository default branch");
  }
  return baseBranch;
}

async function resolveWorktreeRepoRoot(input: CreateWorktreeCoreInput): Promise<string> {
  const checkout = await getCheckoutStatus(
    input.cwd,
    input.paseoHome ? { paseoHome: input.paseoHome } : undefined,
  );
  if (!checkout.isGit) {
    throw new Error("Create worktree requires a git repository");
  }

  return checkout.isPaseoOwnedWorktree
    ? (checkout.mainRepoRoot ?? checkout.repoRoot ?? input.cwd)
    : (checkout.repoRoot ?? input.cwd);
}

function validateWorktreeSlug(slug: string): string {
  const validation = validateBranchSlug(slug);
  if (!validation.valid) {
    throw new Error(`Invalid worktree name: ${validation.error}`);
  }
  return slug;
}
