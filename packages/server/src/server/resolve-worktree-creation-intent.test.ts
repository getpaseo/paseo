import { describe, expect, test } from "vitest";

import type { ForgeService } from "../services/forge-service.js";
import {
  CheckoutSourceForgeMismatchError,
  MissingCheckoutTargetError,
  resolveWorktreeCreationIntent,
  UnsupportedForgeCheckoutTargetError,
} from "./resolve-worktree-creation-intent.js";

interface GitHubHeadRefLookup {
  cwd: string;
  number: number;
}

interface ResolverHarness {
  forge: string;
  forgeService: ForgeService;
  headRefLookups: GitHubHeadRefLookup[];
  resolveDefaultBranch: (repoRoot: string) => Promise<string>;
}

function createResolverHarness(overrides?: {
  forge?: string;
  forgeService?: Partial<ForgeService>;
}): ResolverHarness {
  const forge = overrides?.forge ?? "github";
  const headRefLookups: GitHubHeadRefLookup[] = [];
  const githubCapabilities: Partial<ForgeService> =
    forge === "github"
      ? {
          defaultCheckoutRefs: ({ changeRequestNumber }) => [
            { remoteName: "origin", remoteRef: `refs/pull/${changeRequestNumber}/head` },
          ],
          buildPrLocalBranchName: ({ headRef, checkoutTarget }) => {
            const normalized = checkoutTarget.headOwnerLogin?.trim().toLowerCase() ?? "";
            const owner =
              checkoutTarget.isCrossRepository && /^[a-z0-9-]+$/.test(normalized)
                ? normalized
                : null;
            return owner ? `${owner}/${headRef}` : headRef;
          },
          supportsCrossRepoCheckoutWithoutRefs: true,
        }
      : {};
  const forgeService: ForgeService = {
    listPullRequests: async () => [],
    listIssues: async () => [],
    searchIssuesAndPrs: async () => ({
      items: [],
      featuresEnabled: true,
      githubFeaturesEnabled: true,
    }),
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
    getPullRequestCheckoutTarget: async ({ number }) => ({
      number,
      baseRefName: "main",
      headRefName: `pr-${number}`,
      headOwnerLogin: null,
      headRepositorySshUrl: null,
      headRepositoryUrl: null,
      isCrossRepository: false,
    }),
    getCurrentPullRequestStatus: async () => null,
    createPullRequest: async () => ({
      number: 1,
      url: "https://github.com/acme/repo/pull/1",
    }),
    mergePullRequest: async () => ({ success: true }),
    isAuthenticated: async () => true,
    invalidate: () => {},
    ...githubCapabilities,
    ...overrides?.forgeService,
  };

  return {
    forge,
    forgeService,
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
      kind: "checkout-change-request",
      forge: "github",
      changeRequestNumber: 42,
      headRef: "pr-42",
      baseRefName: "main",
      checkoutRefs: [{ remoteName: "origin", remoteRef: "refs/pull/42/head" }],
      trackOriginHead: true,
    });
    expect(deps.headRefLookups).toEqual([]);
  });

  test("does not configure a synthetic push remote for same-repo PR targets", async () => {
    const deps = createResolverHarness();
    deps.forgeService.getPullRequestCheckoutTarget = async () => ({
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
      kind: "checkout-change-request",
      forge: "github",
      changeRequestNumber: 1790,
      headRef: "daemon-shutdown-diagnostics",
      baseRefName: "main",
      checkoutRefs: [{ remoteName: "origin", remoteRef: "refs/pull/1790/head" }],
      trackOriginHead: true,
    });
    expect(deps.headRefLookups).toEqual([]);
  });

  test("configures the contributor remote for fork PR targets", async () => {
    const deps = createResolverHarness();
    deps.forgeService.getPullRequestCheckoutTarget = async () => ({
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
      kind: "checkout-change-request",
      forge: "github",
      changeRequestNumber: 526,
      headRef: "main",
      baseRefName: "main",
      checkoutRefs: [{ remoteName: "origin", remoteRef: "refs/pull/526/head" }],
      headRepositoryOwner: "therainisme",
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
      kind: "checkout-change-request",
      forge: "github",
      changeRequestNumber: 42,
      headRef: "head-ref",
      baseRefName: "main",
      checkoutRefs: [{ remoteName: "origin", remoteRef: "refs/pull/42/head" }],
      trackOriginHead: true,
    });
    expect(deps.headRefLookups).toEqual([]);
  });

  test("checks out a GitLab MR source branch from the checkout target", async () => {
    const deps = createResolverHarness({
      forge: "gitlab",
      forgeService: {
        getPullRequestCheckoutTarget: async ({ number }) => ({
          number,
          baseRefName: "main",
          headRefName: "feature/mr-source",
          headOwnerLogin: null,
          headRepositorySshUrl: null,
          headRepositoryUrl: null,
          isCrossRepository: false,
        }),
      },
    });

    await expect(
      resolveWorktreeCreationIntent({ action: "checkout", githubPrNumber: 7 }, repoRoot, deps),
    ).resolves.toEqual({
      kind: "checkout-change-request",
      forge: "gitlab",
      changeRequestNumber: 7,
      headRef: "feature/mr-source",
      baseRefName: "main",
      checkoutRefs: [{ remoteName: "origin", remoteRef: "refs/heads/feature/mr-source" }],
      trackOriginHead: true,
    });
    expect(deps.headRefLookups).toEqual([]);
  });

  test("checks out a cross-repository GitLab MR when the adapter provides a checkout ref", async () => {
    const deps = createResolverHarness({
      forge: "gitlab",
      forgeService: {
        getPullRequestCheckoutTarget: async ({ number }) => ({
          number,
          baseRefName: "main",
          headRefName: "feature/mr-source",
          headOwnerLogin: null,
          headRepositorySshUrl: null,
          headRepositoryUrl: null,
          checkoutRefs: [{ remoteName: "origin", remoteRef: "refs/merge-requests/7/head" }],
          isCrossRepository: true,
        }),
      },
    });

    await expect(
      resolveWorktreeCreationIntent({ action: "checkout", githubPrNumber: 7 }, repoRoot, deps),
    ).resolves.toEqual({
      kind: "checkout-change-request",
      forge: "gitlab",
      changeRequestNumber: 7,
      headRef: "feature/mr-source",
      baseRefName: "main",
      checkoutRefs: [{ remoteName: "origin", remoteRef: "refs/merge-requests/7/head" }],
    });
    expect(deps.headRefLookups).toEqual([]);
  });

  test("reports unsupported cross-repository checkout targets without a checkout ref", async () => {
    const deps = createResolverHarness({
      forge: "gitea",
      forgeService: {
        getPullRequestCheckoutTarget: async ({ number }) => ({
          number,
          baseRefName: "main",
          headRefName: "feature/fork",
          headOwnerLogin: null,
          headRepositorySshUrl: null,
          headRepositoryUrl: null,
          isCrossRepository: true,
        }),
      },
    });

    await expect(
      resolveWorktreeCreationIntent({ action: "checkout", githubPrNumber: 7 }, repoRoot, deps),
    ).rejects.toThrow(UnsupportedForgeCheckoutTargetError);
  });

  test("rejects change request checkout when the source forge differs from the workspace forge", async () => {
    const deps = createResolverHarness({ forge: "github" });

    await expect(
      resolveWorktreeCreationIntent(
        {
          action: "checkout",
          checkoutSource: { kind: "change_request", forge: "gitlab", number: 7 },
        },
        repoRoot,
        deps,
      ),
    ).rejects.toThrow(CheckoutSourceForgeMismatchError);
  });

  test("rejects checkout without a target", async () => {
    const deps = createResolverHarness();

    await expect(
      resolveWorktreeCreationIntent({ action: "checkout" }, repoRoot, deps),
    ).rejects.toBeInstanceOf(MissingCheckoutTargetError);
  });
});
