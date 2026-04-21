import { v4 as uuidv4 } from "uuid";

import type { GitHubService } from "../services/github-service.js";
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
import type { WorkspaceGitService } from "./workspace-git-service.js";

export interface CreateWorktreeCoreInput extends ResolveWorktreeCreationIntentInput {
  cwd: string;
  paseoHome?: string;
  runSetup?: boolean;
}

export interface CreateWorktreeCoreDeps {
  github: GitHubService;
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot" | "resolveDefaultBranch">;
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
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
  const repoRoot = await resolveWorktreeRepoRoot(input, deps.workspaceGitService);
  const requestedSlug = input.worktreeSlug ? slugify(input.worktreeSlug) : undefined;

  const intent = await resolveWorktreeCreationIntent(
    { ...input, worktreeSlug: requestedSlug },
    repoRoot,
    {
      ...deps,
      resolveDefaultBranch: (root) => resolveDefaultBranch(root, deps),
    },
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
    generateBranchName: (seed) => slugify(seed ?? uuidv4()),
  };
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
