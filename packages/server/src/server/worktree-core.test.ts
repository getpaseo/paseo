import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

function createCoreDeps(options?: {
  github?: GitHubService;
  generateBranchName?: (seed: string | undefined) => string;
}) {
  return {
    github: options?.github ?? createGitHubServiceStub(),
    workspaceGitService: {
      resolveRepoRoot: async (cwd: string) => cwd,
    },
    resolveDefaultBranch: async () => "main",
    generateBranchName: options?.generateBranchName ?? ((seed) => seed ?? "generated-worktree"),
  };
}

function findDirectCreateWorktreeCallSites(serverSrc: string): string[] {
  const matches: string[] = [];

  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = path
        .relative(serverSrc, absolutePath)
        .split(path.sep)
        .join(path.posix.sep);

      if (relativePath === "utils/worktree.ts" || relativePath.endsWith(".test.ts")) {
        continue;
      }

      // Keep this literal in the test file so the invariant proves tests are allowed to inspect createWorktree(.
      if (/createWorktree\(/.test(readFileSync(absolutePath, "utf8"))) {
        matches.push(relativePath);
      }
    }
  }

  walk(serverSrc);
  return matches.sort();
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
        attachments: [],
        paseoHome,
        runSetup: false,
      },
      createCoreDeps(),
    );

    expect(result.intent).toEqual({
      kind: "branch-off",
      baseBranch: "main",
      newBranchName: "legacy-rpc",
    });
    expect(result.created).toBe(true);
    expect(result.worktree.branchName).toBe("legacy-rpc");
    expect(existsSync(result.worktree.worktreePath)).toBe(true);
  });

  test("checks out the legacy RPC GitHub PR attachment branch", async () => {
    const { tempDir, repoDir, paseoHome } = createGitHubPrRemoteRepo();
    cleanupPaths.push(tempDir);

    const result = await createCoreWorktree(
      {
        cwd: repoDir,
        worktreeSlug: "review-pr-123",
        paseoHome,
        runSetup: false,
        attachments: [
          {
            type: "github_pr",
            mimeType: "application/github-pr",
            number: 123,
            title: "Review branch",
            url: "https://github.com/getpaseo/paseo/pull/123",
            baseRefName: "main",
            headRefName: "feature/review-pr",
          },
        ],
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
        paseoHome,
        runSetup: false,
        attachments: [
          {
            type: "github_pr",
            mimeType: "application/github-pr",
            number: 123,
            title: "Review branch",
            url: "https://github.com/getpaseo/paseo/pull/123",
            baseRefName: "main",
            headRefName: "feature/review-pr",
          },
        ],
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
      newBranchName: "mcp-standalone",
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
      newBranchName: "from-dev",
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
      newBranchName: "agent-worktree",
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
      paseoHome,
      runSetup: false,
      attachments: [
        {
          type: "github_pr" as const,
          mimeType: "application/github-pr" as const,
          number: 123,
          title: "Review branch",
          url: "https://github.com/getpaseo/paseo/pull/123",
          baseRefName: "main",
          headRefName: "feature/review-pr",
        },
      ],
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
        paseoHome,
        runSetup: false,
        attachments: [
          {
            type: "github_pr",
            mimeType: "application/github-pr",
            number: 123,
            title: "Review branch",
            url: "https://github.com/getpaseo/paseo/pull/123",
            baseRefName: "main",
          },
        ],
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

  test("keeps direct createWorktree calls isolated to the core layer", () => {
    const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    expect(findDirectCreateWorktreeCallSites(serverSrc)).toEqual(["server/worktree-core.ts"]);
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
