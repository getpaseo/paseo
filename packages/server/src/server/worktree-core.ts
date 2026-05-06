import { createNameId } from "mnemonic-id";

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
import type { FirstAgentContext } from "../shared/messages.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";

export interface CreateWorktreeCoreInput {
  cwd: string;
  worktreeSlug?: string;
  refName?: string;
  action?: "branch-off" | "checkout";
  githubPrNumber?: number;
  firstAgentContext?: FirstAgentContext;
  paseoHome?: string;
  runSetup?: boolean;
}

export interface CreateWorktreeCoreDeps {
  github: GitHubService;
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot" | "resolveDefaultBranch">;
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
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
  const requestedWorktreeSlug = input.worktreeSlug
    ? normalizeWorktreeSlug(input.worktreeSlug)
    : undefined;

  let intentInput: ResolveWorktreeCreationIntentInput;
  if (input.action === "checkout") {
    intentInput = {
      action: "checkout",
      refName: input.refName,
      githubPrNumber: input.githubPrNumber,
      worktreeSlug: requestedWorktreeSlug,
    };
  } else if (input.githubPrNumber !== undefined) {
    intentInput = {
      githubPrNumber: input.githubPrNumber,
      refName: input.refName,
      worktreeSlug: requestedWorktreeSlug,
    };
  } else {
    const worktreeSlug = requestedWorktreeSlug ?? normalizeWorktreeSlug(createNameId());
    intentInput = {
      action: "branch-off",
      refName: input.refName,
      worktreeSlug,
    };
  }

  const intent = await resolveWorktreeCreationIntent(intentInput, repoRoot, {
    ...deps,
    resolveDefaultBranch: (root) => resolveDefaultBranch(root, deps),
  });
  let normalizedSlug: string;

  switch (intent.kind) {
    case "branch-off": {
      normalizedSlug = intent.branchName;
      break;
    }
    case "checkout-branch": {
      normalizedSlug = requestedWorktreeSlug ?? normalizeWorktreeSlug(intent.branchName);
      break;
    }
    case "checkout-github-pr": {
      normalizedSlug =
        requestedWorktreeSlug ?? normalizeWorktreeSlug(intent.localBranchName ?? intent.headRef);
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
