import { describe, expect, test } from "vitest";

import type { GitHubService } from "../services/github-service.js";
import {
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
  resolveDefaultBranch: (repoRoot: string) => Promise<string>;
}

function createResolverHarness(): ResolverHarness {
  const headRefLookups: GitHubHeadRefLookup[] = [];
  const github: GitHubService = {
    listPullRequests: async () => [],
    listIssues: async () => [],
    searchIssuesAndPrs: async () => ({ items: [], githubFeaturesEnabled: true }),
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
    mergePullRequest: async () => ({ success: true }),
    isAuthenticated: async () => true,
    invalidate: () => {},
  };

  return {
    github,
    headRefLookups,
    resolveDefaultBranch: async () => "main",
  };
}

describe("resolveWorktreeCreationIntent", () => {
  const repoRoot = "/tmp/repo";

  test("branches off the repo default branch when no explicit fields are set", async () => {
    const deps = createResolverHarness();

    await expect(
      resolveWorktreeCreationIntent({ worktreeSlug: "generated-worktree" }, repoRoot, deps),
    ).resolves.toEqual({
      kind: "branch-off",
      baseBranch: "main",
      branchName: "generated-worktree",
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
      branchName: "feature",
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

  test("does not configure a synthetic push remote for same-repo PR targets", async () => {
    const deps = createResolverHarness();
    deps.github.getPullRequestCheckoutTarget = async () => ({
      number: 1790,
      baseRefName: "main",
      headRefName: "daemon-shutdown-diagnostics",
      headOwnerLogin: "getpaseo",
      headRepositorySshUrl: "git@github.com:getpaseo/paseo.git",
      headRepositoryUrl: "https://github.com/getpaseo/paseo",
      isCrossRepository: false,
    });

    await expect(
      resolveWorktreeCreationIntent({ action: "checkout", githubPrNumber: 1790 }, repoRoot, deps),
    ).resolves.toEqual({
      kind: "checkout-github-pr",
      githubPrNumber: 1790,
      headRef: "daemon-shutdown-diagnostics",
      baseRefName: "main",
      trackOriginHead: true,
    });
    expect(deps.headRefLookups).toEqual([]);
  });

  test("configures the contributor remote for fork PR targets", async () => {
    const deps = createResolverHarness();
    deps.github.getPullRequestCheckoutTarget = async () => ({
      number: 526,
      baseRefName: "main",
      headRefName: "main",
      headOwnerLogin: "therainisme",
      headRepositorySshUrl: "git@github.com:therainisme/paseo.git",
      headRepositoryUrl: "https://github.com/therainisme/paseo",
      isCrossRepository: true,
    });

    await expect(
      resolveWorktreeCreationIntent({ action: "checkout", githubPrNumber: 526 }, repoRoot, deps),
    ).resolves.toEqual({
      kind: "checkout-github-pr",
      githubPrNumber: 526,
      headRef: "main",
      baseRefName: "main",
      localBranchName: "therainisme/main",
      pushRemoteUrl: "git@github.com:therainisme/paseo.git",
    });
    expect(deps.headRefLookups).toEqual([]);
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
});
