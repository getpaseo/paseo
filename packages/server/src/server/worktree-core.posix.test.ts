// POSIX-only: git worktree reuse fixtures
/* eslint-disable max-nested-callbacks */
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, afterEach } from "vitest";
import type { ForgeService } from "../services/forge-service.js";
import { createGitHubService } from "../services/github-service.js";
import { createGitLabService } from "../services/gitlab-service.js";
import {
  getCheckoutSnapshotFacts,
  getCheckoutStatus,
  getMainRepoRoot,
  pushCurrentBranch,
  resolveRepositoryDefaultBranch,
} from "../utils/checkout-git.js";
import {
  getPaseoWorktreeMetadataPath,
  readPaseoWorktreeMetadata,
} from "../utils/worktree-metadata.js";
import { validateBeforeRequest, validateBeforeResult } from "./plugins/lifecycle/index.js";
import {
  createWorktree,
  isPaseoOwnedWorktreeCwd,
  listGitWorktrees,
  listPaseoWorktrees,
  UnknownBranchError,
} from "../utils/worktree.js";
import { createWorktreeCore as createCoreWorktree } from "./worktree-core.js";
import { isPlatform } from "../test-utils/platform.js";
import { createWithWorktrunk } from "../../../../plugin-examples/worktrunk/server/wt.js";

function createGitHubServiceStub(): ForgeService {
  return {
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
    getPullRequestHeadRef: async ({ number }) => `pr-${number}`,
    getPullRequestCheckoutTarget: async ({ number }) => ({
      number,
      baseRefName: "main",
      headRefName: `pr-${number}`,
      headOwnerLogin: null,
      headRepositorySshUrl: null,
      headRepositoryUrl: null,
      isCrossRepository: false,
    }),
    defaultCheckoutRefs: ({ changeRequestNumber }) => [
      { remoteName: "origin", remoteRef: `refs/pull/${changeRequestNumber}/head` },
    ],
    buildPrLocalBranchName: ({ headRef, checkoutTarget }) => {
      const normalized = checkoutTarget.headOwnerLogin?.trim().toLowerCase() ?? "";
      const owner =
        checkoutTarget.isCrossRepository && /^[a-z0-9-]+$/.test(normalized) ? normalized : null;
      return owner ? `${owner}/${headRef}` : headRef;
    },
    supportsCrossRepoCheckoutWithoutRefs: true,
    getCurrentPullRequestStatus: async () => null,
    createPullRequest: async () => ({
      number: 1,
      url: "https://github.com/acme/repo/pull/1",
    }),
    mergePullRequest: async () => ({ success: true }),
    isAuthenticated: async () => true,
    invalidate: () => {},
  };
}

function createCoreDeps(options?: {
  github?: ForgeService;
  forge?: { forge: string; service: ForgeService };
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
  resolveRepoRoot?: (cwd: string) => Promise<string>;
}) {
  return {
    github: options?.github ?? createGitHubServiceStub(),
    workspaceGitService: {
      resolveRepoRoot: options?.resolveRepoRoot ?? (async (cwd: string) => cwd),
      resolveForge: async () =>
        options?.forge
          ? {
              forge: options.forge.forge,
              host: `${options.forge.forge}.example.com`,
              service: options.forge.service,
            }
          : null,
    },
    resolveDefaultBranch: options?.resolveDefaultBranch ?? (async () => "main"),
  };
}

function createGitRepo(): { tempDir: string; repoDir: string; paseoHome: string } {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "worktree-core-test-")));
  const repoDir = path.join(tempDir, "repo");
  const paseoHome = path.join(tempDir, ".paseo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  return { tempDir, repoDir, paseoHome };
}

function createGitRepoWithDevBranch(): { tempDir: string; repoDir: string; paseoHome: string } {
  const { tempDir, repoDir, paseoHome } = createGitRepo();
  execFileSync("git", ["checkout", "-b", "dev"], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "dev branch\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "dev branch"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "pipe" });
  return { tempDir, repoDir, paseoHome };
}

function createGitRepoWithOriginMain(): { tempDir: string; repoDir: string; paseoHome: string } {
  const { tempDir, repoDir, paseoHome } = createGitRepo();
  const remoteDir = path.join(tempDir, "origin.git");
  execFileSync("git", ["clone", "--bare", repoDir, remoteDir], { stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["fetch", "origin"], { cwd: repoDir, stdio: "pipe" });
  return { tempDir, repoDir, paseoHome };
}

function createGitHubPrRemoteRepo(): { tempDir: string; repoDir: string; paseoHome: string } {
  const { tempDir, repoDir, paseoHome } = createGitRepo();
  const featureBranch = "feature/review-pr";
  execFileSync("git", ["checkout", "-b", featureBranch], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "review branch\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "review branch"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  const featureSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, stdio: "pipe" })
    .toString()
    .trim();
  execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["branch", "-D", featureBranch], { cwd: repoDir, stdio: "pipe" });

  const remoteDir = path.join(tempDir, "remote.git");
  execFileSync("git", ["clone", "--bare", repoDir, remoteDir], {
    stdio: "pipe",
  });
  execFileSync("git", [`--git-dir=${remoteDir}`, "update-ref", "refs/pull/123/head", featureSha], {
    stdio: "pipe",
  });
  execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["fetch", "origin"], { cwd: repoDir, stdio: "pipe" });

  return { tempDir, repoDir, paseoHome };
}

function createSameRepoGitHubPrRemoteRepo(): {
  tempDir: string;
  repoDir: string;
  remoteDir: string;
  paseoHome: string;
} {
  const { tempDir, repoDir, paseoHome } = createGitRepo();
  const remoteDir = path.join(tempDir, "origin.git");
  const featureBranch = "daemon-shutdown-diagnostics";

  execFileSync("git", ["clone", "--bare", repoDir, remoteDir], {
    stdio: "pipe",
  });
  execFileSync("git", ["remote", "add", "origin", remoteDir], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["checkout", "-b", featureBranch], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "same repo pr branch\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "same repo pr branch"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  const prHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, stdio: "pipe" })
    .toString()
    .trim();
  execFileSync("git", ["push", "origin", featureBranch], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", [`--git-dir=${remoteDir}`, "update-ref", "refs/pull/1790/head", prHead], {
    stdio: "pipe",
  });
  execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["branch", "-D", featureBranch], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["fetch", "origin"], { cwd: repoDir, stdio: "pipe" });

  return { tempDir, repoDir, remoteDir, paseoHome };
}

function createGitRepoWithOriginFeatureBranch(): {
  tempDir: string;
  repoDir: string;
  paseoHome: string;
} {
  const { tempDir, repoDir, paseoHome } = createGitRepo();
  const featureBranch = "feature/gitlab-mr";
  execFileSync("git", ["checkout", "-b", featureBranch], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "gitlab mr branch\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "gitlab mr branch"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "pipe" });

  const remoteDir = path.join(tempDir, "origin.git");
  execFileSync("git", ["clone", "--bare", repoDir, remoteDir], { stdio: "pipe" });
  execFileSync("git", ["branch", "-D", featureBranch], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["fetch", "origin"], { cwd: repoDir, stdio: "pipe" });

  return { tempDir, repoDir, paseoHome };
}

function createGitLabMrRefOnlyRemoteRepo(): {
  tempDir: string;
  repoDir: string;
  paseoHome: string;
} {
  const { tempDir, repoDir, paseoHome } = createGitRepo();
  const featureBranch = "feature/gitlab-mr";
  execFileSync("git", ["checkout", "-b", featureBranch], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "gitlab mr branch\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "gitlab mr branch"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  const mrHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, stdio: "pipe" })
    .toString()
    .trim();
  execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "pipe" });

  const remoteDir = path.join(tempDir, "origin.git");
  execFileSync("git", ["clone", "--bare", repoDir, remoteDir], { stdio: "pipe" });
  execFileSync(
    "git",
    [`--git-dir=${remoteDir}`, "update-ref", "refs/merge-requests/14/head", mrHead],
    { stdio: "pipe" },
  );
  execFileSync(
    "git",
    [`--git-dir=${remoteDir}`, "update-ref", "-d", `refs/heads/${featureBranch}`],
    {
      stdio: "pipe",
    },
  );
  execFileSync("git", ["branch", "-D", featureBranch], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["fetch", "origin"], { cwd: repoDir, stdio: "pipe" });

  return { tempDir, repoDir, paseoHome };
}

function createGitLabMrWithConflictingOriginBranchRepo(): {
  tempDir: string;
  repoDir: string;
  paseoHome: string;
} {
  const { tempDir, repoDir, paseoHome } = createGitRepo();
  const featureBranch = "feature/gitlab-mr";
  execFileSync("git", ["checkout", "-b", featureBranch], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "target repo branch with same name\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "commit", "-m", "target branch with same name"],
    {
      cwd: repoDir,
      stdio: "pipe",
    },
  );
  execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["checkout", "-b", "mr-head"], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "authoritative merge request head\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "merge request head"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  const mrHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, stdio: "pipe" })
    .toString()
    .trim();
  execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "pipe" });

  const remoteDir = path.join(tempDir, "origin.git");
  execFileSync("git", ["clone", "--bare", repoDir, remoteDir], { stdio: "pipe" });
  execFileSync(
    "git",
    [`--git-dir=${remoteDir}`, "update-ref", "refs/merge-requests/14/head", mrHead],
    { stdio: "pipe" },
  );
  execFileSync("git", [`--git-dir=${remoteDir}`, "update-ref", "-d", "refs/heads/mr-head"], {
    stdio: "pipe",
  });
  execFileSync("git", ["branch", "-D", featureBranch], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["branch", "-D", "mr-head"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["fetch", "origin"], { cwd: repoDir, stdio: "pipe" });

  return { tempDir, repoDir, paseoHome };
}

function createForkGitHubPrRemoteRepo(): {
  tempDir: string;
  repoDir: string;
  headRemoteDir: string;
  paseoHome: string;
} {
  const { tempDir, repoDir, paseoHome } = createGitRepo();
  const baseRemoteDir = path.join(tempDir, "base.git");
  const headRemoteDir = path.join(tempDir, "therainisme.git");
  const headCloneDir = path.join(tempDir, "therainisme-clone");

  execFileSync("git", ["clone", "--bare", repoDir, baseRemoteDir], {
    stdio: "pipe",
  });
  execFileSync("git", ["clone", "--bare", repoDir, headRemoteDir], {
    stdio: "pipe",
  });
  execFileSync("git", ["remote", "add", "origin", baseRemoteDir], {
    cwd: repoDir,
    stdio: "pipe",
  });

  execFileSync("git", ["clone", headRemoteDir, headCloneDir], {
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.email", "test@test.com"], {
    cwd: headCloneDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: headCloneDir, stdio: "pipe" });
  writeFileSync(path.join(headCloneDir, "README.md"), "fork pr main branch\n");
  execFileSync("git", ["add", "README.md"], { cwd: headCloneDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "fork pr main branch"], {
    cwd: headCloneDir,
    stdio: "pipe",
  });
  const prHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: headCloneDir, stdio: "pipe" })
    .toString()
    .trim();
  execFileSync("git", ["push", "origin", "main"], { cwd: headCloneDir, stdio: "pipe" });
  execFileSync("git", [`--git-dir=${baseRemoteDir}`, "fetch", headRemoteDir, "main"], {
    stdio: "pipe",
  });
  execFileSync("git", [`--git-dir=${baseRemoteDir}`, "update-ref", "refs/pull/526/head", prHead], {
    stdio: "pipe",
  });
  execFileSync("git", ["fetch", "origin"], { cwd: repoDir, stdio: "pipe" });

  return { tempDir, repoDir, headRemoteDir, paseoHome };
}

function getBranchUpstream(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    cwd,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

function getGitConfigValue(cwd: string, key: string): string | null {
  const result = spawnSync("git", ["config", "--get", key], {
    cwd,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

describe.skipIf(isPlatform("win32"))("worktree-core POSIX-only", () => {
  describe("createWorktreeCore", () => {
    const cleanupPaths: string[] = [];

    afterEach(() => {
      for (const target of cleanupPaths.splice(0)) {
        rmSync(target, { recursive: true, force: true });
      }
    });

    test("creates the legacy RPC branch-off worktree from the repo default branch", async () => {
      const { tempDir, repoDir, paseoHome } = createGitRepo();
      cleanupPaths.push(tempDir);

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          worktreeSlug: "legacy-rpc",
          paseoHome,
        },
        createCoreDeps(),
      );

      expect(result.intent).toEqual({
        kind: "branch-off",
        baseBranch: "main",
        branchName: "legacy-rpc",
      });
      expect(result.created).toBe(true);
      expect(result.worktree.branchName).toBe("legacy-rpc");
      expect(existsSync(result.worktree.worktreePath)).toBe(true);
    });

    test("keeps default placement suffixes when the default destination already exists", async () => {
      const { tempDir, repoDir, paseoHome } = createGitRepo();
      cleanupPaths.push(tempDir);
      const first = await createCoreWorktree(
        { cwd: repoDir, paseoHome, branchName: "first", worktreeSlug: "same" },
        createCoreDeps(),
      );
      const second = await createCoreWorktree(
        { cwd: repoDir, paseoHome, branchName: "second", worktreeSlug: "same" },
        createCoreDeps(),
      );
      expect(second.worktree.worktreePath).toBe(first.worktree.worktreePath + "-1");
      expect(existsSync(first.worktree.worktreePath)).toBe(true);
    });

    test("creates a workspace from a checkout of a bare repository that only Paseo uses", async () => {
      const { tempDir, repoDir, paseoHome } = createGitRepo();
      cleanupPaths.push(tempDir);
      const bareRepo = path.join(tempDir, "repo.git");
      execFileSync("git", ["clone", "--bare", "-q", repoDir, bareRepo], { stdio: "pipe" });
      const first = await createWorktree({
        cwd: bareRepo,
        paseoHome,
        worktreeSlug: "first",
        source: { kind: "branch-off", branchName: "first", baseBranch: "main" },
      });
      expect(await getMainRepoRoot(first.worktreePath, { paseoHome })).toBe(bareRepo);

      const result = await createCoreWorktree(
        { cwd: first.worktreePath, worktreeSlug: "second", paseoHome },
        createCoreDeps({
          resolveRepoRoot: (cwd) => getMainRepoRoot(cwd, { paseoHome }),
          resolveDefaultBranch: async (root) =>
            (await resolveRepositoryDefaultBranch(root)) ?? "unresolved",
        }),
      );

      expect(result.repoRoot).toBe(bareRepo);
      expect(result.intent).toEqual({
        kind: "branch-off",
        baseBranch: "main",
        branchName: "second",
      });
      expect(readFileSync(path.join(result.worktree.worktreePath, "README.md"), "utf8")).toBe(
        "hello\n",
      );
    });

    test("creates branch-off worktrees from origin main without tracking origin main", async () => {
      const { tempDir, repoDir, paseoHome } = createGitRepoWithOriginMain();
      cleanupPaths.push(tempDir);

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          worktreeSlug: "no-upstream-feature",
          action: "branch-off",
          refName: "main",
          paseoHome,
        },
        createCoreDeps(),
      );

      expect(result.intent).toEqual({
        kind: "branch-off",
        baseBranch: "main",
        branchName: "no-upstream-feature",
      });
      expect(getBranchUpstream(result.worktree.worktreePath)).toBeNull();
    });

    test("creates a branch-off worktree with a mnemonic slug when no slug is supplied", async () => {
      const { tempDir, repoDir, paseoHome } = createGitRepo();
      cleanupPaths.push(tempDir);

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          paseoHome,
        },
        createCoreDeps(),
      );

      expect(result.intent.kind).toBe("branch-off");
      expect(result.created).toBe(true);
      expect(result.worktree.branchName).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
      expect(result.worktree.branchName).toBe(path.basename(result.worktree.worktreePath));
      expect(existsSync(result.worktree.worktreePath)).toBe(true);
    });

    test("checks out an explicit GitHub PR branch with legacy RPC fields", async () => {
      const { tempDir, repoDir, paseoHome } = createGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          worktreeSlug: "review-pr-123",
          githubPrNumber: 123,
          refName: "feature/review-pr",
          paseoHome,
        },
        createCoreDeps(),
      );

      expect(result.intent).toEqual({
        kind: "checkout-change-request",
        forge: "github",
        changeRequestNumber: 123,
        headRef: "feature/review-pr",
        baseRefName: "main",
        checkoutRefs: [{ remoteName: "origin", remoteRef: "refs/pull/123/head" }],
        trackOriginHead: true,
      });
      expect(result.worktree.branchName).toBe("feature/review-pr");
    });

    test("round trips every resolved change-request field through an unchanged before-hook result", async () => {
      const { tempDir, repoDir, paseoHome } = createGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      const deps = createCoreDeps();
      const requests: unknown[] = [];
      const result = await createCoreWorktree(
        { cwd: repoDir, githubPrNumber: 123, refName: "feature/review-pr", paseoHome },
        {
          ...deps,
          lifecycle: {
            before: async (name, request) => {
              requests.push(request);
              return validateBeforeResult(name, validateBeforeRequest(name, request), request);
            },
          },
        },
      );
      expect(requests).toEqual([
        {
          kind: "checkout-change-request",
          forge: "github",
          changeRequestNumber: 123,
          headRef: "feature/review-pr",
          baseRef: "main",
          branch: "feature/review-pr",
          checkoutRefs: [{ remoteName: "origin", remoteRef: "refs/pull/123/head" }],
          trackOriginHead: true,
          repoRoot: repoDir,
          sourceCheckout: repoDir,
          slug: "feature-review-pr",
          path: result.worktree.worktreePath,
        },
      ]);
      expect(result.worktree.branchName).toBe("feature/review-pr");
    });

    test("uses the PR head ref as the default slug when no slug is supplied", async () => {
      const { tempDir, repoDir, paseoHome } = createGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          githubPrNumber: 123,
          refName: "feature/review-pr",
          paseoHome,
        },
        createCoreDeps(),
      );

      expect(path.basename(result.worktree.worktreePath)).toBe("feature-review-pr");
      expect(result.worktree.branchName).toBe("feature/review-pr");
    });

    test("creates the MCP standalone worktree input shape", async () => {
      const { tempDir, repoDir, paseoHome } = createGitRepo();
      cleanupPaths.push(tempDir);

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          worktreeSlug: "mcp-standalone",
          paseoHome,
        },
        createCoreDeps(),
      );

      expect(result.intent).toEqual({
        kind: "branch-off",
        baseBranch: "main",
        branchName: "mcp-standalone",
      });
      expect(result.worktree.branchName).toBe("mcp-standalone");
    });

    test("branches off an explicit refName base", async () => {
      const { tempDir, repoDir, paseoHome } = createGitRepoWithDevBranch();
      cleanupPaths.push(tempDir);
      const devTip = execFileSync("git", ["rev-parse", "dev"], { cwd: repoDir, stdio: "pipe" })
        .toString()
        .trim();

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          worktreeSlug: "from-dev",
          action: "branch-off",
          refName: "dev",
          paseoHome,
        },
        createCoreDeps(),
      );

      const mergeBase = execFileSync("git", ["merge-base", "HEAD", devTip], {
        cwd: result.worktree.worktreePath,
        stdio: "pipe",
      })
        .toString()
        .trim();
      expect(result.intent).toEqual({
        kind: "branch-off",
        baseBranch: "dev",
        branchName: "from-dev",
      });
      expect(mergeBase).toBe(devTip);
    });

    test("checks out an explicit existing branch", async () => {
      const { tempDir, repoDir, paseoHome } = createGitRepoWithDevBranch();
      cleanupPaths.push(tempDir);

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          action: "checkout",
          refName: "dev",
          paseoHome,
        },
        createCoreDeps(),
      );

      const branch = execFileSync("git", ["branch", "--show-current"], {
        cwd: result.worktree.worktreePath,
        stdio: "pipe",
      })
        .toString()
        .trim();
      expect(result.intent).toEqual({
        kind: "checkout-branch",
        branchName: "dev",
      });
      expect(branch).toBe("dev");
    });

    test("checks out a branch that only a remote other than origin has", async () => {
      const { tempDir, repoDir, paseoHome } = createGitRepo();
      cleanupPaths.push(tempDir);
      const upstreamDir = path.join(tempDir, "upstream.git");
      execFileSync("git", ["clone", "--bare", repoDir, upstreamDir], { stdio: "pipe" });
      execFileSync("git", [`--git-dir=${upstreamDir}`, "branch", "feature/upstream-only", "main"], {
        stdio: "pipe",
      });
      execFileSync("git", ["remote", "add", "upstream", upstreamDir], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["fetch", "upstream"], { cwd: repoDir, stdio: "pipe" });

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          action: "checkout",
          refName: "feature/upstream-only",
          paseoHome,
        },
        createCoreDeps(),
      );

      expect(result.worktree.branchName).toBe("feature/upstream-only");
      expect(getBranchUpstream(result.worktree.worktreePath)).toBe(
        "upstream/feature/upstream-only",
      );
    });

    test("checks out an explicit GitHub PR target", async () => {
      const { tempDir, repoDir, paseoHome } = createGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          action: "checkout",
          githubPrNumber: 123,
          paseoHome,
        },
        createCoreDeps(),
      );

      expect(result.intent).toEqual({
        kind: "checkout-change-request",
        forge: "github",
        changeRequestNumber: 123,
        headRef: "pr-123",
        baseRefName: "main",
        checkoutRefs: [{ remoteName: "origin", remoteRef: "refs/pull/123/head" }],
        trackOriginHead: true,
      });
      expect(result.worktree.branchName).toBe("pr-123");
    });

    test("tracks a same-repo PR branch from a single-branch clone", async () => {
      const { tempDir, repoDir, remoteDir, paseoHome } = createSameRepoGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      execFileSync("git", ["config", "--unset-all", "remote.origin.fetch"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync(
        "git",
        ["config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"],
        { cwd: repoDir, stdio: "pipe" },
      );
      execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/daemon-shutdown-diagnostics"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      const github = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async () => ({
          number: 1790,
          baseRefName: "main",
          headRefName: "daemon-shutdown-diagnostics",
          headOwnerLogin: "getpaseo",
          headRepositorySshUrl: remoteDir,
          headRepositoryUrl: remoteDir,
          isCrossRepository: false,
        }),
      };

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          action: "checkout",
          githubPrNumber: 1790,
          paseoHome,
        },
        createCoreDeps({ github }),
      );

      expect(result.worktree.branchName).toBe("daemon-shutdown-diagnostics");
      expect(getBranchUpstream(result.worktree.worktreePath)).toBe(
        "origin/daemon-shutdown-diagnostics",
      );
    });

    test("checks out a GitLab MR source branch through the resolved forge service", async () => {
      const { tempDir, repoDir, paseoHome } = createGitRepoWithOriginFeatureBranch();
      cleanupPaths.push(tempDir);
      const gitlab: ForgeService = {
        ...createGitHubServiceStub(),
        // A non-GitHub forge does not expose GitHub's refs/pull capabilities;
        // the shell falls back to fetching the head branch under refs/heads.
        defaultCheckoutRefs: undefined,
        buildPrLocalBranchName: undefined,
        supportsCrossRepoCheckoutWithoutRefs: false,
        getPullRequestCheckoutTarget: async ({ number }) => ({
          number,
          baseRefName: "main",
          headRefName: "feature/gitlab-mr",
          headOwnerLogin: null,
          headRepositorySshUrl: null,
          headRepositoryUrl: null,
          isCrossRepository: false,
        }),
      };

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          action: "checkout",
          githubPrNumber: 14,
          paseoHome,
        },
        createCoreDeps({ forge: { forge: "gitlab", service: gitlab } }),
      );

      const branch = execFileSync("git", ["branch", "--show-current"], {
        cwd: result.worktree.worktreePath,
        stdio: "pipe",
      })
        .toString()
        .trim();
      expect(result.intent).toEqual({
        kind: "checkout-change-request",
        forge: "gitlab",
        changeRequestNumber: 14,
        headRef: "feature/gitlab-mr",
        baseRefName: "main",
        checkoutRefs: [{ remoteName: "origin", remoteRef: "refs/heads/feature/gitlab-mr" }],
        trackOriginHead: true,
      });
      expect(branch).toBe("feature/gitlab-mr");
      expect(readFileSync(path.join(result.worktree.worktreePath, "README.md"), "utf8")).toBe(
        "gitlab mr branch\n",
      );
    });

    test("checks out a GitLab MR ref when the source branch is gone", async () => {
      const { tempDir, repoDir, paseoHome } = createGitLabMrRefOnlyRemoteRepo();
      cleanupPaths.push(tempDir);
      const gitlab: ForgeService = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async ({ number }) => ({
          number,
          baseRefName: "main",
          headRefName: "feature/gitlab-mr",
          checkoutRefs: [
            { remoteName: "origin", remoteRef: "refs/merge-requests/14/head" },
            { remoteName: "origin", remoteRef: "refs/heads/feature/gitlab-mr" },
          ],
          headOwnerLogin: null,
          headRepositorySshUrl: null,
          headRepositoryUrl: null,
          isCrossRepository: false,
        }),
      };

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          action: "checkout",
          githubPrNumber: 14,
          paseoHome,
        },
        createCoreDeps({ forge: { forge: "gitlab", service: gitlab } }),
      );

      expect(result.intent).toMatchObject({
        kind: "checkout-change-request",
        forge: "gitlab",
        changeRequestNumber: 14,
        headRef: "feature/gitlab-mr",
      });
      expect(readFileSync(path.join(result.worktree.worktreePath, "README.md"), "utf8")).toBe(
        "gitlab mr branch\n",
      );
      expect(getBranchUpstream(result.worktree.worktreePath)).toBeNull();
    });

    test("checks out the authoritative GitLab MR ref before a same-named origin branch", async () => {
      const { tempDir, repoDir, paseoHome } = createGitLabMrWithConflictingOriginBranchRepo();
      cleanupPaths.push(tempDir);
      const gitlab = createGitLabService({
        resolveGlabPath: async () => "/usr/bin/glab",
        resolveRemoteUrl: async () => "git@gitlab.example.com:example-group/example-project.git",
        runner: async (args) => {
          if (args[0] === "mr" && args[1] === "view") {
            return {
              stdout: JSON.stringify({
                iid: 14,
                title: "Review actual merge request head",
                web_url:
                  "https://gitlab.example.com/example-group/example-project/-/merge_requests/14",
                state: "opened",
                source_branch: "feature/gitlab-mr",
                target_branch: "main",
                source_project_id: 202,
                target_project_id: 101,
              }),
              stderr: "",
            };
          }
          throw new Error(`unexpected glab args: ${args.join(" ")}`);
        },
      });

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          action: "checkout",
          githubPrNumber: 14,
          paseoHome,
        },
        createCoreDeps({ forge: { forge: "gitlab", service: gitlab } }),
      );

      expect(result.intent).toMatchObject({
        kind: "checkout-change-request",
        forge: "gitlab",
        checkoutRefs: [
          { remoteName: "origin", remoteRef: "refs/merge-requests/14/head" },
          { remoteName: "origin", remoteRef: "refs/heads/feature/gitlab-mr" },
        ],
      });
      expect(readFileSync(path.join(result.worktree.worktreePath, "README.md"), "utf8")).toBe(
        "authoritative merge request head\n",
      );
    });

    test("does not add a fallback push remote for a cross-repo MR without a push URL", async () => {
      const { tempDir, repoDir, paseoHome } = createGitLabMrRefOnlyRemoteRepo();
      cleanupPaths.push(tempDir);
      const gitlab: ForgeService = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async ({ number }) => ({
          number,
          baseRefName: "main",
          headRefName: "feature/gitlab-mr",
          checkoutRefs: [
            { remoteName: "origin", remoteRef: "refs/merge-requests/14/head" },
            { remoteName: "origin", remoteRef: "refs/heads/feature/gitlab-mr" },
          ],
          headOwnerLogin: null,
          headRepositorySshUrl: null,
          headRepositoryUrl: null,
          isCrossRepository: true,
        }),
      };

      await createCoreWorktree(
        {
          cwd: repoDir,
          worktreeSlug: "first-gitlab-mr",
          action: "checkout",
          githubPrNumber: 14,
          paseoHome,
        },
        createCoreDeps({ forge: { forge: "gitlab", service: gitlab } }),
      );
      const second = await createCoreWorktree(
        {
          cwd: repoDir,
          worktreeSlug: "second-gitlab-mr",
          action: "checkout",
          githubPrNumber: 14,
          paseoHome,
        },
        createCoreDeps({ forge: { forge: "gitlab", service: gitlab } }),
      );

      const pushRemote = getGitConfigValue(
        second.worktree.worktreePath,
        `branch.${second.worktree.branchName}.pushRemote`,
      );
      const pushRefspec = getGitConfigValue(
        second.worktree.worktreePath,
        "remote.paseo-pr-14.push",
      );
      const pushRemoteUrl = getGitConfigValue(
        second.worktree.worktreePath,
        "remote.paseo-pr-14.url",
      );
      const metadata = await readPaseoWorktreeMetadata(second.worktree.worktreePath);
      const facts = await getCheckoutSnapshotFacts(second.worktree.worktreePath, { paseoHome });

      expect(second.worktree.branchName).toBe("feature/gitlab-mr-1");
      expect(pushRemote).toBeNull();
      expect(pushRefspec).toBeNull();
      expect(pushRemoteUrl).toBeNull();
      expect(metadata?.changeRequestLookupTarget).toEqual({
        headRef: "feature/gitlab-mr",
        changeRequestNumber: 14,
        localBranchName: "feature/gitlab-mr-1",
      });
      expect(facts).toMatchObject({
        isGit: true,
        currentBranch: "feature/gitlab-mr-1",
        pullRequestLookupTarget: { headRef: "feature/gitlab-mr" },
      });
    });

    test("checks out a same-repo GitHub PR with valid origin tracking", async () => {
      const { tempDir, repoDir, remoteDir, paseoHome } = createSameRepoGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      const github = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async () => ({
          number: 1790,
          baseRefName: "main",
          headRefName: "daemon-shutdown-diagnostics",
          headOwnerLogin: "getpaseo",
          headRepositorySshUrl: remoteDir,
          headRepositoryUrl: remoteDir,
          isCrossRepository: false,
        }),
      };

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          action: "checkout",
          githubPrNumber: 1790,
          paseoHome,
        },
        createCoreDeps({ github }),
      );
      const status = await getCheckoutStatus(result.worktree.worktreePath, { paseoHome });

      expect(result.worktree.branchName).toBe("daemon-shutdown-diagnostics");
      expect(getBranchUpstream(result.worktree.worktreePath)).toBe(
        "origin/daemon-shutdown-diagnostics",
      );
      expect(status).toMatchObject({
        isGit: true,
        currentBranch: "daemon-shutdown-diagnostics",
        aheadOfOrigin: 0,
        behindOfOrigin: 0,
      });
    });

    test("checks out a same-repo GitHub PR whose head branch was deleted", async () => {
      const { tempDir, repoDir, remoteDir, paseoHome } = createSameRepoGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      execFileSync(
        "git",
        ["--git-dir", remoteDir, "update-ref", "-d", "refs/heads/daemon-shutdown-diagnostics"],
        { stdio: "pipe" },
      );
      const github = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async () => ({
          number: 1790,
          baseRefName: "main",
          headRefName: "daemon-shutdown-diagnostics",
          headOwnerLogin: "getpaseo",
          headRepositorySshUrl: remoteDir,
          headRepositoryUrl: remoteDir,
          isCrossRepository: false,
        }),
      };

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          action: "checkout",
          githubPrNumber: 1790,
          paseoHome,
        },
        createCoreDeps({ github }),
      );
      const readme = readFileSync(path.join(result.worktree.worktreePath, "README.md"), "utf8");

      expect(result.worktree.branchName).toBe("daemon-shutdown-diagnostics");
      expect(readme.replace(/\r\n/g, "\n")).toBe("same repo pr branch\n");
      expect(getBranchUpstream(result.worktree.worktreePath)).toBeNull();
    });

    test.each([true, false])(
      "checks out the fetched PR head with local branch collision=%s",
      async (collision) => {
        const { tempDir, repoDir, remoteDir, paseoHome } = createSameRepoGitHubPrRemoteRepo();
        cleanupPaths.push(tempDir);
        const branch = "daemon-shutdown-diagnostics";
        const cached = execFileSync("git", ["rev-parse", "main"], {
          cwd: repoDir,
          encoding: "utf8",
        }).trim();
        if (collision) execFileSync("git", ["branch", "-f", branch, cached], { cwd: repoDir });
        const expected = execFileSync(
          "git",
          ["--git-dir", remoteDir, "rev-parse", "refs/pull/1790/head"],
          { encoding: "utf8" },
        ).trim();
        expect(cached).not.toBe(expected);

        const wt = path.join(tempDir, "wt");
        writeFileSync(
          wt,
          `#!/bin/sh
if [ "$3" = remove ]; then
  exec git -C "$2" worktree remove --force "$2-pr-checkout"
fi
repo="$2"
shift 2
branch=""
base=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --create) branch="$2"; shift 2 ;;
    --base) base="$2"; shift 2 ;;
    *) shift ;;
  esac
done
git -C "$repo" worktree add --quiet -b "$branch" "$repo-pr-checkout" "$base" || exit $?
printf '{"action":"created","path":"%s","branch":"%s","created_branch":true}\\n' "$repo-pr-checkout" "$branch"
printf 'setup' > "$repo-pr-checkout/.worktrunk-setup"
`,
          { mode: 0o755 },
        );
        const previous = process.env.WORKTRUNK_BIN;
        process.env.WORKTRUNK_BIN = wt;
        try {
          const result = await createCoreWorktree(
            { cwd: repoDir, action: "checkout", refName: branch, githubPrNumber: 1790, paseoHome },
            {
              ...createCoreDeps(),
              worktreeManagers: {
                hasWorktreeManager: () => true,
                createWorktree: async (request) => {
                  const managed = await createWithWorktrunk(request, new AbortController().signal);
                  return managed ? { pluginId: "worktrunk", path: managed.path } : null;
                },
                removeWorktree: async () => null,
              },
            },
          );
          expect(
            execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: result.worktree.worktreePath,
              encoding: "utf8",
            }).trim(),
          ).toBe(expected);
          expect(
            execFileSync("git", ["rev-parse", `refs/heads/${branch}`], {
              cwd: repoDir,
              encoding: "utf8",
            }).trim(),
          ).toBe(collision ? cached : expected);
          expect(existsSync(path.join(result.worktree.worktreePath, ".worktrunk-setup"))).toBe(
            !collision,
          );
        } finally {
          if (previous === undefined) delete process.env.WORKTRUNK_BIN;
          else process.env.WORKTRUNK_BIN = previous;
        }
      },
    );

    test("pushes a deduplicated same-repo GitHub PR branch to the PR head", async () => {
      const { tempDir, repoDir, remoteDir, paseoHome } = createSameRepoGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      execFileSync("git", ["remote", "set-url", "origin", `file://${remoteDir}`], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["remote", "set-url", "--push", "origin", remoteDir], {
        cwd: repoDir,
        stdio: "pipe",
      });
      const github = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async () => ({
          number: 1790,
          baseRefName: "main",
          headRefName: "daemon-shutdown-diagnostics",
          headOwnerLogin: "getpaseo",
          headRepositorySshUrl: remoteDir,
          headRepositoryUrl: remoteDir,
          isCrossRepository: false,
        }),
      };

      await createCoreWorktree(
        {
          cwd: repoDir,
          worktreeSlug: "first-pr-worktree",
          action: "checkout",
          githubPrNumber: 1790,
          paseoHome,
        },
        createCoreDeps({ github }),
      );
      const second = await createCoreWorktree(
        {
          cwd: repoDir,
          worktreeSlug: "second-pr-worktree",
          action: "checkout",
          githubPrNumber: 1790,
          paseoHome,
        },
        createCoreDeps({ github }),
      );
      writeFileSync(path.join(second.worktree.worktreePath, "FOLLOWUP.md"), "same repo edit\n");
      execFileSync("git", ["add", "FOLLOWUP.md"], {
        cwd: second.worktree.worktreePath,
        stdio: "pipe",
      });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "same repo edit"], {
        cwd: second.worktree.worktreePath,
        stdio: "pipe",
      });
      const localHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: second.worktree.worktreePath,
        stdio: "pipe",
      })
        .toString()
        .trim();
      const pushRemote = execFileSync(
        "git",
        ["config", `branch.${second.worktree.branchName}.pushRemote`],
        {
          cwd: second.worktree.worktreePath,
          stdio: "pipe",
        },
      )
        .toString()
        .trim();
      const pushRefspec = execFileSync("git", ["config", "remote.paseo-pr-1790.push"], {
        cwd: second.worktree.worktreePath,
        stdio: "pipe",
      })
        .toString()
        .trim();
      const pushRemoteUrl = execFileSync("git", ["config", "remote.paseo-pr-1790.url"], {
        cwd: second.worktree.worktreePath,
        stdio: "pipe",
      })
        .toString()
        .trim();

      execFileSync("git", ["push"], { cwd: second.worktree.worktreePath, stdio: "pipe" });

      const remotePrHead = execFileSync(
        "git",
        ["--git-dir", remoteDir, "rev-parse", "refs/heads/daemon-shutdown-diagnostics"],
        { stdio: "pipe" },
      )
        .toString()
        .trim();
      const dedupedRemoteBranch = spawnSync(
        "git",
        [
          "--git-dir",
          remoteDir,
          "show-ref",
          "--verify",
          "--quiet",
          "refs/heads/daemon-shutdown-diagnostics-1",
        ],
        { encoding: "utf8" },
      );

      expect(second.worktree.branchName).toBe("daemon-shutdown-diagnostics-1");
      expect(second.intent).toMatchObject({
        kind: "checkout-change-request",
        trackOriginHead: true,
      });
      expect(getBranchUpstream(second.worktree.worktreePath)).toBe(
        "origin/daemon-shutdown-diagnostics",
      );
      expect(pushRemote).toBe("paseo-pr-1790");
      expect(pushRefspec).toBe("HEAD:refs/heads/daemon-shutdown-diagnostics");
      expect(pushRemoteUrl).toBe(remoteDir);
      expect(remotePrHead).toBe(localHead);
      expect(dedupedRemoteBranch.status).toBe(1);
    });

    test("derives the tracked PR lookup target when managed metadata has no target", async () => {
      const { tempDir, repoDir, remoteDir, paseoHome } = createSameRepoGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      execFileSync("git", ["remote", "set-url", "origin", `file://${remoteDir}`], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["remote", "set-url", "--push", "origin", remoteDir], {
        cwd: repoDir,
        stdio: "pipe",
      });
      const github = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async () => ({
          number: 1790,
          baseRefName: "main",
          headRefName: "daemon-shutdown-diagnostics",
          headOwnerLogin: "getpaseo",
          headRepositorySshUrl: remoteDir,
          headRepositoryUrl: remoteDir,
          isCrossRepository: false,
        }),
      };

      await createCoreWorktree(
        {
          cwd: repoDir,
          worktreeSlug: "first-pr-worktree",
          action: "checkout",
          githubPrNumber: 1790,
          paseoHome,
        },
        createCoreDeps({ github }),
      );
      const second = await createCoreWorktree(
        {
          cwd: repoDir,
          worktreeSlug: "second-pr-worktree",
          action: "checkout",
          githubPrNumber: 1790,
          paseoHome,
        },
        createCoreDeps({ github }),
      );
      writeFileSync(
        await getPaseoWorktreeMetadataPath(second.worktree.worktreePath),
        `${JSON.stringify({ version: 1, baseRefName: "main" }, null, 2)}\n`,
        "utf8",
      );

      const currentHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: second.worktree.worktreePath,
        encoding: "utf8",
      }).trim();
      const facts = await getCheckoutSnapshotFacts(second.worktree.worktreePath, { paseoHome });

      expect(second.worktree.branchName).toBe("daemon-shutdown-diagnostics-1");
      expect(facts).toMatchObject({
        isGit: true,
        currentBranch: "daemon-shutdown-diagnostics-1",
        pullRequestLookupTarget: {
          headRef: "daemon-shutdown-diagnostics",
          headSha: currentHead,
        },
      });
    });

    test("checks out a fork PR whose head branch collides with local main", async () => {
      const { tempDir, repoDir, headRemoteDir, paseoHome } = createForkGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      const github = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async () => ({
          number: 526,
          baseRefName: "main",
          headRefName: "main",
          headOwnerLogin: "therainisme",
          headRepositorySshUrl: headRemoteDir,
          headRepositoryUrl: headRemoteDir,
          isCrossRepository: true,
        }),
      };

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          action: "checkout",
          githubPrNumber: 526,
          refName: "main",
          paseoHome,
        },
        createCoreDeps({ github }),
      );

      const sourceBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: repoDir,
        stdio: "pipe",
      })
        .toString()
        .trim();
      const worktreeBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: result.worktree.worktreePath,
        stdio: "pipe",
      })
        .toString()
        .trim();
      const readme = readFileSync(path.join(result.worktree.worktreePath, "README.md"), "utf8");
      const cleanStatus = await getCheckoutStatus(result.worktree.worktreePath, { paseoHome });
      const pushRefspec = execFileSync("git", ["config", "remote.paseo-pr-526.push"], {
        cwd: result.worktree.worktreePath,
        stdio: "pipe",
      })
        .toString()
        .trim();
      writeFileSync(path.join(result.worktree.worktreePath, "FOLLOWUP.md"), "maintainer edit\n");
      execFileSync("git", ["add", "FOLLOWUP.md"], {
        cwd: result.worktree.worktreePath,
        stdio: "pipe",
      });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "maintainer edit"], {
        cwd: result.worktree.worktreePath,
        stdio: "pipe",
      });
      const localHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: result.worktree.worktreePath,
        stdio: "pipe",
      })
        .toString()
        .trim();

      execFileSync("git", ["push"], { cwd: result.worktree.worktreePath, stdio: "pipe" });

      const remotePrHead = execFileSync("git", [
        "--git-dir",
        headRemoteDir,
        "rev-parse",
        "refs/heads/main",
      ])
        .toString()
        .trim();

      expect(sourceBranch).toBe("main");
      expect(result.intent).toEqual({
        kind: "checkout-change-request",
        forge: "github",
        changeRequestNumber: 526,
        headRef: "main",
        headRepository: "therainisme/therainisme",
        headRepositoryOwner: "therainisme",
        baseRefName: "main",
        checkoutRefs: [{ remoteName: "origin", remoteRef: "refs/pull/526/head" }],
        localBranchName: "therainisme/main",
        pushRemoteUrl: headRemoteDir,
      });
      expect(result.worktree.branchName).toBe("therainisme/main");
      expect(path.basename(result.worktree.worktreePath)).toBe("therainisme-main");
      expect(worktreeBranch).toBe("therainisme/main");
      expect(readme.replace(/\r\n/g, "\n")).toBe("fork pr main branch\n");
      expect(getBranchUpstream(result.worktree.worktreePath)).toBe("paseo-pr-526/main");
      expect(pushRefspec).toBe("HEAD:refs/heads/main");
      expect(cleanStatus).toMatchObject({
        isGit: true,
        currentBranch: "therainisme/main",
        aheadOfOrigin: 0,
        behindOfOrigin: 0,
      });
      expect(remotePrHead).toBe(localHead);
    });

    test("pushes a fork PR when the contributor branch cannot be fetched at checkout", async () => {
      const { tempDir, repoDir, headRemoteDir, paseoHome } = createForkGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      execFileSync("git", ["--git-dir", headRemoteDir, "update-ref", "-d", "refs/heads/main"], {
        stdio: "pipe",
      });
      const github = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async () => ({
          number: 526,
          baseRefName: "main",
          headRefName: "main",
          headOwnerLogin: "therainisme",
          headRepositorySshUrl: headRemoteDir,
          headRepositoryUrl: headRemoteDir,
          isCrossRepository: true,
        }),
      };

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          action: "checkout",
          githubPrNumber: 526,
          refName: "main",
          paseoHome,
        },
        createCoreDeps({ github }),
      );
      const pushRemote = execFileSync(
        "git",
        ["config", `branch.${result.worktree.branchName}.pushRemote`],
        {
          cwd: result.worktree.worktreePath,
          stdio: "pipe",
        },
      )
        .toString()
        .trim();
      const pushRefspec = execFileSync("git", ["config", "remote.paseo-pr-526.push"], {
        cwd: result.worktree.worktreePath,
        stdio: "pipe",
      })
        .toString()
        .trim();
      const upstreamBeforePush = getBranchUpstream(result.worktree.worktreePath);
      writeFileSync(path.join(result.worktree.worktreePath, "FOLLOWUP.md"), "fork edit\n");
      execFileSync("git", ["add", "FOLLOWUP.md"], {
        cwd: result.worktree.worktreePath,
        stdio: "pipe",
      });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "fork edit"], {
        cwd: result.worktree.worktreePath,
        stdio: "pipe",
      });
      const localHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: result.worktree.worktreePath,
        stdio: "pipe",
      })
        .toString()
        .trim();

      await pushCurrentBranch(result.worktree.worktreePath);

      const remotePrHead = execFileSync("git", [
        "--git-dir",
        headRemoteDir,
        "rev-parse",
        "refs/heads/main",
      ])
        .toString()
        .trim();
      const trackedPrRemoteHead = execFileSync(
        "git",
        ["rev-parse", "refs/remotes/paseo-pr-526/main"],
        {
          cwd: result.worktree.worktreePath,
          stdio: "pipe",
        },
      )
        .toString()
        .trim();
      const afterPushStatus = await getCheckoutStatus(result.worktree.worktreePath);

      expect(result.worktree.branchName).toBe("therainisme/main");
      expect(upstreamBeforePush).toBeNull();
      expect(getBranchUpstream(result.worktree.worktreePath)).toBe("paseo-pr-526/main");
      expect(pushRemote).toBe("paseo-pr-526");
      expect(pushRefspec).toBe("HEAD:refs/heads/main");
      expect(remotePrHead).toBe(localHead);
      expect(trackedPrRemoteHead).toBe(localHead);
      expect(afterPushStatus).toMatchObject({
        isGit: true,
        currentBranch: "therainisme/main",
        aheadOfOrigin: 0,
        behindOfOrigin: 0,
      });
    });

    test("uses a unique local branch when the same fork PR branch already exists", async () => {
      const { tempDir, repoDir, headRemoteDir, paseoHome } = createForkGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      const github = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async () => ({
          number: 526,
          baseRefName: "main",
          headRefName: "main",
          headOwnerLogin: "therainisme",
          headRepositorySshUrl: headRemoteDir,
          headRepositoryUrl: headRemoteDir,
          isCrossRepository: true,
        }),
      };

      const first = await createCoreWorktree(
        {
          cwd: repoDir,
          worktreeSlug: "first-pr-worktree",
          action: "checkout",
          githubPrNumber: 526,
          refName: "main",
          paseoHome,
        },
        createCoreDeps({ github }),
      );
      const second = await createCoreWorktree(
        {
          cwd: repoDir,
          worktreeSlug: "second-pr-worktree",
          action: "checkout",
          githubPrNumber: 526,
          refName: "main",
          paseoHome,
        },
        createCoreDeps({ github }),
      );

      expect(first.worktree.branchName).toBe("therainisme/main");
      expect(second.worktree.branchName).toBe("therainisme/main-1");
      expect(getBranchUpstream(first.worktree.worktreePath)).toBe("paseo-pr-526/main");
      expect(getBranchUpstream(second.worktree.worktreePath)).toBe("paseo-pr-526/main");
    });

    test("rejects and rolls back a managed fork PR checkout whose HEAD is behind the current PR head", async () => {
      const { tempDir, repoDir, headRemoteDir, paseoHome } = createForkGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      const staleBranch = "archived-fork-pr-526";
      const staleWorktreePath = path.join(tempDir, "stale-fork-pr");
      git(repoDir, "branch", staleBranch, "main");
      const github = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async () => ({
          number: 526,
          baseRefName: "main",
          headRefName: "main",
          headOwnerLogin: "therainisme",
          headRepositorySshUrl: headRemoteDir,
          headRepositoryUrl: headRemoteDir,
          isCrossRepository: true,
        }),
      };

      await expect(
        createCoreWorktree(
          {
            cwd: repoDir,
            worktreeSlug: "fork-pr-stale",
            action: "checkout",
            githubPrNumber: 526,
            refName: "main",
            paseoHome,
          },
          {
            ...createCoreDeps({ github }),
            worktreeManagers: {
              hasWorktreeManager: () => true,
              createWorktree: async () => {
                git(repoDir, "worktree", "add", staleWorktreePath, staleBranch);
                return { pluginId: "stale-manager", path: staleWorktreePath };
              },
              removeWorktree: async () => null,
            },
          },
        ),
      ).rejects.toThrow("expected change request head");
      expect(existsSync(staleWorktreePath)).toBe(false);
    });

    test("fails before calling the manager when the remote PR ref cannot be fetched", async () => {
      const { tempDir, repoDir, headRemoteDir, paseoHome } = createForkGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      let managerCalled = false;
      git(repoDir, "remote", "set-url", "origin", path.join(tempDir, "missing-remote.git"));
      const github = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async () => ({
          number: 526,
          baseRefName: "main",
          headRefName: "main",
          headOwnerLogin: "therainisme",
          headRepositorySshUrl: headRemoteDir,
          headRepositoryUrl: headRemoteDir,
          isCrossRepository: true,
        }),
      };

      await expect(
        createCoreWorktree(
          {
            cwd: repoDir,
            worktreeSlug: "fork-pr-offline",
            action: "checkout",
            githubPrNumber: 526,
            refName: "main",
            paseoHome,
          },
          {
            ...createCoreDeps({ github }),
            worktreeManagers: {
              hasWorktreeManager: () => true,
              createWorktree: async () => {
                managerCalled = true;
                return null;
              },
              removeWorktree: async () => null,
            },
          },
        ),
      ).rejects.toThrow("Unable to fetch change request refs");
      expect(managerCalled).toBe(false);
    });

    test("accepts a managed fork PR checkout matching the pre-fetched headSha even after multiple mid-setup pushes", async () => {
      const { tempDir, repoDir, headRemoteDir, paseoHome } = createForkGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      const baseRemoteDir = path.join(tempDir, "base.git");
      const initialPrHead = git(repoDir, "ls-remote", "origin", "refs/pull/526/head").split(
        /\s+/,
      )[0];
      const managedPath = path.join(tempDir, "mid-push-fork-pr");
      const github = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async () => ({
          number: 526,
          baseRefName: "main",
          headRefName: "main",
          headOwnerLogin: "therainisme",
          headRepositorySshUrl: headRemoteDir,
          headRepositoryUrl: headRemoteDir,
          isCrossRepository: true,
        }),
      };

      const pushCommit = (message: string) => {
        const headCloneDir = path.join(tempDir, "therainisme-clone");
        writeFileSync(path.join(headCloneDir, "README.md"), `${message}\n`);
        git(headCloneDir, "add", "README.md");
        git(headCloneDir, "-c", "commit.gpgsign=false", "commit", "-m", message);
        const head = git(headCloneDir, "rev-parse", "HEAD");
        git(headCloneDir, "push", "origin", "main");
        execFileSync("git", [`--git-dir=${baseRemoteDir}`, "fetch", headRemoteDir, "main"], {
          stdio: "pipe",
        });
        execFileSync(
          "git",
          [`--git-dir=${baseRemoteDir}`, "update-ref", "refs/pull/526/head", head],
          { stdio: "pipe" },
        );
      };

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          worktreeSlug: "fork-pr-mid-push",
          action: "checkout",
          githubPrNumber: 526,
          refName: "main",
          paseoHome,
        },
        {
          ...createCoreDeps({ github }),
          worktreeManagers: {
            hasWorktreeManager: () => true,
            createWorktree: async (request) => {
              expect(request.headSha).toBe(initialPrHead);
              // Two pushes happen while the manager creates the worktree from request.headSha.
              pushCommit("mid-setup push B");
              git(repoDir, "worktree", "add", "-b", "pr-526-snap", managedPath, request.headSha!);
              pushCommit("mid-setup push C");
              return { pluginId: "mid-push-manager", path: managedPath };
            },
            removeWorktree: async () => null,
          },
        },
      );

      expect(git(result.worktree.worktreePath, "rev-parse", "HEAD")).toBe(initialPrHead);
    });

    test("configures fork push remote on a managed Worktrunk PR checkout so Push updates the fork branch", async () => {
      const { tempDir, repoDir, headRemoteDir, paseoHome } = createForkGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      const baseRemoteDir = path.join(tempDir, "base.git");
      const wt = path.join(tempDir, "fake-wt-fork-push");
      writeFileSync(
        wt,
        `#!/bin/sh
repo="$2"
shift 2
branch=""
base=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --create) branch="$2"; shift 2 ;;
    --base) base="$2"; shift 2 ;;
    *) shift ;;
  esac
done
git -C "$repo" worktree add --quiet -b "$branch" "$repo-fork-managed" "$base" || exit $?
printf '{"action":"created","path":"%s","branch":"%s","created_branch":true}\\n' "$repo-fork-managed" "$branch"
`,
        { mode: 0o755 },
      );

      const github = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async () => ({
          number: 526,
          baseRefName: "main",
          headRefName: "main",
          headOwnerLogin: "therainisme",
          headRepositorySshUrl: headRemoteDir,
          headRepositoryUrl: headRemoteDir,
          isCrossRepository: true,
        }),
      };

      const previous = process.env.WORKTRUNK_BIN;
      process.env.WORKTRUNK_BIN = wt;
      try {
        const result = await createCoreWorktree(
          {
            cwd: repoDir,
            worktreeSlug: "fork-pr-managed-push",
            action: "checkout",
            githubPrNumber: 526,
            refName: "main",
            paseoHome,
          },
          {
            ...createCoreDeps({ github }),
            worktreeManagers: {
              hasWorktreeManager: () => true,
              createWorktree: async (request) => {
                const managed = await createWithWorktrunk(request, new AbortController().signal);
                return managed ? { pluginId: "worktrunk", path: managed.path } : null;
              },
              removeWorktree: async () => null,
            },
          },
        );
        expect(result.worktree.worktreeManagerPluginId).toBe("worktrunk");
        expect(result.worktree.branchName).toBe("therainisme/main");
        writeFileSync(path.join(result.worktree.worktreePath, "README.md"), "pushed from wt\n");
        git(result.worktree.worktreePath, "add", "README.md");
        git(
          result.worktree.worktreePath,
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "managed fork commit",
        );
        const pushedSha = git(result.worktree.worktreePath, "rev-parse", "HEAD");
        await pushCurrentBranch(result.worktree.worktreePath);

        expect(
          execFileSync("git", [`--git-dir=${headRemoteDir}`, "rev-parse", "refs/heads/main"], {
            encoding: "utf8",
          }).trim(),
        ).toBe(pushedSha);
        expect(
          execFileSync(
            "git",
            [`--git-dir=${baseRemoteDir}`, "for-each-ref", "refs/heads/therainisme/main"],
            { encoding: "utf8" },
          ).trim(),
        ).toBe("");
      } finally {
        if (previous === undefined) delete process.env.WORKTRUNK_BIN;
        else process.env.WORKTRUNK_BIN = previous;
      }
    });

    test("falls back to built-in Git without calling managers when Git rejects worktree list -z", async () => {
      const { tempDir, repoDir, paseoHome } = createGitRepo();
      cleanupPaths.push(tempDir);
      const trailingSpaceWorktree = path.join(tempDir, "detached space ");
      git(repoDir, "worktree", "add", "--detach", trailingSpaceWorktree, "main");
      writeFileSync(path.join(trailingSpaceWorktree, "keep.txt"), "do not delete\n");

      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const shimDir = path.join(tempDir, "legacy-git-bin");
      mkdirSync(shimDir, { recursive: true });
      writeFileSync(
        path.join(shimDir, "git"),
        `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "-z" ]; then
    echo 'error: unknown switch -z' >&2
    exit 129
  fi
done
exec "${realGit}" "$@"
`,
        { mode: 0o755 },
      );

      let managerCalled = false;
      const previousPath = process.env.PATH;
      process.env.PATH = `${shimDir}:${previousPath ?? ""}`;
      try {
        const result = await createCoreWorktree(
          {
            cwd: repoDir,
            worktreeSlug: "legacy-git-fallback",
            action: "branch-off",
            branchName: "legacy-git-fallback",
            paseoHome,
          },
          {
            ...createCoreDeps(),
            worktreeManagers: {
              hasWorktreeManager: () => true,
              createWorktree: async () => {
                managerCalled = true;
                return { pluginId: "bad-manager", path: trailingSpaceWorktree };
              },
              removeWorktree: async () => null,
            },
          },
        );
        expect(managerCalled).toBe(false);
        expect(result.worktree.branchName).toBe("legacy-git-fallback");
        expect(result.worktree.worktreeManagerPluginId).toBeUndefined();
        expect(readFileSync(path.join(trailingSpaceWorktree, "keep.txt"), "utf8")).toBe(
          "do not delete\n",
        );
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    });

    test("protects pre-existing and discovers newly managed worktrees whose paths contain a line break", async () => {
      const { tempDir, repoDir, paseoHome } = createGitRepo();
      cleanupPaths.push(tempDir);
      const newlineWorktree = path.join(tempDir, "manual\nworktree");
      git(repoDir, "worktree", "add", "-b", "newline-branch", newlineWorktree, "main");
      writeFileSync(path.join(newlineWorktree, "keep.txt"), "uncommitted\n");

      await expect(
        createCoreWorktree(
          {
            cwd: repoDir,
            worktreeSlug: "newline-hijack",
            action: "branch-off",
            branchName: "newline-hijack",
            paseoHome,
          },
          {
            ...createCoreDeps(),
            worktreeManagers: {
              hasWorktreeManager: () => true,
              createWorktree: async () => ({
                pluginId: "bad-manager",
                path: newlineWorktree,
              }),
              removeWorktree: async () => null,
            },
          },
        ),
      ).rejects.toThrow("already-existing worktree");

      expect(readFileSync(path.join(newlineWorktree, "keep.txt"), "utf8")).toBe("uncommitted\n");
      expect(await readPaseoWorktreeMetadata(newlineWorktree)).toBeNull();

      // A newly created managed worktree inside a directory containing a line break must remain
      // visible to discovery and marker-based ownership checks.
      const managedNewlineDir = path.join(tempDir, "parent\nbreak", "managed-wt");
      mkdirSync(path.dirname(managedNewlineDir), { recursive: true });
      const created = await createCoreWorktree(
        {
          cwd: repoDir,
          worktreeSlug: "newline-managed",
          action: "branch-off",
          branchName: "newline-managed",
          paseoHome,
        },
        {
          ...createCoreDeps(),
          worktreeManagers: {
            hasWorktreeManager: () => true,
            createWorktree: async (request) => {
              git(repoDir, "worktree", "add", "-b", request.branch, managedNewlineDir, "main");
              return { pluginId: "newline-manager", path: managedNewlineDir };
            },
            removeWorktree: async () => null,
          },
        },
      );

      const expectedPath = realpathSync(managedNewlineDir);
      expect(created.worktree.worktreePath).toBe(expectedPath);
      const allGitWorktrees = await listGitWorktrees({ cwd: repoDir });
      expect(allGitWorktrees.map((entry) => entry.path)).toContain(expectedPath);
      const paseoWorktrees = await listPaseoWorktrees({ cwd: repoDir, paseoHome });
      expect(paseoWorktrees.map((entry) => entry.path)).toContain(expectedPath);
      const ownership = await isPaseoOwnedWorktreeCwd(expectedPath, { paseoHome });
      expect(ownership.allowed).toBe(true);
      expect(ownership.worktreePath).toBe(expectedPath);
    });

    test("declines a Worktrunk fork PR checkout when the archived local branch already exists so Git checks out the latest PR head", async () => {
      const { tempDir, repoDir, headRemoteDir, paseoHome } = createForkGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      const archivedBranch = "therainisme/main";
      const archivedTip = git(repoDir, "rev-parse", "main");
      git(repoDir, "branch", archivedBranch, archivedTip);
      const latestPrHead = git(repoDir, "ls-remote", "origin", "refs/pull/526/head").split(
        /\s+/,
      )[0];
      expect(latestPrHead).not.toBe(archivedTip);

      const wt = path.join(tempDir, "fake-wt-fork-pr");
      writeFileSync(
        wt,
        `#!/bin/sh
echo "wt should not be invoked when local branch already exists" >&2
exit 1
`,
        { mode: 0o755 },
      );

      const github = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async () => ({
          number: 526,
          baseRefName: "main",
          headRefName: "main",
          headOwnerLogin: "therainisme",
          headRepositorySshUrl: headRemoteDir,
          headRepositoryUrl: headRemoteDir,
          isCrossRepository: true,
        }),
      };

      const previous = process.env.WORKTRUNK_BIN;
      process.env.WORKTRUNK_BIN = wt;
      try {
        const result = await createCoreWorktree(
          {
            cwd: repoDir,
            worktreeSlug: "fork-pr-reopen",
            action: "checkout",
            githubPrNumber: 526,
            refName: "main",
            paseoHome,
          },
          {
            ...createCoreDeps({ github }),
            worktreeManagers: {
              hasWorktreeManager: () => true,
              createWorktree: async (request) => {
                expect(request.untrusted).toBe(true);
                expect(request.headSha).toBe(latestPrHead);
                const managed = await createWithWorktrunk(request, new AbortController().signal);
                return managed ? { pluginId: "worktrunk", path: managed.path } : null;
              },
              removeWorktree: async () => null,
            },
          },
        );
        expect(git(result.worktree.worktreePath, "rev-parse", "HEAD")).toBe(latestPrHead);
        expect(git(repoDir, "rev-parse", `refs/heads/${archivedBranch}`)).toBe(archivedTip);
      } finally {
        if (previous === undefined) delete process.env.WORKTRUNK_BIN;
        else process.env.WORKTRUNK_BIN = previous;
      }
    });

    test("throws a typed error for an unknown checkout branch", async () => {
      const { tempDir, repoDir, paseoHome } = createGitRepo();
      cleanupPaths.push(tempDir);

      await expect(
        createCoreWorktree(
          {
            cwd: repoDir,
            action: "checkout",
            refName: "missing-branch",
            paseoHome,
          },
          createCoreDeps(),
        ),
      ).rejects.toBeInstanceOf(UnknownBranchError);
    });

    test("branches off a same-repo pull request's head without checking it out", async () => {
      const { tempDir, repoDir, remoteDir, paseoHome } = createSameRepoGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      // The head branch has never been fetched, so creation has to fetch it.
      execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/daemon-shutdown-diagnostics"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      const github = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async () => ({
          number: 1790,
          baseRefName: "main",
          headRefName: "daemon-shutdown-diagnostics",
          headOwnerLogin: "getpaseo",
          headRepositorySshUrl: remoteDir,
          headRepositoryUrl: remoteDir,
          isCrossRepository: false,
        }),
      };

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          action: "branch-off",
          checkoutSource: { kind: "change_request", forge: "github", number: 1790 },
          branchName: "follow-up",
          paseoHome,
        },
        createCoreDeps({ github }),
      );

      const prHead = execFileSync("git", [
        `--git-dir=${remoteDir}`,
        "rev-parse",
        "refs/pull/1790/head",
      ])
        .toString()
        .trim();
      expect(result.intent).toEqual({
        kind: "branch-off",
        baseBranch: "refs/remotes/origin/daemon-shutdown-diagnostics",
        startPoint: "refs/paseo/change-requests/1790",
        branchName: "follow-up",
      });
      expect(result.worktree.branchName).toBe("follow-up");
      expect(git(result.worktree.worktreePath, "rev-parse", "HEAD")).toBe(prHead);
      expect(getBranchUpstream(result.worktree.worktreePath)).toBeNull();
      expect(result.worktree.comparisonBaseRef).toBe(
        "refs/remotes/origin/daemon-shutdown-diagnostics",
      );
      expect(git(repoDir, "branch", "--list", "daemon-shutdown-diagnostics")).toBe("");
    });

    test("branches off a same-repo pull request in a clone whose origin is a fork", async () => {
      const { tempDir, repoDir, remoteDir, paseoHome } = createSameRepoGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      // The layout a fork clone has: upstream is the base repository, origin is the fork, and
      // the fork has an older branch with the pull request's branch name.
      const forkDir = path.join(tempDir, "fork.git");
      execFileSync("git", ["clone", "--bare", remoteDir, forkDir], { stdio: "pipe" });
      execFileSync("git", [
        `--git-dir=${forkDir}`,
        "update-ref",
        "refs/heads/daemon-shutdown-diagnostics",
        "refs/heads/main",
      ]);
      execFileSync("git", ["remote", "rename", "origin", "upstream"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["remote", "add", "origin", forkDir], { cwd: repoDir, stdio: "pipe" });
      const github = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async () => ({
          number: 1790,
          baseRefName: "main",
          headRefName: "daemon-shutdown-diagnostics",
          headOwnerLogin: "getpaseo",
          headRepositorySshUrl: remoteDir,
          headRepositoryUrl: remoteDir,
          isCrossRepository: false,
          // As the GitHub service lists them: origin first, then upstream.
          checkoutRefs: [
            { remoteName: "origin", remoteRef: "refs/pull/1790/head" },
            { remoteName: "upstream", remoteRef: "refs/pull/1790/head" },
          ],
        }),
      };

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          action: "branch-off",
          checkoutSource: { kind: "change_request", forge: "github", number: 1790 },
          branchName: "follow-up",
          paseoHome,
        },
        createCoreDeps({ github }),
      );

      const prHead = execFileSync("git", [
        `--git-dir=${remoteDir}`,
        "rev-parse",
        "refs/pull/1790/head",
      ])
        .toString()
        .trim();
      expect(git(result.worktree.worktreePath, "rev-parse", "HEAD")).toBe(prHead);
      expect(result.intent).toEqual({
        kind: "branch-off",
        baseBranch: "refs/remotes/upstream/daemon-shutdown-diagnostics",
        startPoint: "refs/paseo/change-requests/1790",
        branchName: "follow-up",
      });
    });

    test("checks out the base repository's pull request when the fork has its own pull request with that number", async () => {
      const { tempDir, repoDir, paseoHome } = createGitRepo();
      cleanupPaths.push(tempDir);
      // A fork clone: origin is the fork, upstream is the base repository, and both have a
      // pull request #42 with different heads.
      const pullRequestHeads: Record<string, string> = {};
      for (const name of ["fork", "base"]) {
        const bareDir = path.join(tempDir, `${name}.git`);
        execFileSync("git", ["clone", "--bare", repoDir, bareDir], { stdio: "pipe" });
        pullRequestHeads[name] = execFileSync("git", [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@test.com",
          `--git-dir=${bareDir}`,
          "commit-tree",
          "main^{tree}",
          "-p",
          "main",
          "-m",
          `${name} pull request 42`,
        ])
          .toString()
          .trim();
        execFileSync("git", [
          `--git-dir=${bareDir}`,
          "update-ref",
          "refs/pull/42/head",
          pullRequestHeads[name],
        ]);
      }
      const remotes = [
        { name: "origin", url: "https://github.com/someone/paseo.git", dir: "fork.git" },
        { name: "upstream", url: "git@github.com:getpaseo/paseo.git", dir: "base.git" },
      ];
      for (const remote of remotes) {
        execFileSync("git", ["remote", "add", remote.name, remote.url], { cwd: repoDir });
        execFileSync(
          "git",
          ["config", `url.${path.join(tempDir, remote.dir)}.insteadOf`, remote.url],
          { cwd: repoDir },
        );
      }
      // gh resolves the base repository for a clone with an upstream remote.
      const ghReplies = [
        JSON.stringify({ owner: { login: "getpaseo" }, name: "paseo", parent: null }),
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                number: 42,
                baseRefName: "main",
                headRefName: "feature/base-pr",
                isCrossRepository: false,
                headRepositoryOwner: { login: "getpaseo" },
                headRepository: {
                  sshUrl: "git@github.com:getpaseo/paseo.git",
                  url: "https://github.com/getpaseo/paseo",
                },
              },
            },
          },
        }),
      ];
      const github = createGitHubService({
        runner: async () => ({ stdout: ghReplies.shift() ?? "{}", stderr: "" }),
        resolveGhPath: async () => "/usr/bin/gh",
      });

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          action: "checkout",
          checkoutSource: { kind: "change_request", forge: "github", number: 42 },
          paseoHome,
        },
        createCoreDeps({ github }),
      );

      expect(result.worktree.branchName).toBe("feature/base-pr");
      expect(git(result.worktree.worktreePath, "rev-parse", "HEAD")).toBe(pullRequestHeads.base);
    });

    test("branches off a fork pull request's head without checking it out", async () => {
      const { tempDir, repoDir, headRemoteDir, paseoHome } = createForkGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      // The base repository's main moved on since this clone last fetched.
      const baseRemoteDir = path.join(tempDir, "base.git");
      const upstreamMain = execFileSync("git", [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@test.com",
        `--git-dir=${baseRemoteDir}`,
        "commit-tree",
        "main^{tree}",
        "-p",
        "main",
        "-m",
        "upstream commit",
      ])
        .toString()
        .trim();
      execFileSync("git", [
        `--git-dir=${baseRemoteDir}`,
        "update-ref",
        "refs/heads/main",
        upstreamMain,
      ]);
      const github = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async () => ({
          number: 526,
          baseRefName: "main",
          headRefName: "main",
          headOwnerLogin: "therainisme",
          headRepositorySshUrl: headRemoteDir,
          headRepositoryUrl: headRemoteDir,
          isCrossRepository: true,
        }),
      };

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          action: "branch-off",
          checkoutSource: { kind: "change_request", forge: "github", number: 526 },
          branchName: "follow-up",
          paseoHome,
        },
        {
          ...createCoreDeps({ github }),
          worktreeManagers: {
            hasWorktreeManager: () => true,
            async createWorktree(request) {
              expect(request.untrusted).toBe(true);
              return null;
            },
            async removeWorktree() {
              return null;
            },
          },
        },
      );

      expect(result.untrustedSource).toMatchObject({
        kind: "change_request",
        forge: "github",
        number: 526,
      });
      const readme = readFileSync(path.join(result.worktree.worktreePath, "README.md"), "utf8");
      // The fork's branch is not in this repository, so a pull request from the new branch goes
      // into the fork pull request's base, compared as the remote has it now.
      expect(result.intent).toEqual({
        kind: "branch-off",
        baseBranch: "refs/remotes/origin/main",
        startPoint: "refs/paseo/change-requests/526",
        branchName: "follow-up",
      });
      expect(git(repoDir, "rev-parse", "refs/remotes/origin/main")).toBe(upstreamMain);
      expect(result.worktree.comparisonBaseRef).toBe("refs/remotes/origin/main");
      expect(result.worktree.branchName).toBe("follow-up");
      expect(readme.replace(/\r\n/g, "\n")).toBe("fork pr main branch\n");
      expect(getBranchUpstream(result.worktree.worktreePath)).toBeNull();
      expect((await readPaseoWorktreeMetadata(result.worktree.worktreePath))?.baseRefName).toBe(
        "main",
      );
      expect(git(repoDir, "branch", "--list", "therainisme/main")).toBe("");
      expect(getGitConfigValue(repoDir, "remote.paseo-pr-526.url")).toBeNull();
      // Base branch pickers list remote-tracking refs; the fork's head is not one of them.
      expect(git(repoDir, "for-each-ref", "refs/remotes/paseo-pr-526")).toBe("");
    });

    test("branches off a fork pull request in a clone that calls the base repository upstream", async () => {
      const { tempDir, repoDir, headRemoteDir, paseoHome } = createForkGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      execFileSync("git", ["remote", "rename", "origin", "upstream"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      const github = {
        ...createGitHubServiceStub(),
        getPullRequestCheckoutTarget: async () => ({
          number: 526,
          baseRefName: "main",
          headRefName: "main",
          headOwnerLogin: "therainisme",
          headRepositorySshUrl: headRemoteDir,
          headRepositoryUrl: headRemoteDir,
          isCrossRepository: true,
          // As the GitHub service lists them: origin first, then upstream.
          checkoutRefs: [
            { remoteName: "origin", remoteRef: "refs/pull/526/head" },
            { remoteName: "upstream", remoteRef: "refs/pull/526/head" },
          ],
        }),
      };

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          action: "branch-off",
          checkoutSource: { kind: "change_request", forge: "github", number: 526 },
          branchName: "follow-up",
          paseoHome,
        },
        createCoreDeps({ github }),
      );

      // The base comes from the remote that served the pull request.
      expect(result.intent).toEqual({
        kind: "branch-off",
        baseBranch: "refs/remotes/upstream/main",
        startPoint: "refs/paseo/change-requests/526",
        branchName: "follow-up",
      });
      expect(result.worktree.comparisonBaseRef).toBe("refs/remotes/upstream/main");
    });

    test("creates the agent-create worktree input shape", async () => {
      const { tempDir, repoDir, paseoHome } = createGitRepo();
      cleanupPaths.push(tempDir);

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          worktreeSlug: "agent-worktree",
          paseoHome,
        },
        createCoreDeps(),
      );

      expect(result.intent).toEqual({
        kind: "branch-off",
        baseBranch: "main",
        branchName: "agent-worktree",
      });
      expect(result.worktree.branchName).toBe("agent-worktree");
    });

    test("creates a suffixed branch-off worktree for the same slug", async () => {
      const { tempDir, repoDir, paseoHome } = createGitRepo();
      cleanupPaths.push(tempDir);
      const deps = createCoreDeps();

      const first = await createCoreWorktree(
        { cwd: repoDir, worktreeSlug: "reused-worktree", paseoHome },
        deps,
      );
      const second = await createCoreWorktree(
        { cwd: repoDir, worktreeSlug: "reused-worktree", paseoHome },
        deps,
      );

      expect(first.created).toBe(true);
      expect(second.created).toBe(true);
      expect(path.basename(second.worktree.worktreePath)).toBe("reused-worktree-1");
      expect(second.worktree.branchName).toBe("reused-worktree-1");
    });

    test("creates a suffixed GitHub PR worktree for the resolved slug", async () => {
      const { tempDir, repoDir, paseoHome } = createGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      const deps = createCoreDeps();
      const input = {
        cwd: repoDir,
        githubPrNumber: 123,
        refName: "feature/review-pr",
        paseoHome,
      };

      const first = await createCoreWorktree(input, deps);
      const second = await createCoreWorktree(input, deps);

      expect(first.created).toBe(true);
      expect(second.created).toBe(true);
      expect(path.basename(second.worktree.worktreePath)).toBe("feature-review-pr-1");
      expect(second.worktree.branchName).toBe("feature/review-pr-1");
    });

    test("uses an injectable ForgeService dependency for missing PR head refs", async () => {
      const { tempDir, repoDir, paseoHome } = createGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      const headRefLookups: Array<{ cwd: string; number: number }> = [];
      const github: ForgeService = {
        ...createGitHubServiceStub(),
        // No head ref on the checkout target forces the service lookup below.
        getPullRequestCheckoutTarget: async ({ number }) => ({
          number,
          baseRefName: "main",
          headRefName: "",
          headOwnerLogin: null,
          headRepositorySshUrl: null,
          headRepositoryUrl: null,
          isCrossRepository: false,
        }),
        getPullRequestHeadRef: async ({ cwd, number }) => {
          headRefLookups.push({ cwd, number });
          return "feature/from-service";
        },
      };

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          worktreeSlug: "stubbed-github",
          githubPrNumber: 123,
          paseoHome,
        },
        createCoreDeps({ github }),
      );

      expect(headRefLookups).toEqual([{ cwd: repoDir, number: 123 }]);
      expect(result.intent).toEqual({
        kind: "checkout-change-request",
        forge: "github",
        changeRequestNumber: 123,
        headRef: "feature/from-service",
        baseRefName: "main",
        checkoutRefs: [{ remoteName: "origin", remoteRef: "refs/pull/123/head" }],
        trackOriginHead: true,
      });
      expect(result.worktree.branchName).toBe("feature/from-service");
    });
  });
});
