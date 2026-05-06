import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, afterEach, vi } from "vitest";

import type { GitHubService } from "../services/github-service.js";
import { UnknownBranchError } from "../utils/worktree.js";
import {
  createWorktreeCore as createCoreWorktree,
  resolveWorktreeRepoRoot,
} from "./worktree-core.js";

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
  execSync(`mkdir -p ${JSON.stringify(repoDir)}`);
  execSync("git init -b main", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  execSync("git add README.md", { cwd: repoDir, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: repoDir, stdio: "pipe" });
  return { tempDir, repoDir, paseoHome };
}

function createGitRepoWithDevBranch(): { tempDir: string; repoDir: string; paseoHome: string } {
  const { tempDir, repoDir, paseoHome } = createGitRepo();
  execSync("git checkout -b dev", { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "dev branch\n");
  execSync("git add README.md", { cwd: repoDir, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'dev branch'", {
    cwd: repoDir,
    stdio: "pipe",
  });
  execSync("git checkout main", { cwd: repoDir, stdio: "pipe" });
  return { tempDir, repoDir, paseoHome };
}

function createGitHubPrRemoteRepo(): { tempDir: string; repoDir: string; paseoHome: string } {
  const { tempDir, repoDir, paseoHome } = createGitRepo();
  const featureBranch = "feature/review-pr";
  execSync(`git checkout -b ${JSON.stringify(featureBranch)}`, { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "review branch\n");
  execSync("git add README.md", { cwd: repoDir, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'review branch'", {
    cwd: repoDir,
    stdio: "pipe",
  });
  const featureSha = execSync("git rev-parse HEAD", { cwd: repoDir, stdio: "pipe" })
    .toString()
    .trim();
  execSync("git checkout main", { cwd: repoDir, stdio: "pipe" });
  execSync(`git branch -D ${JSON.stringify(featureBranch)}`, { cwd: repoDir, stdio: "pipe" });

  const remoteDir = path.join(tempDir, "remote.git");
  execSync(`git clone --bare ${JSON.stringify(repoDir)} ${JSON.stringify(remoteDir)}`, {
    stdio: "pipe",
  });
  execSync(
    `git --git-dir=${JSON.stringify(remoteDir)} update-ref refs/pull/123/head ${featureSha}`,
    { stdio: "pipe" },
  );
  execSync(`git remote add origin ${JSON.stringify(remoteDir)}`, { cwd: repoDir, stdio: "pipe" });
  execSync("git fetch origin", { cwd: repoDir, stdio: "pipe" });

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

  execSync(`git clone --bare ${JSON.stringify(repoDir)} ${JSON.stringify(baseRemoteDir)}`, {
    stdio: "pipe",
  });
  execSync(`git clone --bare ${JSON.stringify(repoDir)} ${JSON.stringify(headRemoteDir)}`, {
    stdio: "pipe",
  });
  execSync(`git remote add origin ${JSON.stringify(baseRemoteDir)}`, {
    cwd: repoDir,
    stdio: "pipe",
  });

  execSync(`git clone ${JSON.stringify(headRemoteDir)} ${JSON.stringify(headCloneDir)}`, {
    stdio: "pipe",
  });
  execSync("git config user.email 'test@test.com'", { cwd: headCloneDir, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: headCloneDir, stdio: "pipe" });
  writeFileSync(path.join(headCloneDir, "README.md"), "fork pr main branch\n");
  execSync("git add README.md", { cwd: headCloneDir, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'fork pr main branch'", {
    cwd: headCloneDir,
    stdio: "pipe",
  });
  const prHead = execSync("git rev-parse HEAD", { cwd: headCloneDir, stdio: "pipe" })
    .toString()
    .trim();
  execSync("git push origin main", { cwd: headCloneDir, stdio: "pipe" });
  execSync(
    `git --git-dir=${JSON.stringify(baseRemoteDir)} fetch ${JSON.stringify(headRemoteDir)} main`,
    { stdio: "pipe" },
  );
  execSync(
    `git --git-dir=${JSON.stringify(baseRemoteDir)} update-ref refs/pull/526/head ${prHead}`,
    { stdio: "pipe" },
  );
  execSync("git fetch origin", { cwd: repoDir, stdio: "pipe" });

  return { tempDir, repoDir, headRemoteDir, paseoHome };
}

describe.skipIf(process.platform === "win32")("createWorktreeCore", () => {
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
    const devTip = execSync("git rev-parse dev", { cwd: repoDir, stdio: "pipe" }).toString().trim();

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

    const mergeBase = execSync(`git merge-base HEAD ${JSON.stringify(devTip)}`, {
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

    const branch = execSync("git branch --show-current", {
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

    const sourceBranch = execSync("git branch --show-current", { cwd: repoDir, stdio: "pipe" })
      .toString()
      .trim();
    const worktreeBranch = execSync("git branch --show-current", {
      cwd: result.worktree.worktreePath,
      stdio: "pipe",
    })
      .toString()
      .trim();
    const readme = readFileSync(path.join(result.worktree.worktreePath, "README.md"), "utf8");
    writeFileSync(path.join(result.worktree.worktreePath, "FOLLOWUP.md"), "maintainer edit\n");
    execSync("git add FOLLOWUP.md", { cwd: result.worktree.worktreePath, stdio: "pipe" });
    execSync("git -c commit.gpgsign=false commit -m 'maintainer edit'", {
      cwd: result.worktree.worktreePath,
      stdio: "pipe",
    });
    const pushDryRun = execSync("git push --dry-run 2>&1", {
      cwd: result.worktree.worktreePath,
      stdio: "pipe",
    }).toString();

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
    expect(readme).toBe("fork pr main branch\n");
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
      execSync("git config --get remote.paseo-pr-526.push", {
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

describe("resolveWorktreeRepoRoot", () => {
  test("resolves repository roots through the workspace git service", async () => {
    const workspaceGitService = {
      resolveRepoRoot: vi.fn().mockResolvedValue("/tmp/main-repo"),
    };

    await expect(
      resolveWorktreeRepoRoot(
        { cwd: "/tmp/main-repo/worktrees/feature", paseoHome: "/tmp/paseo-home" },
        workspaceGitService,
      ),
    ).resolves.toBe("/tmp/main-repo");

    expect(workspaceGitService.resolveRepoRoot).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.resolveRepoRoot).toHaveBeenCalledWith(
      "/tmp/main-repo/worktrees/feature",
    );
  });
});
