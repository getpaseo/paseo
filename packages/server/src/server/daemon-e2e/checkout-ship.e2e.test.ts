import { beforeEach, afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, realpathSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execFileSync, execSync, spawnSync } from "child_process";

import {
  createDaemonTestContext,
  createTempGithubRepoName,
  type DaemonTestContext,
} from "../test-utils/index.js";
import {
  createWorktree as createWorktreePrimitive,
  type CreateWorktreeOptions,
  type WorktreeConfig,
} from "../../utils/worktree.js";

interface LegacyCreateWorktreeTestOptions {
  branchName: string;
  cwd: string;
  baseBranch: string;
  worktreeSlug: string;
  runSetup?: boolean;
  paseoHome?: string;
}

function createLegacyWorktreeForTest(
  options: CreateWorktreeOptions | LegacyCreateWorktreeTestOptions,
): Promise<WorktreeConfig> {
  if ("source" in options) {
    return createWorktreePrimitive(options);
  }

  return createWorktreePrimitive({
    cwd: options.cwd,
    worktreeSlug: options.worktreeSlug,
    source: {
      kind: "branch-off",
      baseBranch: options.baseBranch,
      branchName: options.branchName,
    },
    runSetup: options.runSetup ?? true,
    paseoHome: options.paseoHome,
  });
}

const CODEX_TEST_MODEL = "gpt-5.4-mini";
const CODEX_TEST_THINKING_OPTION_ID = "low";
// Keep this checkout-ship-specific: broad real/e2e flags must never enable repository mutation.
const CHECKOUT_SHIP_LIVE_GITHUB_E2E = "PASEO_CHECKOUT_SHIP_LIVE_GITHUB_E2E";
const GITHUB_HOST = "github.com";
const GITHUB_CLI_TIMEOUT_MS = 15_000;
const GITHUB_AUTH_STATUS_ARGS = [
  "auth",
  "status",
  "--active",
  "--hostname",
  GITHUB_HOST,
  "--json",
  "hosts",
];

interface GitHubCliAuthStatus {
  authenticated: boolean;
  canDeleteRepositories: boolean;
  activeLogin: string | null;
}

interface GitHubAuthIdentity {
  login: string;
  token: string;
}

interface GitHubCliCommandResult {
  succeeded: boolean;
  output: string;
}

type GitHubCliCommandRunner = (
  args: string[],
  identity: GitHubAuthIdentity,
) => GitHubCliCommandResult;
type GitHubAuthIdentityReader = () => GitHubAuthIdentity;

function tmpCwd(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

function createGitHubCliSyncOptions(
  token?: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): { env: NodeJS.ProcessEnv; stdio: "pipe"; timeout: number } {
  return {
    env: {
      ...baseEnvironment,
      GH_HOST: GITHUB_HOST,
      ...(token !== undefined ? { GH_TOKEN: token } : {}),
    },
    stdio: "pipe",
    timeout: GITHUB_CLI_TIMEOUT_MS,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseActiveGitHubCliAuthStatus(output: string): GitHubCliAuthStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { authenticated: false, canDeleteRepositories: false, activeLogin: null };
  }

  if (!isRecord(parsed) || !isRecord(parsed.hosts)) {
    return { authenticated: false, canDeleteRepositories: false, activeLogin: null };
  }

  const accounts = parsed.hosts[GITHUB_HOST];
  if (!Array.isArray(accounts)) {
    return { authenticated: false, canDeleteRepositories: false, activeLogin: null };
  }

  const activeAccounts = accounts.filter(
    (account) => isRecord(account) && account.active === true && account.host === GITHUB_HOST,
  );
  if (activeAccounts.length !== 1) {
    return { authenticated: false, canDeleteRepositories: false, activeLogin: null };
  }

  const activeAccount = activeAccounts[0];
  const activeLogin =
    typeof activeAccount.login === "string" && activeAccount.login.length > 0
      ? activeAccount.login
      : null;
  const scopes =
    typeof activeAccount.scopes === "string"
      ? new Set(activeAccount.scopes.split(",").map((scope) => scope.trim()))
      : new Set<string>();

  return {
    authenticated: activeAccount.state === "success" && activeLogin !== null,
    canDeleteRepositories: scopes.has("delete_repo"),
    activeLogin,
  };
}

function getGitHubCliAuthStatus(): GitHubCliAuthStatus {
  const result = spawnSync("gh", GITHUB_AUTH_STATUS_ARGS, {
    ...createGitHubCliSyncOptions(),
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    return { authenticated: false, canDeleteRepositories: false, activeLogin: null };
  }

  return parseActiveGitHubCliAuthStatus(result.stdout);
}

function executeGitHubCli(args: string[], token?: string): string {
  return execFileSync("gh", args, createGitHubCliSyncOptions(token)).toString().trim();
}

function readGitHubAuthIdentity(authStatus = getGitHubCliAuthStatus()): GitHubAuthIdentity {
  if (
    !authStatus.authenticated ||
    !authStatus.canDeleteRepositories ||
    authStatus.activeLogin === null
  ) {
    throw new Error(
      `The active ${GITHUB_HOST} account is not authenticated with delete_repo cleanup scope`,
    );
  }

  const token = executeGitHubCli(["auth", "token", "--hostname", GITHUB_HOST]);
  const tokenLogin = executeGitHubCli(
    ["api", "--hostname", GITHUB_HOST, "user", "--jq", ".login"],
    token,
  );

  if (tokenLogin !== authStatus.activeLogin) {
    throw new Error(
      `The active ${GITHUB_HOST} account changed while binding its cleanup token identity`,
    );
  }

  return { login: tokenLogin, token };
}

function shouldRunCheckoutShipLiveGitHubMutation(
  explicitOptIn: string | undefined,
  authStatus: GitHubCliAuthStatus,
): boolean {
  return explicitOptIn === "1" && authStatus.authenticated && authStatus.canDeleteRepositories;
}

function assertCheckoutShipLiveGitHubMutationEnabled(): GitHubAuthIdentity {
  const explicitOptIn = process.env[CHECKOUT_SHIP_LIVE_GITHUB_E2E];
  const authStatus = getGitHubCliAuthStatus();

  if (shouldRunCheckoutShipLiveGitHubMutation(explicitOptIn, authStatus)) {
    return readGitHubAuthIdentity(authStatus);
  }

  const missingRequirements = [
    explicitOptIn === "1" ? null : `${CHECKOUT_SHIP_LIVE_GITHUB_E2E}=1`,
    authStatus.authenticated ? null : `an authenticated active ${GITHUB_HOST} account`,
    authStatus.canDeleteRepositories ? null : "the delete_repo scope required for cleanup",
  ].filter((requirement): requirement is string => requirement !== null);

  throw new Error(
    `Checkout ship live GitHub mutation is disabled; missing ${missingRequirements.join(
      ", ",
    )}. No remote repository was created.`,
  );
}

const testWithExplicitLiveGitHubOptIn =
  process.env[CHECKOUT_SHIP_LIVE_GITHUB_E2E] === "1" ? test : test.skip;

function initGitRepo(repoDir: string): void {
  execSync("git init -b main", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.email 'paseo-test@example.com'", {
    cwd: repoDir,
    stdio: "pipe",
  });
  execSync("git config user.name 'Paseo Test'", {
    cwd: repoDir,
    stdio: "pipe",
  });
  writeFileSync(path.join(repoDir, "README.md"), "init\n");
  execSync("git add README.md", { cwd: repoDir, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'Initial commit'", {
    cwd: repoDir,
    stdio: "pipe",
  });
}

function createPrivateRepo(repoName: string, identity: GitHubAuthIdentity): void {
  executeGitHubCli(
    [
      "api",
      "--hostname",
      GITHUB_HOST,
      "-X",
      "POST",
      "user/repos",
      "-f",
      `name=${repoName}`,
      "-f",
      "private=true",
    ],
    identity.token,
  );
}

function formatCommandError(error: unknown): string {
  if (error && typeof error === "object") {
    const commandError = error as {
      code?: string;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      message?: string;
    };
    if (commandError.code === "ETIMEDOUT") {
      return `GitHub CLI command timed out after ${GITHUB_CLI_TIMEOUT_MS}ms`;
    }
    const output = [commandError.stderr, commandError.stdout]
      .map((value) => value?.toString().trim())
      .filter(Boolean)
      .join("\n");

    return output || commandError.message || String(error);
  }

  return String(error);
}

function runGitHubCli(args: string[], identity: GitHubAuthIdentity): GitHubCliCommandResult {
  try {
    const output = executeGitHubCli(args, identity.token);
    return { succeeded: true, output };
  } catch (error) {
    return { succeeded: false, output: formatCommandError(error) };
  }
}

function assertSameGitHubAuthIdentity(
  expected: GitHubAuthIdentity,
  actual: GitHubAuthIdentity,
  phase: "before" | "after",
): void {
  if (expected.login !== actual.login || expected.token !== actual.token) {
    throw new Error(
      `The active ${GITHUB_HOST} account or token changed ${phase} exact-repository cleanup`,
    );
  }
}

function deleteRepoAndVerifyAbsent(
  fullName: string | null,
  expectedIdentity: GitHubAuthIdentity,
  runGitHubCommand: GitHubCliCommandRunner = runGitHubCli,
  readActiveIdentity: GitHubAuthIdentityReader = readGitHubAuthIdentity,
): void {
  if (!fullName) {
    return;
  }

  let identityBefore: GitHubAuthIdentity;
  try {
    identityBefore = readActiveIdentity();
  } catch (error) {
    throw new Error(
      `Failed to start cleanup of temporary GitHub repo ${fullName}: the active ${GITHUB_HOST} identity could not be proved`,
      { cause: error },
    );
  }
  assertSameGitHubAuthIdentity(expectedIdentity, identityBefore, "before");

  const exactRepoEndpoint = `repos/${fullName}`;
  const accessResult = runGitHubCommand(
    ["api", "--hostname", GITHUB_HOST, exactRepoEndpoint],
    expectedIdentity,
  );
  if (!accessResult.succeeded) {
    throw new Error(
      `Failed to start cleanup of temporary GitHub repo ${fullName}: the retained active identity could not read the exact repo before deletion: ${accessResult.output}`,
    );
  }

  const deleteResult = runGitHubCommand(
    ["api", "--hostname", GITHUB_HOST, "--method", "DELETE", exactRepoEndpoint],
    expectedIdentity,
  );
  const readbackResult = runGitHubCommand(
    ["api", "--hostname", GITHUB_HOST, exactRepoEndpoint],
    expectedIdentity,
  );

  let identityAfter: GitHubAuthIdentity;
  try {
    identityAfter = readActiveIdentity();
  } catch (error) {
    throw new Error(
      `Failed to prove cleanup of temporary GitHub repo ${fullName}: the active ${GITHUB_HOST} identity was unavailable after the exact-repository readback`,
      { cause: error },
    );
  }
  assertSameGitHubAuthIdentity(expectedIdentity, identityAfter, "after");

  const deleteSummary = deleteResult.succeeded
    ? "the exact GitHub API delete reported success"
    : `the exact GitHub API delete failed: ${deleteResult.output}`;
  const exactRepoIsAbsent =
    !readbackResult.succeeded && /\bHTTP 404\b/i.test(readbackResult.output);

  if (!deleteResult.succeeded) {
    throw new Error(
      `Failed to clean up temporary GitHub repo ${fullName}: deletion did not succeed, so the readback cannot certify absence; ${deleteSummary}; readback: ${readbackResult.output}.`,
    );
  }

  if (readbackResult.succeeded) {
    throw new Error(
      `Failed to clean up temporary GitHub repo ${fullName}: the exact repo remains readable after cleanup; ${deleteSummary}.`,
    );
  }

  if (exactRepoIsAbsent) {
    return;
  }

  throw new Error(
    `Failed to verify cleanup of temporary GitHub repo ${fullName}: the exact repo could not be read back to confirm HTTP 404; ${deleteSummary}; readback failed: ${readbackResult.output}.`,
  );
}

function throwCheckoutShipErrors(testError: unknown, repoCleanupError: unknown): void {
  if (testError && repoCleanupError) {
    throw new AggregateError(
      [testError, repoCleanupError],
      "Checkout ship live GitHub test failed and its temporary repository cleanup also failed",
    );
  }
  if (repoCleanupError) {
    throw repoCleanupError;
  }
  if (testError) {
    throw testError;
  }
}

describe("checkout ship live GitHub mutation safety", () => {
  const fixtureToken = "fixture-token-not-a-secret";
  const fixtureIdentity: GitHubAuthIdentity = {
    login: "octocat",
    token: fixtureToken,
  };
  const readFixtureIdentity = (): GitHubAuthIdentity => ({ ...fixtureIdentity });

  test("logged-in gh alone and missing auth or cleanup scope cannot enable mutation", () => {
    const fullyAuthorizedGh: GitHubCliAuthStatus = {
      authenticated: true,
      canDeleteRepositories: true,
      activeLogin: "octocat",
    };

    expect(shouldRunCheckoutShipLiveGitHubMutation(undefined, fullyAuthorizedGh)).toBe(false);
    expect(shouldRunCheckoutShipLiveGitHubMutation("0", fullyAuthorizedGh)).toBe(false);
    expect(shouldRunCheckoutShipLiveGitHubMutation("true", fullyAuthorizedGh)).toBe(false);
    expect(shouldRunCheckoutShipLiveGitHubMutation("1", fullyAuthorizedGh)).toBe(true);
    expect(
      shouldRunCheckoutShipLiveGitHubMutation("1", {
        ...fullyAuthorizedGh,
        authenticated: false,
      }),
    ).toBe(false);
    expect(
      shouldRunCheckoutShipLiveGitHubMutation("1", {
        ...fullyAuthorizedGh,
        canDeleteRepositories: false,
      }),
    ).toBe(false);
  });

  test("inactive scoped accounts cannot satisfy the active-account cleanup scope", () => {
    const authStatus = parseActiveGitHubCliAuthStatus(
      JSON.stringify({
        hosts: {
          [GITHUB_HOST]: [
            {
              state: "success",
              active: false,
              host: GITHUB_HOST,
              login: "inactive-scoped-account",
              scopes: "delete_repo, repo",
            },
            {
              state: "success",
              active: true,
              host: GITHUB_HOST,
              login: "active-account",
              scopes: "repo",
            },
          ],
        },
      }),
    );

    expect(GITHUB_AUTH_STATUS_ARGS).toEqual([
      "auth",
      "status",
      "--active",
      "--hostname",
      GITHUB_HOST,
      "--json",
      "hosts",
    ]);
    expect(authStatus).toEqual({
      authenticated: true,
      canDeleteRepositories: false,
      activeLogin: "active-account",
    });
  });

  test("GitHub CLI options override inherited GH_HOST and bound every command timeout", () => {
    const options = createGitHubCliSyncOptions(fixtureToken, {
      GH_HOST: "github.example.com",
    });

    expect(options.env.GH_HOST).toBe(GITHUB_HOST);
    expect(options.env.GH_TOKEN).toBe(fixtureToken);
    expect(options.timeout).toBe(GITHUB_CLI_TIMEOUT_MS);
  });

  test("successful deletion plus same-identity 404 certifies exact-repo cleanup", () => {
    const calls: string[][] = [];
    const runGitHubCommand: GitHubCliCommandRunner = (args) => {
      calls.push(args);
      if (args.includes("DELETE")) {
        return { succeeded: true, output: "" };
      }
      return calls.length === 1
        ? { succeeded: true, output: '{"full_name":"octocat/checkout-ship-test"}' }
        : { succeeded: false, output: "HTTP 404: Not Found" };
    };

    expect(() =>
      deleteRepoAndVerifyAbsent(
        "octocat/checkout-ship-test",
        fixtureIdentity,
        runGitHubCommand,
        readFixtureIdentity,
      ),
    ).not.toThrow();
    expect(calls).toEqual([
      ["api", "--hostname", GITHUB_HOST, "repos/octocat/checkout-ship-test"],
      ["api", "--hostname", GITHUB_HOST, "--method", "DELETE", "repos/octocat/checkout-ship-test"],
      ["api", "--hostname", GITHUB_HOST, "repos/octocat/checkout-ship-test"],
    ]);
  });

  test("failed deletion plus 404 is surfaced instead of certifying cleanup", () => {
    let apiCalls = 0;
    const runGitHubCommand: GitHubCliCommandRunner = (args) => {
      if (args.includes("DELETE")) {
        return { succeeded: false, output: "HTTP 403: delete_repo scope required" };
      }
      apiCalls += 1;
      return apiCalls === 1
        ? { succeeded: true, output: '{"full_name":"octocat/checkout-ship-test"}' }
        : { succeeded: false, output: "HTTP 404: Not Found" };
    };

    expect(() =>
      deleteRepoAndVerifyAbsent(
        "octocat/checkout-ship-test",
        fixtureIdentity,
        runGitHubCommand,
        readFixtureIdentity,
      ),
    ).toThrow(
      "Failed to clean up temporary GitHub repo octocat/checkout-ship-test: deletion did not succeed, so the readback cannot certify absence",
    );
  });

  test("404 with lost token access is an inconclusive hard cleanup failure", () => {
    let apiCalls = 0;
    const runGitHubCommand: GitHubCliCommandRunner = (args) => {
      if (args.includes("DELETE")) {
        return { succeeded: true, output: "" };
      }
      apiCalls += 1;
      return apiCalls === 1
        ? { succeeded: true, output: '{"full_name":"octocat/checkout-ship-test"}' }
        : { succeeded: false, output: "HTTP 404: Not Found" };
    };
    let identityReads = 0;
    const readActiveIdentity = (): GitHubAuthIdentity => {
      identityReads += 1;
      if (identityReads === 1) {
        return { ...fixtureIdentity };
      }
      throw new Error("active token lost access");
    };

    expect(() =>
      deleteRepoAndVerifyAbsent(
        "octocat/checkout-ship-test",
        fixtureIdentity,
        runGitHubCommand,
        readActiveIdentity,
      ),
    ).toThrow(
      "Failed to prove cleanup of temporary GitHub repo octocat/checkout-ship-test: the active github.com identity was unavailable after the exact-repository readback",
    );
  });

  test("GitHub CLI timeout is bounded and a timed-out delete cannot certify a 404", () => {
    let apiCalls = 0;
    const timeoutOutput = formatCommandError({ code: "ETIMEDOUT" });
    const runGitHubCommand: GitHubCliCommandRunner = (args) => {
      if (args.includes("DELETE")) {
        return { succeeded: false, output: timeoutOutput };
      }
      apiCalls += 1;
      return apiCalls === 1
        ? { succeeded: true, output: '{"full_name":"octocat/checkout-ship-test"}' }
        : { succeeded: false, output: "HTTP 404: Not Found" };
    };

    expect(timeoutOutput).toContain(`${GITHUB_CLI_TIMEOUT_MS}ms`);
    expect(() =>
      deleteRepoAndVerifyAbsent(
        "octocat/checkout-ship-test",
        fixtureIdentity,
        runGitHubCommand,
        readFixtureIdentity,
      ),
    ).toThrow("GitHub CLI command timed out");
  });

  test("test and cleanup failures are preserved in one AggregateError", () => {
    const testError = new Error("test failed");
    const cleanupError = new Error("cleanup failed");

    try {
      throwCheckoutShipErrors(testError, cleanupError);
      throw new Error("Expected throwCheckoutShipErrors to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([testError, cleanupError]);
    }
  });
});

describe("daemon checkout ship loop", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  testWithExplicitLiveGitHubOptIn(
    "runs the full checkout ship loop via checkout RPCs",
    async () => {
      const githubIdentity = assertCheckoutShipLiveGitHubMutationEnabled();

      const repoDir = tmpCwd("checkout-ship-");
      let repoFullName: string | null = null;
      let agentId: string | null = null;
      let testError: unknown;
      let repoCleanupError: unknown;

      try {
        initGitRepo(repoDir);

        const owner = githubIdentity.login;
        const repoName = createTempGithubRepoName("checkout-ship");
        repoFullName = `${owner}/${repoName}`;
        createPrivateRepo(repoName, githubIdentity);

        const token = encodeURIComponent(githubIdentity.token);
        execSync(
          `git remote add origin https://x-access-token:${token}@github.com/${repoFullName}.git`,
          {
            cwd: repoDir,
            stdio: "pipe",
          },
        );
        execSync("git push -u origin main", { cwd: repoDir, stdio: "pipe" });

        const worktree = await createLegacyWorktreeForTest({
          branchName: "ship-loop",
          cwd: repoDir,
          baseBranch: "main",
          worktreeSlug: "ship-loop",
          paseoHome: ctx.daemon.paseoHome,
        });

        const agent = await ctx.client.createAgent({
          provider: "codex",
          model: CODEX_TEST_MODEL,
          thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
          cwd: worktree.worktreePath,
          title: "Checkout Ship Loop",
        });
        agentId = agent.id;

        const status = await ctx.client.getCheckoutStatus(worktree.worktreePath);
        expect(status.isGit).toBe(true);
        expect(status.isPaseoOwnedWorktree).toBe(true);
        expect(realpathSync(status.repoRoot)).toBe(realpathSync(worktree.worktreePath));
        if (status.isGit) {
          expect(status.baseRef).toBe("main");
        }

        execSync("git branch -m ship-loop-ready", {
          cwd: worktree.worktreePath,
          stdio: "pipe",
        });

        const updatedStatus = await ctx.client.getCheckoutStatus(worktree.worktreePath);
        expect(updatedStatus.currentBranch).toBe("ship-loop-ready");

        const readmePath = path.join(worktree.worktreePath, "README.md");
        writeFileSync(readmePath, "init\nship loop update\n");

        const diffUncommitted = await ctx.client.getCheckoutDiff(worktree.worktreePath, {
          mode: "uncommitted",
        });
        expect(diffUncommitted.error).toBeNull();
        expect(diffUncommitted.files.length).toBeGreaterThan(0);

        const timelineBeforeCommit = ctx.daemon.daemon.agentManager.getTimeline(agent.id).length;
        const commitResult = await ctx.client.checkoutCommit(worktree.worktreePath, {
          addAll: true,
        });
        expect(commitResult.error).toBeNull();
        expect(commitResult.success).toBe(true);
        const timelineAfterCommit = ctx.daemon.daemon.agentManager.getTimeline(agent.id).length;
        expect(timelineAfterCommit).toBe(timelineBeforeCommit);

        const diffAfterCommit = await ctx.client.getCheckoutDiff(worktree.worktreePath, {
          mode: "uncommitted",
        });
        expect(diffAfterCommit.files.length).toBe(0);

        const baseDiff = await ctx.client.getCheckoutDiff(worktree.worktreePath, {
          mode: "base",
          baseRef: "main",
        });
        expect(baseDiff.files.length).toBeGreaterThan(0);

        const timelineBeforePr = ctx.daemon.daemon.agentManager.getTimeline(agent.id).length;
        const prCreate = await ctx.client.checkoutPrCreate(worktree.worktreePath, {
          baseRef: "main",
        });
        expect(prCreate.error).toBeNull();
        expect(prCreate.url).toContain(repoName);
        const timelineAfterPr = ctx.daemon.daemon.agentManager.getTimeline(agent.id).length;
        expect(timelineAfterPr).toBe(timelineBeforePr);

        const prStatus = await ctx.client.checkoutPrStatus(worktree.worktreePath);
        expect(prStatus.error).toBeNull();
        expect(prStatus.githubFeaturesEnabled).toBe(true);

        const mergeResult = await ctx.client.checkoutMerge(worktree.worktreePath, {
          baseRef: "main",
          strategy: "merge",
          requireCleanTarget: true,
        });
        expect(mergeResult.error).toBeNull();
        expect(mergeResult.success).toBe(true);

        const statusAfterMerge = await ctx.client.getCheckoutStatus(worktree.worktreePath);
        expect(statusAfterMerge.isGit).toBe(true);
        if (statusAfterMerge.isGit) {
          expect(statusAfterMerge.baseRef).toBe("main");
          expect(statusAfterMerge.aheadBehind?.ahead ?? 0).toBe(0);
        }

        const baseDiffAfterMerge = await ctx.client.getCheckoutDiff(worktree.worktreePath, {
          mode: "base",
          baseRef: "main",
        });
        expect(baseDiffAfterMerge.files.length).toBe(0);

        const worktreeList = await ctx.client.getPaseoWorktreeList({
          cwd: repoDir,
        });
        expect(worktreeList.error).toBeNull();
        expect(
          worktreeList.worktrees.some(
            (entry) =>
              entry.worktreePath === worktree.worktreePath &&
              entry.branchName === "ship-loop-ready",
          ),
        ).toBe(true);

        const archiveResult = await ctx.client.archivePaseoWorktree({
          worktreePath: worktree.worktreePath,
        });
        expect(archiveResult.error).toBeNull();
        expect(archiveResult.success).toBe(true);

        // Archiving removes the agent from the active list but leaves the
        // worktree on disk — disk deletion is a separate, explicit step.
        const worktreeListAfter = await ctx.client.getPaseoWorktreeList({
          cwd: repoDir,
        });
        expect(
          worktreeListAfter.worktrees.some((entry) => entry.worktreePath === worktree.worktreePath),
        ).toBe(true);
        expect(existsSync(worktree.worktreePath)).toBe(true);

        const remainingAgents = await ctx.client.fetchAgents();
        expect(remainingAgents.entries.some((entry) => entry.agent.id === agent.id)).toBe(false);
      } catch (error) {
        testError = error;
      } finally {
        if (agentId) {
          await ctx.client.deleteAgent(agentId).catch(() => undefined);
        }
        try {
          deleteRepoAndVerifyAbsent(repoFullName, githubIdentity);
        } catch (error) {
          repoCleanupError = error;
        }
        rmSync(repoDir, { recursive: true, force: true });
      }

      throwCheckoutShipErrors(testError, repoCleanupError);
    },
    180000,
  );

  test("merge-from-base and push RPCs work with a local origin remote", async () => {
    const repoDir = tmpCwd("checkout-merge-from-base-");
    let agentId: string | null = null;

    try {
      initGitRepo(repoDir);

      const remoteDir = path.join(repoDir, "remote.git");
      execSync(`git init --bare -b main ${remoteDir}`, { stdio: "pipe" });
      execSync(`git remote add origin ${remoteDir}`, { cwd: repoDir, stdio: "pipe" });
      execSync("git push -u origin main", { cwd: repoDir, stdio: "pipe" });

      const worktree = await createLegacyWorktreeForTest({
        branchName: "merge-from-base",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "merge-from-base",
        paseoHome: ctx.daemon.paseoHome,
      });

      const agent = await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd: worktree.worktreePath,
        title: "Merge From Base Test",
      });
      agentId = agent.id;

      const status = await ctx.client.getCheckoutStatus(worktree.worktreePath);
      expect(status.isGit).toBe(true);
      if (status.isGit) {
        expect(status.hasRemote).toBe(true);
        expect(status.baseRef).toBe("main");
      }

      // Advance local main, but leave the agent branch behind it.
      execSync("git checkout main", { cwd: repoDir, stdio: "pipe" });
      writeFileSync(path.join(repoDir, "base.txt"), "base update\n");
      execSync("git add base.txt", { cwd: repoDir, stdio: "pipe" });
      execSync("git -c commit.gpgsign=false commit -m 'base update'", {
        cwd: repoDir,
        stdio: "pipe",
      });
      const baseCommit = execSync("git rev-parse HEAD", { cwd: repoDir, stdio: "pipe" })
        .toString()
        .trim();

      // Add a commit on the agent branch.
      writeFileSync(path.join(worktree.worktreePath, "feature.txt"), "feature\n");
      const commitResult = await ctx.client.checkoutCommit(worktree.worktreePath, {
        message: "feature commit",
        addAll: true,
      });
      expect(commitResult.error).toBeNull();
      expect(commitResult.success).toBe(true);

      const mergeFromBase = await ctx.client.checkoutMergeFromBase(worktree.worktreePath, {
        baseRef: "main",
        requireCleanTarget: true,
      });
      expect(mergeFromBase.error).toBeNull();
      expect(mergeFromBase.success).toBe(true);

      // Verify the agent branch now contains the base commit.
      execSync(`git merge-base --is-ancestor ${baseCommit} HEAD`, {
        cwd: worktree.worktreePath,
        stdio: "pipe",
      });

      const pushResult = await ctx.client.checkoutPush(worktree.worktreePath);
      expect(pushResult.error).toBeNull();
      expect(pushResult.success).toBe(true);
    } finally {
      if (agentId) {
        await ctx.client.deleteAgent(agentId).catch(() => undefined);
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 90000);

  test("checkout RPCs return NOT_GIT_REPO for non-git directories", async () => {
    const cwd = tmpCwd("checkout-ship-non-git-");
    let agentId: string | null = null;

    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Checkout Non-Git",
      });
      agentId = agent.id;

      const status = await ctx.client.getCheckoutStatus(cwd);
      expect(status.isGit).toBe(false);

      const diff = await ctx.client.getCheckoutDiff(cwd, {
        mode: "uncommitted",
      });
      expect(diff.error?.code).toBe("NOT_GIT_REPO");

      const commit = await ctx.client.checkoutCommit(cwd, {
        message: "Should fail",
        addAll: true,
      });
      expect(commit.error?.code).toBe("NOT_GIT_REPO");
    } finally {
      if (agentId) {
        await ctx.client.deleteAgent(agentId).catch(() => undefined);
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60000);
});
