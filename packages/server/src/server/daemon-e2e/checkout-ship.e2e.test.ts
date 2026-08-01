import { beforeEach, afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { execFile, execFileSync, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { z } from "zod";

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
import {
  createGitHubService,
  type GitHubCommandRunner,
  type GitHubCommandRunnerOptions,
} from "../../services/github-service.js";

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
const GIT_COMMAND_TIMEOUT_MS = 30_000;
const GITHUB_AUTH_STATUS_ARGS = [
  "auth",
  "status",
  "--active",
  "--hostname",
  GITHUB_HOST,
  "--json",
  "hosts",
];
const GitHubRepositoryOwnershipSchema = z.object({
  id: z.number().int().positive(),
  node_id: z.string().min(1),
  full_name: z.string().min(1),
  description: z.string(),
});
const GitHubDeleteRepositorySchema = z.object({
  data: z.object({
    deleteRepository: z.object({
      clientMutationId: z.string(),
    }),
  }),
});

type GitHubRepositoryOwnership = z.infer<typeof GitHubRepositoryOwnershipSchema>;

interface CreatedGitHubRepository {
  id: number;
  nodeId: string;
  fullName: string;
  marker: string;
}

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

interface GitHubRunnerAuditEntry {
  args: string[];
  cwd: string;
  host: typeof GITHUB_HOST;
  login: string;
}

interface GitHubProcessRequest {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
}

type GitHubProcessExecutor = (request: GitHubProcessRequest) => Promise<GitHubCliCommandResult>;

interface GitCredentialLease {
  socketPath: string;
  close(): void;
}

type GitHubCliCommandRunner = (
  args: string[],
  identity: GitHubAuthIdentity,
) => GitHubCliCommandResult;
type GitHubAuthIdentityReader = () => GitHubAuthIdentity;

function tmpCwd(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

function scrubSecrets(value: string, secrets: readonly string[]): string {
  return secrets.reduce((scrubbed, secret) => {
    if (!secret) {
      return scrubbed;
    }
    return scrubbed
      .split(secret)
      .join("[REDACTED]")
      .split(encodeURIComponent(secret))
      .join("[REDACTED]");
  }, value);
}

function assertArgsContainNoSecrets(args: readonly string[], secrets: readonly string[]): void {
  const serializedArgs = args.join("\0");
  if (secrets.some((secret) => secret.length > 0 && serializedArgs.includes(secret))) {
    throw new Error("Refusing to put an operation credential in subprocess arguments");
  }
}

function createGitSyncOptions(cwd: string, input?: string) {
  return {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
    input,
    stdio: "pipe" as const,
    timeout: GIT_COMMAND_TIMEOUT_MS,
  };
}

function executeGit(
  args: string[],
  options: { cwd: string; input?: string; secrets?: readonly string[] },
): string {
  const secrets = options.secrets ?? [];
  assertArgsContainNoSecrets(args, secrets);
  try {
    return execFileSync("git", args, createGitSyncOptions(options.cwd, options.input))
      .toString()
      .trim();
  } catch (error) {
    const sanitized = scrubSecrets(formatCommandError(error, "git"), secrets);
    // eslint-disable-next-line preserve-caught-error -- the raw subprocess error may contain the operation credential
    throw new Error(`git command failed: ${sanitized}`);
  }
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
  const secrets = token === undefined ? [] : [token];
  assertArgsContainNoSecrets(args, secrets);
  try {
    return execFileSync("gh", args, createGitHubCliSyncOptions(token)).toString().trim();
  } catch (error) {
    const sanitized = scrubSecrets(formatCommandError(error), secrets);
    // eslint-disable-next-line preserve-caught-error -- the raw subprocess error may contain the operation credential
    throw new Error(`GitHub CLI command failed: ${sanitized}`);
  }
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
  executeGit(["init", "-b", "main"], { cwd: repoDir });
  executeGit(["config", "user.email", "paseo-test@example.com"], { cwd: repoDir });
  executeGit(["config", "user.name", "Paseo Test"], { cwd: repoDir });
  writeFileSync(path.join(repoDir, "README.md"), "init\n");
  executeGit(["add", "README.md"], { cwd: repoDir });
  executeGit(["-c", "commit.gpgsign=false", "commit", "-m", "Initial commit"], {
    cwd: repoDir,
  });
}

function createPrivateRepo(
  repoName: string,
  identity: GitHubAuthIdentity,
): CreatedGitHubRepository {
  const marker = `paseo-checkout-ship-e2e:${randomUUID()}`;
  const output = executeGitHubCli(
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
      "-f",
      `description=${marker}`,
    ],
    identity.token,
  );
  const created = GitHubRepositoryOwnershipSchema.parse(JSON.parse(output));
  const expectedFullName = `${identity.login}/${repoName}`;

  if (created.full_name !== expectedFullName || created.description !== marker) {
    throw new Error(
      `GitHub returned unexpected ownership facts for newly created repo ${expectedFullName}`,
    );
  }

  return {
    id: created.id,
    nodeId: created.node_id,
    fullName: created.full_name,
    marker,
  };
}

function formatCommandError(error: unknown, commandName = "GitHub CLI"): string {
  if (error && typeof error === "object") {
    const commandError = error as {
      code?: string;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      message?: string;
    };
    if (commandError.code === "ETIMEDOUT") {
      const timeoutMs = commandName === "git" ? GIT_COMMAND_TIMEOUT_MS : GITHUB_CLI_TIMEOUT_MS;
      return `${commandName} command timed out after ${timeoutMs}ms`;
    }
    const output = [commandError.stderr, commandError.stdout]
      .map((value) => value?.toString().trim())
      .filter(Boolean)
      .join("\n");

    return output || commandError.message || String(error);
  }

  return String(error);
}

function executeGitHubProcess(request: GitHubProcessRequest): Promise<GitHubCliCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      request.args,
      {
        cwd: request.cwd,
        env: request.env,
        maxBuffer: 10 * 1024 * 1024,
        timeout: request.timeout,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ succeeded: true, output: stdout.trim() });
      },
    );
  });
}

function createPinnedGitHubRunner(
  readIdentity: GitHubAuthIdentityReader,
  audit: GitHubRunnerAuditEntry[],
  executeProcess: GitHubProcessExecutor = executeGitHubProcess,
): GitHubCommandRunner {
  return async (args: string[], options: GitHubCommandRunnerOptions) => {
    const identity = readIdentity();
    assertArgsContainNoSecrets(args, [identity.token]);
    audit.push({
      args: [...args],
      cwd: options.cwd,
      host: GITHUB_HOST,
      login: identity.login,
    });

    try {
      const result = await executeProcess({
        args: [...args],
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.envOverlay,
          GH_HOST: GITHUB_HOST,
          GH_TOKEN: identity.token,
          GITHUB_TOKEN: identity.token,
          GH_PROMPT_DISABLED: "1",
        },
        timeout: GITHUB_CLI_TIMEOUT_MS,
      });
      return {
        stdout: scrubSecrets(result.output, [identity.token]),
        stderr: "",
      };
    } catch (error) {
      const sanitized = scrubSecrets(formatCommandError(error), [identity.token]);
      // eslint-disable-next-line preserve-caught-error -- the raw subprocess error may contain the operation credential
      throw new Error(`Bound GitHub CLI command failed: ${sanitized}`);
    }
  };
}

type GitExecutor = typeof executeGit;

function createGitCredentialLease(
  repoDir: string,
  identity: GitHubAuthIdentity,
  options: {
    audit?: string[][];
    credentialDir?: string;
    execute?: GitExecutor;
  } = {},
): GitCredentialLease {
  const execute = options.execute ?? executeGit;
  const credentialDir = options.credentialDir ?? realpathSync(mkdtempSync("/tmp/pgh-"));
  const socketPath = path.join(credentialDir, "cache.sock");
  const hooksPath = path.join(credentialDir, "empty-hooks");
  const askPassPath = path.join(credentialDir, "deny-askpass.sh");
  mkdirSync(hooksPath, { recursive: true });
  writeFileSync(askPassPath, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const run = (args: string[], input?: string): string => {
    options.audit?.push([...args]);
    return execute(args, {
      cwd: repoDir,
      input,
      secrets: [identity.token],
    });
  };

  run(["config", "--local", "credential.helper", ""]);
  run([
    "config",
    "--local",
    "--add",
    "credential.helper",
    `cache --timeout=300 --socket=${socketPath}`,
  ]);
  run(["config", "--local", "core.hooksPath", hooksPath]);
  run(["config", "--local", "core.askPass", askPassPath]);
  run(["config", "--local", "credential.interactive", "never"]);
  run(["config", "--local", `http.https://${GITHUB_HOST}/.extraHeader`, ""]);
  run(
    ["credential-cache", `--socket=${socketPath}`, "store"],
    `protocol=https\nhost=${GITHUB_HOST}\nusername=x-access-token\npassword=${identity.token}\n\n`,
  );

  let closed = false;
  return {
    socketPath,
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      const errors: unknown[] = [];
      try {
        run(
          ["credential-cache", `--socket=${socketPath}`, "erase"],
          `protocol=https\nhost=${GITHUB_HOST}\nusername=x-access-token\n\n`,
        );
      } catch (error) {
        errors.push(error);
      }
      try {
        run(["credential-cache", `--socket=${socketPath}`, "exit"]);
      } catch (error) {
        errors.push(error);
      }
      try {
        rmSync(credentialDir, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to close the run-owned Git credential cache");
      }
    },
  };
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
  createdRepo: CreatedGitHubRepository | null,
  expectedIdentity: GitHubAuthIdentity,
  runGitHubCommand: GitHubCliCommandRunner = runGitHubCli,
  readActiveIdentity: GitHubAuthIdentityReader = readGitHubAuthIdentity,
): void {
  if (!createdRepo) {
    return;
  }

  let identityBefore: GitHubAuthIdentity;
  try {
    identityBefore = readActiveIdentity();
  } catch (error) {
    throw new Error(
      `Failed to start cleanup of temporary GitHub repo ${createdRepo.fullName}: the active ${GITHUB_HOST} identity could not be proved`,
      { cause: error },
    );
  }
  assertSameGitHubAuthIdentity(expectedIdentity, identityBefore, "before");

  const exactRepoEndpoint = `repos/${createdRepo.fullName}`;
  const accessResult = runGitHubCommand(
    ["api", "--hostname", GITHUB_HOST, exactRepoEndpoint],
    expectedIdentity,
  );
  if (!accessResult.succeeded) {
    throw new Error(
      `Failed to start cleanup of temporary GitHub repo ${createdRepo.fullName}: the retained active identity could not read the exact repo before deletion: ${accessResult.output}`,
    );
  }

  let ownership: GitHubRepositoryOwnership;
  try {
    ownership = GitHubRepositoryOwnershipSchema.parse(JSON.parse(accessResult.output));
  } catch (error) {
    throw new Error(
      `Refusing to delete temporary GitHub repo ${createdRepo.fullName}: ownership readback was invalid`,
      { cause: error },
    );
  }
  if (
    ownership.id !== createdRepo.id ||
    ownership.node_id !== createdRepo.nodeId ||
    ownership.full_name !== createdRepo.fullName ||
    ownership.description !== createdRepo.marker
  ) {
    throw new Error(
      `Refusing to delete temporary GitHub repo ${createdRepo.fullName}: immutable repository identity or run marker changed`,
    );
  }

  const deleteMutation =
    "mutation($repositoryId:ID!,$clientMutationId:String!){deleteRepository(input:{repositoryId:$repositoryId,clientMutationId:$clientMutationId}){clientMutationId}}";
  const deleteResult = runGitHubCommand(
    [
      "api",
      "--hostname",
      GITHUB_HOST,
      "graphql",
      "-f",
      `query=${deleteMutation}`,
      "-f",
      `repositoryId=${createdRepo.nodeId}`,
      "-f",
      `clientMutationId=${createdRepo.marker}`,
    ],
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
      `Failed to prove cleanup of temporary GitHub repo ${createdRepo.fullName}: the active ${GITHUB_HOST} identity was unavailable after the exact-repository readback`,
      { cause: error },
    );
  }
  assertSameGitHubAuthIdentity(expectedIdentity, identityAfter, "after");

  let deletionConfirmed = false;
  let deleteSummary: string;
  if (deleteResult.succeeded) {
    try {
      const parsed = GitHubDeleteRepositorySchema.parse(JSON.parse(deleteResult.output));
      deletionConfirmed = parsed.data.deleteRepository.clientMutationId === createdRepo.marker;
      deleteSummary = deletionConfirmed
        ? "the immutable-ID GitHub delete returned the run marker"
        : "the immutable-ID GitHub delete returned a different run marker";
    } catch {
      deleteSummary = "the immutable-ID GitHub delete returned invalid confirmation";
    }
  } else {
    deleteSummary = `the immutable-ID GitHub delete failed: ${deleteResult.output}`;
  }
  const exactRepoIsAbsent =
    !readbackResult.succeeded && /\bHTTP 404\b/i.test(readbackResult.output);

  if (!deletionConfirmed) {
    throw new Error(
      `Failed to clean up temporary GitHub repo ${createdRepo.fullName}: deletion was not confirmed for its immutable ID and run marker, so the readback cannot certify absence; ${deleteSummary}; readback: ${readbackResult.output}.`,
    );
  }

  if (readbackResult.succeeded) {
    throw new Error(
      `Failed to clean up temporary GitHub repo ${createdRepo.fullName}: the exact repo remains readable after cleanup; ${deleteSummary}.`,
    );
  }

  if (exactRepoIsAbsent) {
    return;
  }

  throw new Error(
    `Failed to verify cleanup of temporary GitHub repo ${createdRepo.fullName}: the exact repo could not be read back to confirm HTTP 404; ${deleteSummary}; readback failed: ${readbackResult.output}.`,
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

function aggregateCleanupErrors(errors: unknown[]): unknown {
  if (errors.length === 0) {
    return undefined;
  }
  if (errors.length === 1) {
    return errors[0];
  }
  return new AggregateError(errors, "Multiple checkout ship cleanup operations failed");
}

describe("checkout ship live GitHub mutation safety", () => {
  const fixtureToken = "fixture-token-not-a-secret";
  const fixtureIdentity: GitHubAuthIdentity = {
    login: "octocat",
    token: fixtureToken,
  };
  const fixtureRepo: CreatedGitHubRepository = {
    id: 12345,
    nodeId: "R_fixtureNodeId",
    fullName: "octocat/checkout-ship-test",
    marker: "paseo-checkout-ship-e2e:fixture-run",
  };
  const readFixtureIdentity = (): GitHubAuthIdentity => ({ ...fixtureIdentity });
  const fixtureOwnershipOutput = JSON.stringify({
    id: fixtureRepo.id,
    node_id: fixtureRepo.nodeId,
    full_name: fixtureRepo.fullName,
    description: fixtureRepo.marker,
  });
  const fixtureDeleteOutput = JSON.stringify({
    data: { deleteRepository: { clientMutationId: fixtureRepo.marker } },
  });

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
    const gitOptions = createGitSyncOptions("/tmp/fixture-repo");

    expect(options.env.GH_HOST).toBe(GITHUB_HOST);
    expect(options.env.GH_TOKEN).toBe(fixtureToken);
    expect(options.timeout).toBe(GITHUB_CLI_TIMEOUT_MS);
    expect(gitOptions.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(gitOptions.timeout).toBe(GIT_COMMAND_TIMEOUT_MS);
  });

  test("operation credentials stay out of argv, errors, and audit logs", async () => {
    const credentialDir = realpathSync(mkdtempSync("/tmp/pgh-test-"));
    const gitCalls: Array<{ args: string[]; input?: string }> = [];
    const fakeGit: GitExecutor = (args, options) => {
      gitCalls.push({ args: [...args], input: options.input });
      return "";
    };
    const lease = createGitCredentialLease("/tmp/fixture-repo", fixtureIdentity, {
      credentialDir,
      execute: fakeGit,
    });
    lease.close();

    expect(gitCalls.some((call) => call.input?.includes(fixtureToken))).toBe(true);
    expect(gitCalls.every((call) => !call.args.join("\0").includes(fixtureToken))).toBe(true);

    let argvError: unknown;
    try {
      executeGit(["remote", "add", "origin", fixtureToken], {
        cwd: "/tmp",
        secrets: [fixtureToken],
      });
    } catch (error) {
      argvError = error;
    }
    expect(argvError).toBeInstanceOf(Error);
    expect((argvError as Error).message).not.toContain(fixtureToken);

    const audit: GitHubRunnerAuditEntry[] = [];
    const requests: GitHubProcessRequest[] = [];
    const runner = createPinnedGitHubRunner(readFixtureIdentity, audit, async (request) => {
      requests.push(request);
      throw new Error(`simulated failure containing ${fixtureToken}`);
    });
    let runnerError: unknown;
    try {
      await runner(["api", "user"], {
        cwd: "/tmp/fixture-repo",
        envOverlay: {
          GH_HOST: "github.example.com",
          GH_TOKEN: "hostile-ambient-token",
        },
      });
    } catch (error) {
      runnerError = error;
    }

    expect(requests).toHaveLength(1);
    expect(requests[0].env.GH_HOST).toBe(GITHUB_HOST);
    expect(requests[0].env.GH_TOKEN).toBe(fixtureToken);
    expect(requests[0].env.GITHUB_TOKEN).toBe(fixtureToken);
    expect(requests[0].timeout).toBe(GITHUB_CLI_TIMEOUT_MS);
    expect(requests[0].args.join("\0")).not.toContain(fixtureToken);
    expect((runnerError as Error).message).not.toContain(fixtureToken);
    expect(JSON.stringify(audit)).not.toContain(fixtureToken);
  });

  test("successful deletion plus same-identity 404 certifies exact-repo cleanup", () => {
    const calls: string[][] = [];
    const runGitHubCommand: GitHubCliCommandRunner = (args) => {
      calls.push(args);
      if (args.includes("graphql")) {
        return { succeeded: true, output: fixtureDeleteOutput };
      }
      return calls.length === 1
        ? { succeeded: true, output: fixtureOwnershipOutput }
        : { succeeded: false, output: "HTTP 404: Not Found" };
    };

    expect(() =>
      deleteRepoAndVerifyAbsent(
        fixtureRepo,
        fixtureIdentity,
        runGitHubCommand,
        readFixtureIdentity,
      ),
    ).not.toThrow();
    expect(calls).toEqual([
      ["api", "--hostname", GITHUB_HOST, "repos/octocat/checkout-ship-test"],
      [
        "api",
        "--hostname",
        GITHUB_HOST,
        "graphql",
        "-f",
        expect.stringContaining("deleteRepository"),
        "-f",
        `repositoryId=${fixtureRepo.nodeId}`,
        "-f",
        `clientMutationId=${fixtureRepo.marker}`,
      ],
      ["api", "--hostname", GITHUB_HOST, "repos/octocat/checkout-ship-test"],
    ]);
  });

  test("cleanup refuses a name collision or replacement with different immutable ownership", () => {
    const calls: string[][] = [];
    const runGitHubCommand: GitHubCliCommandRunner = (args) => {
      calls.push(args);
      return {
        succeeded: true,
        output: JSON.stringify({
          id: fixtureRepo.id + 1,
          node_id: "R_replacement",
          full_name: fixtureRepo.fullName,
          description: fixtureRepo.marker,
        }),
      };
    };

    expect(() =>
      deleteRepoAndVerifyAbsent(
        fixtureRepo,
        fixtureIdentity,
        runGitHubCommand,
        readFixtureIdentity,
      ),
    ).toThrow("immutable repository identity or run marker changed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("graphql");
  });

  test("cleanup is not armed before a successful create returns immutable ownership", () => {
    let identityRead = false;
    let commandRun = false;
    const runGitHubCommand: GitHubCliCommandRunner = () => {
      commandRun = true;
      return { succeeded: false, output: "must not run" };
    };
    const readActiveIdentity: GitHubAuthIdentityReader = () => {
      identityRead = true;
      return fixtureIdentity;
    };

    expect(() =>
      deleteRepoAndVerifyAbsent(null, fixtureIdentity, runGitHubCommand, readActiveIdentity),
    ).not.toThrow();
    expect(identityRead).toBe(false);
    expect(commandRun).toBe(false);
  });

  test("failed deletion plus 404 is surfaced instead of certifying cleanup", () => {
    let apiCalls = 0;
    const runGitHubCommand: GitHubCliCommandRunner = (args) => {
      if (args.includes("graphql")) {
        return { succeeded: false, output: "HTTP 403: delete_repo scope required" };
      }
      apiCalls += 1;
      return apiCalls === 1
        ? { succeeded: true, output: fixtureOwnershipOutput }
        : { succeeded: false, output: "HTTP 404: Not Found" };
    };

    expect(() =>
      deleteRepoAndVerifyAbsent(
        fixtureRepo,
        fixtureIdentity,
        runGitHubCommand,
        readFixtureIdentity,
      ),
    ).toThrow(
      "Failed to clean up temporary GitHub repo octocat/checkout-ship-test: deletion was not confirmed for its immutable ID and run marker",
    );
  });

  test("404 with lost token access is an inconclusive hard cleanup failure", () => {
    let apiCalls = 0;
    const runGitHubCommand: GitHubCliCommandRunner = (args) => {
      if (args.includes("graphql")) {
        return { succeeded: true, output: fixtureDeleteOutput };
      }
      apiCalls += 1;
      return apiCalls === 1
        ? { succeeded: true, output: fixtureOwnershipOutput }
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
      deleteRepoAndVerifyAbsent(fixtureRepo, fixtureIdentity, runGitHubCommand, readActiveIdentity),
    ).toThrow(
      "Failed to prove cleanup of temporary GitHub repo octocat/checkout-ship-test: the active github.com identity was unavailable after the exact-repository readback",
    );
  });

  test("GitHub CLI timeout is bounded and a timed-out delete cannot certify a 404", () => {
    let apiCalls = 0;
    const timeoutOutput = formatCommandError({ code: "ETIMEDOUT" });
    const runGitHubCommand: GitHubCliCommandRunner = (args) => {
      if (args.includes("graphql")) {
        return { succeeded: false, output: timeoutOutput };
      }
      apiCalls += 1;
      return apiCalls === 1
        ? { succeeded: true, output: fixtureOwnershipOutput }
        : { succeeded: false, output: "HTTP 404: Not Found" };
    };

    expect(timeoutOutput).toContain(`${GITHUB_CLI_TIMEOUT_MS}ms`);
    expect(() =>
      deleteRepoAndVerifyAbsent(
        fixtureRepo,
        fixtureIdentity,
        runGitHubCommand,
        readFixtureIdentity,
      ),
    ).toThrow("GitHub CLI command timed out");
  });

  test("test, agent, remote, credential, and filesystem failures are preserved", () => {
    const testError = new Error("test failed");
    const cleanupErrors = [
      new Error("agent cleanup failed"),
      new Error("remote cleanup failed"),
      new Error("credential cleanup failed"),
      new Error("filesystem cleanup failed"),
    ];
    const cleanupError = aggregateCleanupErrors(cleanupErrors);

    try {
      throwCheckoutShipErrors(testError, cleanupError);
      throw new Error("Expected throwCheckoutShipErrors to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([testError, cleanupError]);
      expect(cleanupError).toBeInstanceOf(AggregateError);
      expect((cleanupError as AggregateError).errors).toEqual(cleanupErrors);
    }
  });
});

describe("daemon checkout ship loop", () => {
  let ctx: DaemonTestContext;
  let operationIdentity: GitHubAuthIdentity | null;
  let githubAudit: GitHubRunnerAuditEntry[];

  beforeEach(async () => {
    operationIdentity = null;
    githubAudit = [];
    const github = createGitHubService({
      resolveRepoHost: async () => GITHUB_HOST,
      runner: createPinnedGitHubRunner(() => {
        if (!operationIdentity) {
          throw new Error("No checkout ship operation credential is active");
        }
        return operationIdentity;
      }, githubAudit),
    });
    ctx = await createDaemonTestContext({ github });
  });

  afterEach(async () => {
    operationIdentity = null;
    await ctx.cleanup();
  }, 60000);

  testWithExplicitLiveGitHubOptIn(
    "runs the full checkout ship loop via checkout RPCs",
    async () => {
      const githubIdentity = assertCheckoutShipLiveGitHubMutationEnabled();
      operationIdentity = githubIdentity;

      const repoDir = tmpCwd("checkout-ship-");
      let createdRepo: CreatedGitHubRepository | null = null;
      let credentialLease: GitCredentialLease | null = null;
      const gitAudit: string[][] = [];
      let agentId: string | null = null;
      let testError: unknown;
      let repoCleanupError: unknown;

      try {
        initGitRepo(repoDir);

        const repoName = createTempGithubRepoName("checkout-ship");
        createdRepo = createPrivateRepo(repoName, githubIdentity);
        credentialLease = createGitCredentialLease(repoDir, githubIdentity, { audit: gitAudit });

        const credentialFreeRemote = `https://${GITHUB_HOST}/${createdRepo.fullName}.git`;
        executeGit(["remote", "add", "origin", credentialFreeRemote], {
          cwd: repoDir,
          secrets: [githubIdentity.token],
        });
        expect(executeGit(["remote", "get-url", "origin"], { cwd: repoDir })).toBe(
          credentialFreeRemote,
        );
        expect(readFileSync(path.join(repoDir, ".git", "config"), "utf8")).not.toContain(
          githubIdentity.token,
        );
        executeGit(["push", "-u", "origin", "main"], {
          cwd: repoDir,
          secrets: [githubIdentity.token],
        });

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
        expect(JSON.stringify(status)).not.toContain(githubIdentity.token);

        executeGit(["branch", "-m", "ship-loop-ready"], {
          cwd: worktree.worktreePath,
          secrets: [githubIdentity.token],
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
        expect(prCreate.number).not.toBeNull();
        expect(prCreate.url).toBe(
          `https://api.github.com/repos/${createdRepo.fullName}/pulls/${prCreate.number}`,
        );
        const ownershipReadback = GitHubRepositoryOwnershipSchema.parse(
          JSON.parse(
            executeGitHubCli(
              ["api", "--hostname", GITHUB_HOST, `repos/${createdRepo.fullName}`],
              githubIdentity.token,
            ),
          ),
        );
        expect(ownershipReadback).toEqual({
          id: createdRepo.id,
          node_id: createdRepo.nodeId,
          full_name: createdRepo.fullName,
          description: createdRepo.marker,
        });
        expect(
          githubAudit.some((entry) => entry.args.includes(`repos/${createdRepo?.fullName}/pulls`)),
        ).toBe(true);
        expect(githubAudit.every((entry) => entry.host === GITHUB_HOST)).toBe(true);
        expect(githubAudit.every((entry) => entry.login === githubIdentity.login)).toBe(true);
        expect(JSON.stringify(githubAudit)).not.toContain(githubIdentity.token);
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
        expect(JSON.stringify({ statusAfterMerge, worktreeListAfter, gitAudit })).not.toContain(
          githubIdentity.token,
        );
        agentId = null;
      } catch (error) {
        testError = error;
      } finally {
        const cleanupErrors: unknown[] = [];
        if (agentId) {
          try {
            await ctx.client.deleteAgent(agentId);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        try {
          deleteRepoAndVerifyAbsent(createdRepo, githubIdentity);
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          credentialLease?.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          rmSync(repoDir, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
        operationIdentity = null;
        repoCleanupError = aggregateCleanupErrors(cleanupErrors);
      }

      throwCheckoutShipErrors(testError, repoCleanupError);
    },
    180000,
  );

  test("credential-free GitHub remotes stay token-free in checkout protocol facts", async () => {
    const repoDir = tmpCwd("checkout-ship-token-free-status-");
    const sentinelToken = "sentinel-delete-repo-token";

    try {
      initGitRepo(repoDir);
      const remote = `https://${GITHUB_HOST}/octocat/checkout-ship-token-free.git`;
      executeGit(["remote", "add", "origin", remote], {
        cwd: repoDir,
        secrets: [sentinelToken],
      });

      const status = await ctx.client.getCheckoutStatus(repoDir);
      expect(status.isGit).toBe(true);
      expect(executeGit(["remote", "get-url", "origin"], { cwd: repoDir })).toBe(remote);
      expect(readFileSync(path.join(repoDir, ".git", "config"), "utf8")).not.toContain(
        sentinelToken,
      );
      expect(JSON.stringify({ status, githubAudit })).not.toContain(sentinelToken);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("merge-from-base and push RPCs work with a local origin remote", async () => {
    const repoDir = tmpCwd("checkout-merge-from-base-");
    let agentId: string | null = null;

    try {
      initGitRepo(repoDir);

      const remoteDir = path.join(repoDir, "remote.git");
      executeGit(["init", "--bare", "-b", "main", remoteDir], { cwd: repoDir });
      executeGit(["remote", "add", "origin", remoteDir], { cwd: repoDir });
      executeGit(["push", "-u", "origin", "main"], { cwd: repoDir });

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
      executeGit(["checkout", "main"], { cwd: repoDir });
      writeFileSync(path.join(repoDir, "base.txt"), "base update\n");
      executeGit(["add", "base.txt"], { cwd: repoDir });
      executeGit(["-c", "commit.gpgsign=false", "commit", "-m", "base update"], {
        cwd: repoDir,
      });
      const baseCommit = executeGit(["rev-parse", "HEAD"], { cwd: repoDir });

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
      executeGit(["merge-base", "--is-ancestor", baseCommit, "HEAD"], {
        cwd: worktree.worktreePath,
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
