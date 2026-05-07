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
import type { GitHubService } from "../services/github-service.js";
import { UnknownBranchError } from "../utils/worktree.js";
import { createWorktreeCore as createCoreWorktree } from "./worktree-core.js";
import { isPlatform } from "../test-utils/platform.js";

function createGitHubServiceStub(): GitHubService {
  return {
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
    getPullRequestHeadRef: async ({ number }) => `pr-${number}`,
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

function createCoreDeps(options?: { github?: GitHubService }) {
  return {
    github: options?.github ?? createGitHubServiceStub(),
    workspaceGitService: {
      resolveRepoRoot: async (cwd: string) => cwd,
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
        kind: "checkout-github-pr",
        githubPrNumber: 123,
        headRef: "feature/review-pr",
        baseRefName: "main",
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
        kind: "checkout-github-pr",
        githubPrNumber: 123,
        headRef: "pr-123",
        baseRefName: "main",
      });
      expect(result.worktree.branchName).toBe("pr-123");
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
      writeFileSync(path.join(result.worktree.worktreePath, "FOLLOWUP.md"), "maintainer edit\n");
      execFileSync("git", ["add", "FOLLOWUP.md"], {
        cwd: result.worktree.worktreePath,
        stdio: "pipe",
      });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "maintainer edit"], {
        cwd: result.worktree.worktreePath,
        stdio: "pipe",
      });
      const pushDryRunResult = spawnSync("git", ["push", "--dry-run"], {
        cwd: result.worktree.worktreePath,
        encoding: "utf8",
      });
      const pushDryRun = `${pushDryRunResult.stdout}${pushDryRunResult.stderr}`;

      expect(sourceBranch).toBe("main");
      expect(result.intent).toEqual({
        kind: "checkout-github-pr",
        githubPrNumber: 526,
        headRef: "main",
        baseRefName: "main",
        localBranchName: "therainisme/main",
        pushRemoteUrl: headRemoteDir,
      });
      expect(result.worktree.branchName).toBe("therainisme/main");
      expect(path.basename(result.worktree.worktreePath)).toBe("therainisme-main");
      expect(worktreeBranch).toBe("therainisme/main");
      expect(readme.replace(/\r\n/g, "\n")).toBe("fork pr main branch\n");
      expect(pushDryRun).toContain("HEAD -> main");
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
      expect(
        execFileSync("git", ["config", "--get", "remote.paseo-pr-526.push"], {
          cwd: second.worktree.worktreePath,
          stdio: "pipe",
        })
          .toString()
          .trim(),
      ).toBe("HEAD:refs/heads/main");
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

    test("uses an injectable GitHubService dependency for missing PR head refs", async () => {
      const { tempDir, repoDir, paseoHome } = createGitHubPrRemoteRepo();
      cleanupPaths.push(tempDir);
      const headRefLookups: Array<{ cwd: string; number: number }> = [];
      const github: GitHubService = {
        ...createGitHubServiceStub(),
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
        kind: "checkout-github-pr",
        githubPrNumber: 123,
        headRef: "feature/from-service",
        baseRefName: "main",
      });
      expect(result.worktree.branchName).toBe("feature/from-service");
    });
  });
});
