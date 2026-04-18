import { describe, expect, test } from "vitest";

import type { GitHubService } from "../services/github-service.js";
import type { AgentAttachment } from "./messages.js";
import {
  ConflictingGitHubPullRequestIntentError,
  MissingCheckoutTargetError,
  resolveWorktreeCreationIntent,
} from "./resolve-worktree-creation-intent.js";

interface GitHubHeadRefLookup {
  cwd: string;
  number: number;
}

interface ResolverHarness {
  github: GitHubService;
  headRefLookups: GitHubHeadRefLookup[];
  resolveRepositoryDefaultBranch: (repoRoot: string) => Promise<string>;
  generateBranchName: (seed: string | undefined) => string;
}

function createResolverHarness(): ResolverHarness {
  const headRefLookups: GitHubHeadRefLookup[] = [];
  const github: GitHubService = {
    listPullRequests: async () => [],
    listIssues: async () => [],
    getPullRequest: async ({ number }) => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/acme/repo/pull/${number}`,
      state: "OPEN",
      body: null,
      baseRefName: "main",
      headRefName: `pr-${number}`,
      labels: [],
    }),
    getPullRequestHeadRef: async ({ cwd, number }) => {
      headRefLookups.push({ cwd, number });
      return `pr-${number}`;
    },
    getCurrentPullRequestStatus: async () => null,
    createPullRequest: async () => ({
      number: 1,
      url: "https://github.com/acme/repo/pull/1",
    }),
    isAuthenticated: async () => true,
    invalidate: () => {},
  };

  return {
    github,
    headRefLookups,
    resolveRepositoryDefaultBranch: async () => "main",
    generateBranchName: (seed) => seed ?? "generated-worktree",
  };
}

function createGitHubPrAttachment(params: {
  number: number;
  headRefName?: string;
  baseRefName?: string;
}): AgentAttachment {
  return {
    type: "github_pr",
    mimeType: "application/github-pr",
    number: params.number,
    title: `PR ${params.number}`,
    url: `https://github.com/acme/repo/pull/${params.number}`,
    ...(params.headRefName ? { headRefName: params.headRefName } : {}),
    ...(params.baseRefName ? { baseRefName: params.baseRefName } : {}),
  };
}

describe("resolveWorktreeCreationIntent", () => {
  const repoRoot = "/tmp/repo";

  test("branches off the repo default branch when no explicit fields are set", async () => {
    const deps = createResolverHarness();

    await expect(resolveWorktreeCreationIntent({}, repoRoot, deps)).resolves.toEqual({
      kind: "branch-off",
      baseBranch: "main",
      newBranchName: "generated-worktree",
    });
    expect(deps.headRefLookups).toEqual([]);
  });

  test("branches off the explicit refName when action is branch-off", async () => {
    const deps = createResolverHarness();

    await expect(
      resolveWorktreeCreationIntent(
        { action: "branch-off", refName: "dev", worktreeSlug: "feature" },
        repoRoot,
        deps,
      ),
    ).resolves.toEqual({
      kind: "branch-off",
      baseBranch: "dev",
      newBranchName: "feature",
    });
    expect(deps.headRefLookups).toEqual([]);
  });

  test("checks out an explicit branch target", async () => {
    const deps = createResolverHarness();

    await expect(
      resolveWorktreeCreationIntent({ action: "checkout", refName: "dev" }, repoRoot, deps),
    ).resolves.toEqual({
      kind: "checkout-branch",
      branchName: "dev",
    });
    expect(deps.headRefLookups).toEqual([]);
  });

  test("checks out a GitHub PR target and resolves its head ref", async () => {
    const deps = createResolverHarness();

    await expect(
      resolveWorktreeCreationIntent({ action: "checkout", githubPrNumber: 42 }, repoRoot, deps),
    ).resolves.toEqual({
      kind: "checkout-github-pr",
      githubPrNumber: 42,
      headRef: "pr-42",
      baseRefName: "main",
    });
    expect(deps.headRefLookups).toEqual([{ cwd: repoRoot, number: 42 }]);
  });

  test("uses an explicit PR head ref without calling GitHub", async () => {
    const deps = createResolverHarness();

    await expect(
      resolveWorktreeCreationIntent(
        { action: "checkout", githubPrNumber: 42, refName: "head-ref" },
        repoRoot,
        deps,
      ),
    ).resolves.toEqual({
      kind: "checkout-github-pr",
      githubPrNumber: 42,
      headRef: "head-ref",
      baseRefName: "main",
    });
    expect(deps.headRefLookups).toEqual([]);
  });

  test("rejects checkout without a target", async () => {
    const deps = createResolverHarness();

    await expect(
      resolveWorktreeCreationIntent({ action: "checkout" }, repoRoot, deps),
    ).rejects.toBeInstanceOf(MissingCheckoutTargetError);
  });

  test("preserves the legacy GitHub PR attachment checkout path", async () => {
    const deps = createResolverHarness();

    await expect(
      resolveWorktreeCreationIntent(
        { attachments: [createGitHubPrAttachment({ number: 5, headRefName: "pr-five" })] },
        repoRoot,
        deps,
      ),
    ).resolves.toEqual({
      kind: "checkout-github-pr",
      githubPrNumber: 5,
      headRef: "pr-five",
      baseRefName: "main",
    });
    expect(deps.headRefLookups).toEqual([]);
  });

  test("accepts matching explicit and attachment GitHub PR numbers", async () => {
    const deps = createResolverHarness();

    await expect(
      resolveWorktreeCreationIntent(
        {
          action: "checkout",
          githubPrNumber: 5,
          attachments: [createGitHubPrAttachment({ number: 5, headRefName: "pr-five" })],
        },
        repoRoot,
        deps,
      ),
    ).resolves.toEqual({
      kind: "checkout-github-pr",
      githubPrNumber: 5,
      headRef: "pr-five",
      baseRefName: "main",
    });
    expect(deps.headRefLookups).toEqual([]);
  });

  test("rejects conflicting explicit and attachment GitHub PR numbers", async () => {
    const deps = createResolverHarness();

    await expect(
      resolveWorktreeCreationIntent(
        {
          action: "checkout",
          githubPrNumber: 5,
          attachments: [createGitHubPrAttachment({ number: 7, headRefName: "pr-seven" })],
        },
        repoRoot,
        deps,
      ),
    ).rejects.toBeInstanceOf(ConflictingGitHubPullRequestIntentError);
  });

  test("ignores a GitHub PR attachment for explicit branch-off", async () => {
    const deps = createResolverHarness();

    await expect(
      resolveWorktreeCreationIntent(
        {
          action: "branch-off",
          attachments: [createGitHubPrAttachment({ number: 5, headRefName: "pr-five" })],
        },
        repoRoot,
        deps,
      ),
    ).resolves.toEqual({
      kind: "branch-off",
      baseBranch: "main",
      newBranchName: "generated-worktree",
    });
    expect(deps.headRefLookups).toEqual([]);
  });
});
