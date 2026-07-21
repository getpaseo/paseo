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
import { createGitLabService } from "../services/gitlab-service.js";
import {
  getCheckoutSnapshotFacts,
  getCheckoutStatus,
  pushCurrentBranch,
} from "../utils/checkout-git.js";
import {
  getPaseoWorktreeMetadataPath,
  readPaseoWorktreeMetadata,
} from "../utils/worktree-metadata.js";
import { UnknownBranchError } from "../utils/worktree.js";
import { createWorktreeCore as createCoreWorktree } from "./worktree-core.js";
import { isPlatform } from "../test-utils/platform.js";

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
}) {
  return {
    github: options?.github ?? createGitHubServiceStub(),
    workspaceGitService: {
      resolveRepoRoot: async (cwd: string) => cwd,
      resolveForge: async () =>
        options?.forge
          ? {
              forge: options.forge.forge,
              host: `${options.forge.forge}.example.com`,
              service: options.forge.service,
            }
          : null,
    },
    resolveDefaultBranch: async () => "main",
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
          runSetup: false,
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
          runSetup: false,
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
          runSetup: false,
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
          runSetup: false,
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

    test("uses the PR head ref as the default slug when no slug is supplied", async () => {
      const { tempDir, repoDir, paseoHome } = createGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          githubPrNumber: 123,
          refName: "feature/review-pr",
          paseoHome,
          runSetup: false,
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
          runSetup: false,
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
          runSetup: false,
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
          runSetup: false,
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

    test("checks out an explicit GitHub PR target", async () => {
      const { tempDir, repoDir, paseoHome } = createGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          action: "checkout",
          githubPrNumber: 123,
          paseoHome,
          runSetup: false,
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
          runSetup: false,
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
          runSetup: false,
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
          runSetup: false,
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
          runSetup: false,
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
          runSetup: false,
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
          runSetup: false,
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
      const metadata = readPaseoWorktreeMetadata(second.worktree.worktreePath);
      const facts = await getCheckoutSnapshotFacts(second.worktree.worktreePath, { paseoHome });

      expect(second.worktree.branchName).toBe("feature/gitlab-mr-1");
      expect(pushRemote).toBeNull();
      expect(pushRefspec).toBeNull();
      expect(pushRemoteUrl).toBeNull();
      expect(metadata?.changeRequestLookupTarget).toEqual({
        headRef: "feature/gitlab-mr",
        changeRequestNumber: 14,
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
          runSetup: false,
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
          runSetup: false,
        },
        createCoreDeps({ github }),
      );
      const readme = readFileSync(path.join(result.worktree.worktreePath, "README.md"), "utf8");

      expect(result.worktree.branchName).toBe("daemon-shutdown-diagnostics");
      expect(readme.replace(/\r\n/g, "\n")).toBe("same repo pr branch\n");
      expect(getBranchUpstream(result.worktree.worktreePath)).toBeNull();
    });

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
          runSetup: false,
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
          runSetup: false,
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

    test("derives a deduped PR lookup target from git config when metadata has no target", async () => {
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
          runSetup: false,
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
          runSetup: false,
        },
        createCoreDeps({ github }),
      );
      writeFileSync(
        getPaseoWorktreeMetadataPath(second.worktree.worktreePath),
        `${JSON.stringify({ version: 1, baseRefName: "main" }, null, 2)}\n`,
        "utf8",
      );

      const facts = await getCheckoutSnapshotFacts(second.worktree.worktreePath, { paseoHome });

      expect(second.worktree.branchName).toBe("daemon-shutdown-diagnostics-1");
      expect(facts).toMatchObject({
        isGit: true,
        currentBranch: "daemon-shutdown-diagnostics-1",
        pullRequestLookupTarget: { headRef: "daemon-shutdown-diagnostics" },
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
          runSetup: false,
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
          runSetup: false,
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
          runSetup: false,
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
          runSetup: false,
        },
        createCoreDeps({ github }),
      );

      expect(first.worktree.branchName).toBe("therainisme/main");
      expect(second.worktree.branchName).toBe("therainisme/main-1");
      expect(getBranchUpstream(first.worktree.worktreePath)).toBe("paseo-pr-526/main");
      expect(getBranchUpstream(second.worktree.worktreePath)).toBe("paseo-pr-526/main");
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
            runSetup: false,
          },
          createCoreDeps(),
        ),
      ).rejects.toBeInstanceOf(UnknownBranchError);
    });

    test("creates the agent-create worktree input shape", async () => {
      const { tempDir, repoDir, paseoHome } = createGitRepo();
      cleanupPaths.push(tempDir);

      const result = await createCoreWorktree(
        {
          cwd: repoDir,
          worktreeSlug: "agent-worktree",
          paseoHome,
          runSetup: false,
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

    // POSIX-only: Windows git worktree paths need separate canonicalization coverage.
    test("reuses an existing branch-off worktree for the same slug", async () => {
      const { tempDir, repoDir, paseoHome } = createGitRepo();
      cleanupPaths.push(tempDir);
      const deps = createCoreDeps();

      const first = await createCoreWorktree(
        { cwd: repoDir, worktreeSlug: "reused-worktree", paseoHome, runSetup: false },
        deps,
      );
      const second = await createCoreWorktree(
        { cwd: repoDir, worktreeSlug: "reused-worktree", paseoHome, runSetup: false },
        deps,
      );

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.worktree).toEqual(first.worktree);
    });

    // POSIX-only: Windows git worktree paths need separate canonicalization coverage.
    test("reuses an existing GitHub PR worktree for the resolved slug", async () => {
      const { tempDir, repoDir, paseoHome } = createGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      const deps = createCoreDeps();
      const input = {
        cwd: repoDir,
        githubPrNumber: 123,
        refName: "feature/review-pr",
        paseoHome,
        runSetup: false,
      };

      const first = await createCoreWorktree(input, deps);
      const second = await createCoreWorktree(input, deps);

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.worktree).toEqual(first.worktree);
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
          runSetup: false,
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
