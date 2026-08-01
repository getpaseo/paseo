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
import { type ChildProcessWithoutNullStreams, execFileSync, spawn, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { createConnection } from "net";
import pino from "pino";
import { z } from "zod";

import {
  createTestPaseoDaemon,
  createTempGithubRepoName,
  DaemonClient,
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
const CREDENTIAL_CACHE_OPERATION_TIMEOUT_MS = 2_000;
const CREDENTIAL_CACHE_TTL_SECONDS = 300;
const REPOSITORY_CREATE_SETTLEMENT_TIMEOUT_MS = 30_000;
const REPOSITORY_CREATE_SETTLEMENT_POLL_MS = 500;
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
const GitHubPullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  html_url: z.string(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().nullable(),
  base: z.object({ ref: z.string() }),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: z.object({ owner: z.object({ login: z.string() }) }).nullable(),
  }),
  merged_at: z.string().nullable(),
  merge_commit_sha: z.string().nullable(),
  mergeable: z.boolean().nullable().optional().default(null),
});
const GitHubMergePullRequestSchema = z.object({
  merged: z.boolean(),
  message: z.string(),
  sha: z.string().nullable().optional(),
});

type GitHubRepositoryOwnership = z.infer<typeof GitHubRepositoryOwnershipSchema>;

interface CreatedGitHubRepository {
  id: number;
  nodeId: string;
  fullName: string;
  marker: string;
}

interface IntendedGitHubRepository {
  fullName: string;
  marker: string;
}

interface GitHubCliAuthStatus {
  authenticated: boolean;
  canDeleteRepositories: boolean;
  activeLogin: string | null;
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

interface GitHubOperatorRequest {
  args: string[];
  cwd: string;
  host: typeof GITHUB_HOST;
  timeout: number;
}

interface GitHubApiRequest {
  method: "DELETE" | "GET" | "POST" | "PUT";
  endpoint: string;
  body?: Record<string, unknown>;
}

type GitHubApiExecutor = (request: GitHubApiRequest, token: string) => Promise<unknown>;

interface GitHubCredentialOwner {
  readonly login: string;
  assertTokenFree(value: string): void;
  createChildEnvironment(baseEnvironment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  request(request: GitHubApiRequest): Promise<unknown>;
  runOperator(request: GitHubOperatorRequest): Promise<GitHubCliCommandResult>;
  sameCredential(other: GitHubCredentialOwner): boolean;
  scrub(value: string): string;
  storeGitCredential(socketPath: string, send: GitCredentialCacheRequestSender): Promise<void>;
}

interface GitCredentialLease {
  socketPath: string;
  close(): Promise<void>;
}

type GitHubCliCommandRunner = (
  args: string[],
  owner: GitHubCredentialOwner,
) => Promise<GitHubCliCommandResult>;
type GitHubCredentialOwnerReader = () => GitHubCredentialOwner;
type ActiveGitHubCredentialOwnerReader = () => Promise<GitHubCredentialOwner>;
type GitCredentialCacheRequestSender = (
  socketPath: string,
  request: string,
  timeoutMs: number,
) => Promise<string>;
type GitExecutor = typeof executeGit;
type GitCredentialCacheDaemonStarter = (
  socketPath: string,
  owner: GitHubCredentialOwner,
) => Promise<ChildProcessWithoutNullStreams>;

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

function createTokenFreeChildEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  secrets: readonly string[],
): NodeJS.ProcessEnv {
  const blockedKeys = new Set([
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GIT_CURL_VERBOSE",
    "GIT_TRACE",
    "GIT_TRACE_CURL",
    "GIT_TRACE_PACKET",
  ]);
  return Object.fromEntries(
    Object.entries(baseEnvironment).filter(([key, value]) => {
      if (blockedKeys.has(key) || key.startsWith("GIT_TRACE")) {
        return false;
      }
      return !secrets.some(
        (secret) =>
          secret.length > 0 &&
          (key.includes(secret) ||
            key.includes(encodeURIComponent(secret)) ||
            (value !== undefined &&
              (value.includes(secret) || value.includes(encodeURIComponent(secret))))),
      );
    }),
  );
}

function createGitHubCredentialDiscoveryEnvironment(
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowedKeys = [
    "GH_CONFIG_DIR",
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LANG",
    "LC_ALL",
    "NO_PROXY",
    "PATH",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "TMPDIR",
    "XDG_CONFIG_HOME",
  ];
  return Object.fromEntries(
    allowedKeys.flatMap((key) => {
      const value = baseEnvironment[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function sanitizeProcessEnvironmentForCredential(owner: GitHubCredentialOwner): () => void {
  const originalEnvironment = { ...process.env };
  const sanitizedEnvironment = owner.createChildEnvironment(process.env);
  for (const key of Object.keys(process.env)) {
    if (!(key in sanitizedEnvironment)) {
      delete process.env[key];
    }
  }
  return () => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnvironment);
  };
}

function createGitSyncOptions(cwd: string, input?: string, owner?: GitHubCredentialOwner) {
  const env = owner
    ? owner.createChildEnvironment()
    : createTokenFreeChildEnvironment(process.env, []);
  const childEnvironment: NodeJS.ProcessEnv = {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
  return {
    cwd,
    env: childEnvironment,
    input,
    stdio: "pipe" as const,
    timeout: GIT_COMMAND_TIMEOUT_MS,
  };
}

function executeGit(
  args: string[],
  options: { cwd: string; input?: string; owner?: GitHubCredentialOwner },
): string {
  options.owner?.assertTokenFree(args.join("\0"));
  try {
    const output = execFileSync(
      "git",
      args,
      createGitSyncOptions(options.cwd, options.input, options.owner),
    )
      .toString()
      .trim();
    options.owner?.assertTokenFree(output);
    return output;
  } catch (error) {
    const commandError = formatCommandError(error, "git");
    const sanitized = options.owner?.scrub(commandError) ?? commandError;
    // eslint-disable-next-line preserve-caught-error -- the raw subprocess error may contain the operation credential
    throw new Error(`git command failed: ${sanitized}`);
  }
}

function createGitHubCliSyncOptions(baseEnvironment: NodeJS.ProcessEnv = process.env): {
  env: NodeJS.ProcessEnv;
  stdio: "pipe";
  timeout: number;
} {
  return {
    env: {
      ...createGitHubCredentialDiscoveryEnvironment(baseEnvironment),
      GH_HOST: GITHUB_HOST,
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
      ? new Set(activeAccount.scopes.split(",").map((scope: string) => scope.trim()))
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

function executeGitHubCli(args: string[]): string {
  try {
    return execFileSync("gh", args, createGitHubCliSyncOptions()).toString().trim();
  } catch {
    throw new Error("GitHub CLI credential discovery failed");
  }
}

async function readGitHubCredentialOwner(
  authStatus = getGitHubCliAuthStatus(),
): Promise<GitHubCredentialOwner> {
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
  const owner = createGitHubCredentialOwner(authStatus.activeLogin, token);
  const user = z.object({ login: z.string() }).parse(
    await owner.request({
      method: "GET",
      endpoint: "user",
    }),
  );

  if (user.login !== authStatus.activeLogin) {
    throw new Error(
      `The active ${GITHUB_HOST} account changed while binding its cleanup token identity`,
    );
  }

  return owner;
}

function shouldRunCheckoutShipLiveGitHubMutation(
  explicitOptIn: string | undefined,
  authStatus: GitHubCliAuthStatus,
): boolean {
  return explicitOptIn === "1" && authStatus.authenticated && authStatus.canDeleteRepositories;
}

async function assertCheckoutShipLiveGitHubMutationEnabled(): Promise<GitHubCredentialOwner> {
  const explicitOptIn = process.env[CHECKOUT_SHIP_LIVE_GITHUB_E2E];
  const authStatus = getGitHubCliAuthStatus();

  if (shouldRunCheckoutShipLiveGitHubMutation(explicitOptIn, authStatus)) {
    return readGitHubCredentialOwner(authStatus);
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

function initGitRepo(repoDir: string, owner?: GitHubCredentialOwner): void {
  executeGit(["init", "-b", "main"], { cwd: repoDir, owner });
  executeGit(["config", "user.email", "paseo-test@example.com"], { cwd: repoDir, owner });
  executeGit(["config", "user.name", "Paseo Test"], { cwd: repoDir, owner });
  writeFileSync(path.join(repoDir, "README.md"), "init\n");
  executeGit(["add", "README.md"], { cwd: repoDir, owner });
  executeGit(["-c", "commit.gpgsign=false", "commit", "-m", "Initial commit"], {
    cwd: repoDir,
    owner,
  });
}

async function createPrivateRepo(
  intendedRepo: IntendedGitHubRepository,
  owner: GitHubCredentialOwner,
): Promise<CreatedGitHubRepository> {
  const repoName = intendedRepo.fullName.slice(owner.login.length + 1);
  const created = GitHubRepositoryOwnershipSchema.parse(
    await owner.request({
      method: "POST",
      endpoint: "user/repos",
      body: { name: repoName, private: true, description: intendedRepo.marker },
    }),
  );

  if (created.full_name !== intendedRepo.fullName || created.description !== intendedRepo.marker) {
    throw new Error(
      `GitHub returned unexpected ownership facts for newly created repo ${intendedRepo.fullName}`,
    );
  }

  return {
    id: created.id,
    nodeId: created.node_id,
    fullName: created.full_name,
    marker: intendedRepo.marker,
  };
}

async function recoverCreatedRepoForCleanup(
  createdRepo: CreatedGitHubRepository | null,
  intendedRepo: IntendedGitHubRepository,
  owner: GitHubCredentialOwner,
  options: {
    settlementTimeoutMs?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<CreatedGitHubRepository | null> {
  if (createdRepo) {
    return createdRepo;
  }

  const settlementTimeoutMs =
    options.settlementTimeoutMs ?? REPOSITORY_CREATE_SETTLEMENT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? REPOSITORY_CREATE_SETTLEMENT_POLL_MS;
  const deadline = Date.now() + settlementTimeoutMs;
  let recovered: GitHubRepositoryOwnership | null = null;
  while (recovered === null) {
    try {
      recovered = GitHubRepositoryOwnershipSchema.parse(
        await owner.request({
          method: "GET",
          endpoint: `repos/${intendedRepo.fullName}`,
        }),
      );
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        if (Date.now() >= deadline) {
          throw new Error(
            `Could not certify absence of the intended temporary GitHub repo ${intendedRepo.fullName} after an inconclusive create attempt`,
            { cause: error },
          );
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        continue;
      }
      throw new Error(
        `Failed to resolve the intended temporary GitHub repo ${intendedRepo.fullName} after an inconclusive create attempt`,
        { cause: error },
      );
    }
  }

  if (
    recovered.full_name !== intendedRepo.fullName ||
    recovered.description !== intendedRepo.marker
  ) {
    throw new Error(
      `Refusing to clean up ${intendedRepo.fullName}: its run marker does not match this create attempt`,
    );
  }

  return {
    id: recovered.id,
    nodeId: recovered.node_id,
    fullName: recovered.full_name,
    marker: intendedRepo.marker,
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

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly response: string,
  ) {
    super(`GitHub API returned HTTP ${status}: ${response}`);
    this.name = "GitHubApiError";
  }
}

async function executeGitHubApi(request: GitHubApiRequest, token: string): Promise<unknown> {
  const response = await fetch(`https://api.${GITHUB_HOST}/${request.endpoint}`, {
    method: request.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "paseo-checkout-ship-live-e2e",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: request.body ? JSON.stringify(request.body) : undefined,
    signal: AbortSignal.timeout(GITHUB_CLI_TIMEOUT_MS),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new GitHubApiError(response.status, responseText);
  }
  if (!responseText) {
    return null;
  }
  const parsed: unknown = JSON.parse(responseText);
  if (request.endpoint === "graphql" && isRecord(parsed) && Array.isArray(parsed.errors)) {
    throw new GitHubApiError(response.status, JSON.stringify(parsed.errors));
  }
  return parsed;
}

function parseApiField(value: string, typed: boolean): [string, unknown] {
  const separator = value.indexOf("=");
  if (separator === -1) {
    throw new Error("GitHub API field is missing '='");
  }
  const key = value.slice(0, separator);
  const rawValue = value.slice(separator + 1);
  if (!typed) {
    return [key, rawValue];
  }
  if (rawValue === "true") {
    return [key, true];
  }
  if (rawValue === "false") {
    return [key, false];
  }
  if (/^-?\d+$/.test(rawValue)) {
    return [key, Number(rawValue)];
  }
  return [key, rawValue];
}

function parseGitHubApiOperator(args: string[]): GitHubApiRequest {
  let endpoint: string | null = null;
  let method: GitHubApiRequest["method"] | null = null;
  const body: Record<string, unknown> = {};
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-X" || arg === "--method") {
      method = args[index + 1] as GitHubApiRequest["method"];
      index += 1;
      continue;
    }
    if (arg === "-f" || arg === "--raw-field" || arg === "-F" || arg === "--field") {
      const [key, value] = parseApiField(args[index + 1], arg === "-F" || arg === "--field");
      body[key] = value;
      index += 1;
      continue;
    }
    if (arg === "--hostname") {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-") && endpoint === null) {
      endpoint = arg;
    }
  }
  if (!endpoint) {
    throw new Error("GitHub API operator request has no endpoint");
  }
  let requestBody = body;
  if (endpoint === "graphql") {
    const variables = Object.fromEntries(
      Object.entries(body).filter(([key]) => key !== "query" && key !== "operationName"),
    );
    requestBody = {
      ...(body.query === undefined ? {} : { query: body.query }),
      ...(body.operationName === undefined ? {} : { operationName: body.operationName }),
      ...(Object.keys(variables).length === 0 ? {} : { variables }),
    };
  }
  const effectiveMethod = method ?? (Object.keys(requestBody).length > 0 ? "POST" : "GET");
  return {
    method: effectiveMethod,
    endpoint,
    ...(Object.keys(requestBody).length > 0 ? { body: requestBody } : {}),
  };
}

function toGitHubCliPullRequest(pullRequest: z.infer<typeof GitHubPullRequestSchema>) {
  const state = pullRequest.merged_at ? "MERGED" : pullRequest.state.toUpperCase();
  let mergeable = "UNKNOWN";
  if (pullRequest.mergeable === true) {
    mergeable = "MERGEABLE";
  } else if (pullRequest.mergeable === false) {
    mergeable = "CONFLICTING";
  }
  return {
    number: pullRequest.number,
    url: pullRequest.html_url,
    title: pullRequest.title,
    state,
    isDraft: pullRequest.draft ?? false,
    baseRefName: pullRequest.base.ref,
    headRefName: pullRequest.head.ref,
    headRefOid: pullRequest.head.sha,
    mergedAt: pullRequest.merged_at,
    statusCheckRollup: [],
    reviewDecision: null,
    mergeable,
    headRepositoryOwner: pullRequest.head.repo?.owner ?? null,
  };
}

async function resolveGitHubOperatorRepo(
  request: GitHubOperatorRequest,
  owner: GitHubCredentialOwner,
): Promise<string> {
  const remote = executeGit(["config", "--get", "remote.origin.url"], {
    cwd: request.cwd,
    owner,
  });
  const match = remote.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error("Pinned GitHub operator requires a credential-free github.com origin");
  }
  return match[1];
}

async function readGitHubOperatorPullRequests(
  request: GitHubOperatorRequest,
  owner: GitHubCredentialOwner,
): Promise<Array<z.infer<typeof GitHubPullRequestSchema>>> {
  const repo = await resolveGitHubOperatorRepo(request, owner);
  const headFlag = request.args.indexOf("--head");
  const currentBranch = executeGit(["branch", "--show-current"], { cwd: request.cwd, owner });
  const requestedHead = headFlag === -1 ? currentBranch : request.args[headFlag + 1];
  const head = requestedHead.includes(":") ? requestedHead : `${owner.login}:${requestedHead}`;
  const listed = z.array(z.object({ number: z.number().int().positive() })).parse(
    await owner.request({
      method: "GET",
      endpoint: `repos/${repo}/pulls?state=all&head=${encodeURIComponent(head)}&per_page=10`,
    }),
  );
  return Promise.all(
    listed.map(async ({ number }) =>
      GitHubPullRequestSchema.parse(
        await owner.request({ method: "GET", endpoint: `repos/${repo}/pulls/${number}` }),
      ),
    ),
  );
}

async function executeGitHubOperator(
  request: GitHubOperatorRequest,
  owner: GitHubCredentialOwner,
): Promise<GitHubCliCommandResult> {
  if (request.host !== GITHUB_HOST) {
    throw new Error("Pinned GitHub operator refused a non-github.com host");
  }
  if (request.args[0] === "api") {
    const response = await owner.request(parseGitHubApiOperator(request.args));
    return { succeeded: true, output: response === null ? "" : JSON.stringify(response) };
  }
  if (request.args[0] === "pr" && request.args[1] === "view") {
    const pullRequests = await readGitHubOperatorPullRequests(request, owner);
    if (pullRequests.length === 0) {
      throw new Error("no pull requests found for branch");
    }
    return { succeeded: true, output: JSON.stringify(toGitHubCliPullRequest(pullRequests[0])) };
  }
  if (request.args[0] === "pr" && request.args[1] === "list") {
    const pullRequests = await readGitHubOperatorPullRequests(request, owner);
    return {
      succeeded: true,
      output: JSON.stringify(pullRequests.map(toGitHubCliPullRequest)),
    };
  }
  if (request.args[0] === "pr" && request.args[1] === "merge") {
    const repo = await resolveGitHubOperatorRepo(request, owner);
    const prNumber = z.coerce.number().int().positive().parse(request.args[2]);
    let mergeMethod = "merge";
    if (request.args.includes("--squash")) {
      mergeMethod = "squash";
    } else if (request.args.includes("--rebase")) {
      mergeMethod = "rebase";
    }
    const merge = GitHubMergePullRequestSchema.parse(
      await owner.request({
        method: "PUT",
        endpoint: `repos/${repo}/pulls/${prNumber}/merge`,
        body: { merge_method: mergeMethod },
      }),
    );
    if (!merge.merged) {
      throw new Error(`GitHub refused to merge the pull request: ${merge.message}`);
    }
    return { succeeded: true, output: JSON.stringify(merge) };
  }
  throw new Error(`Pinned GitHub operator does not support: ${request.args.join(" ")}`);
}

function createGitHubCredentialOwner(
  login: string,
  token: string,
  executeApi: GitHubApiExecutor = executeGitHubApi,
): GitHubCredentialOwner {
  const credentialRepresentations = [
    token,
    encodeURIComponent(token),
    Buffer.from(token).toString("base64"),
    Buffer.from(`x-access-token:${token}`).toString("base64"),
  ];
  function assertTokenFree(value: string): void {
    if (credentialRepresentations.some((representation) => value.includes(representation))) {
      throw new Error("Refusing to expose the operation credential outside its owner");
    }
  }
  function scrub(value: string): string {
    return scrubSecrets(value, credentialRepresentations);
  }
  async function request(apiRequest: GitHubApiRequest): Promise<unknown> {
    try {
      const response = await executeApi(apiRequest, token);
      assertTokenFree(JSON.stringify(response));
      return response;
    } catch (error) {
      if (error instanceof GitHubApiError) {
        throw new GitHubApiError(error.status, scrub(error.response));
      }
      // eslint-disable-next-line preserve-caught-error -- the raw API error may contain the operation credential
      throw new Error(scrub(formatCommandError(error, "GitHub API")));
    }
  }
  const owner: GitHubCredentialOwner = {
    login,
    assertTokenFree,
    createChildEnvironment(baseEnvironment = process.env): NodeJS.ProcessEnv {
      return createTokenFreeChildEnvironment(baseEnvironment, credentialRepresentations);
    },
    request,
    async runOperator(operatorRequest): Promise<GitHubCliCommandResult> {
      return executeGitHubOperator(operatorRequest, owner);
    },
    sameCredential(other): boolean {
      return other.login === login && other.scrub(token) === "[REDACTED]";
    },
    scrub,
    async storeGitCredential(socketPath, send): Promise<void> {
      await send(
        socketPath,
        `action=store\ntimeout=${CREDENTIAL_CACHE_TTL_SECONDS}\nprotocol=https\nhost=${GITHUB_HOST}\nusername=x-access-token\npassword=${token}\n\n`,
        CREDENTIAL_CACHE_OPERATION_TIMEOUT_MS,
      );
    },
  };
  return owner;
}

function createPinnedGitHubRunner(
  readOwner: GitHubCredentialOwnerReader,
  audit: GitHubRunnerAuditEntry[],
): GitHubCommandRunner {
  return async (args: string[], options: GitHubCommandRunnerOptions) => {
    const owner = readOwner();
    owner.assertTokenFree(args.join("\0"));
    audit.push({
      args: [...args],
      cwd: options.cwd,
      host: GITHUB_HOST,
      login: owner.login,
    });

    try {
      const result = await owner.runOperator({
        args: [...args],
        cwd: options.cwd,
        host: GITHUB_HOST,
        timeout: GITHUB_CLI_TIMEOUT_MS,
      });
      return {
        stdout: owner.scrub(result.output),
        stderr: "",
      };
    } catch (error) {
      const sanitized = owner.scrub(formatCommandError(error));
      // eslint-disable-next-line preserve-caught-error -- the raw operator error may contain the operation credential
      throw new Error(`Bound GitHub CLI command failed: ${sanitized}`);
    }
  };
}

function sendGitCredentialCacheRequest(
  socketPath: string,
  request: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection(socketPath);
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString()));
    socket.on("timeout", () => socket.destroy(new Error("Git credential cache request timed out")));
    socket.on("error", reject);
  });
}

function startGitCredentialCacheDaemon(
  socketPath: string,
  owner: GitHubCredentialOwner,
): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["credential-cache--daemon", socketPath], {
      env: owner.createChildEnvironment(),
      stdio: "pipe",
    });
    let stderr = "";
    let settled = false;
    async function rejectAfterStopping(error: Error): Promise<void> {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.kill();
      try {
        await waitForChildExit(child, CREDENTIAL_CACHE_OPERATION_TIMEOUT_MS);
      } catch {
        // The startup error remains primary; waitForChildExit sends SIGKILL on its own timeout.
      }
      reject(error);
    }
    const timeout = setTimeout(() => {
      void rejectAfterStopping(
        new Error("Git credential cache daemon did not become ready in time"),
      );
    }, CREDENTIAL_CACHE_OPERATION_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.once("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      const output = chunk.toString();
      if (!output.includes("ok")) {
        void rejectAfterStopping(
          new Error(`Git credential cache daemon failed to start: ${owner.scrub(output)}`),
        );
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(child);
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(
          new Error(
            `Git credential cache daemon exited during startup (${code}): ${owner.scrub(stderr)}`,
          ),
        );
      }
    });
  });
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let forced = false;
    let forceTimeout: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      forced = true;
      child.kill("SIGKILL");
      forceTimeout = setTimeout(
        () => reject(new Error("Git credential cache daemon remained alive after SIGKILL")),
        timeoutMs,
      );
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      clearTimeout(forceTimeout);
      if (forced) {
        reject(new Error("Git credential cache daemon required SIGKILL to exit"));
      } else {
        resolve();
      }
    });
  });
}

async function stopGitCredentialCacheDaemon(
  child: ChildProcessWithoutNullStreams | null,
  socketPath: string,
  send: GitCredentialCacheRequestSender,
): Promise<void> {
  if (!child) {
    return;
  }
  if (child.exitCode === null && child.signalCode === null) {
    await send(
      socketPath,
      `action=erase\ntimeout=${CREDENTIAL_CACHE_TTL_SECONDS}\nprotocol=https\nhost=${GITHUB_HOST}\nusername=x-access-token\n\n`,
      CREDENTIAL_CACHE_OPERATION_TIMEOUT_MS,
    );
    await send(
      socketPath,
      `action=exit\ntimeout=${CREDENTIAL_CACHE_TTL_SECONDS}\n\n`,
      CREDENTIAL_CACHE_OPERATION_TIMEOUT_MS,
    );
  }
  await waitForChildExit(child, CREDENTIAL_CACHE_OPERATION_TIMEOUT_MS);
}

async function createGitCredentialLease(
  repoDir: string,
  owner: GitHubCredentialOwner,
  options: {
    audit?: string[][];
    credentialDir?: string;
    execute?: GitExecutor;
    send?: GitCredentialCacheRequestSender;
    startDaemon?: GitCredentialCacheDaemonStarter;
  } = {},
): Promise<GitCredentialLease> {
  const execute = options.execute ?? executeGit;
  const send = options.send ?? sendGitCredentialCacheRequest;
  const startDaemon = options.startDaemon ?? startGitCredentialCacheDaemon;
  const credentialDir = options.credentialDir ?? realpathSync(mkdtempSync("/tmp/pgh-"));
  const socketPath = path.join(credentialDir, "cache.sock");
  const hooksPath = path.join(credentialDir, "empty-hooks");
  const askPassPath = path.join(credentialDir, "deny-askpass.sh");
  const gitConfigPath = path.join(repoDir, ".git", "config");
  const originalGitConfig = readFileSync(gitConfigPath);
  const run = (args: string[], input?: string): string => {
    options.audit?.push([...args]);
    return execute(args, { cwd: repoDir, input, owner });
  };
  let daemon: ChildProcessWithoutNullStreams | null = null;
  let closed = false;
  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;
    const errors: unknown[] = [];
    try {
      await stopGitCredentialCacheDaemon(daemon, socketPath, send);
    } catch (error) {
      errors.push(error);
      daemon?.kill();
      try {
        if (daemon) {
          await waitForChildExit(daemon, CREDENTIAL_CACHE_OPERATION_TIMEOUT_MS);
        }
      } catch (exitError) {
        errors.push(exitError);
      }
    }
    try {
      writeFileSync(gitConfigPath, originalGitConfig);
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
  }

  try {
    mkdirSync(hooksPath, { recursive: true });
    writeFileSync(askPassPath, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    daemon = await startDaemon(socketPath, owner);
    await owner.storeGitCredential(socketPath, send);
    run(["config", "--local", "credential.helper", ""]);
    run([
      "config",
      "--local",
      "--add",
      "credential.helper",
      `cache --timeout=${CREDENTIAL_CACHE_TTL_SECONDS} --socket=${socketPath}`,
    ]);
    run(["config", "--local", "core.hooksPath", hooksPath]);
    run(["config", "--local", "core.askPass", askPassPath]);
    run(["config", "--local", "credential.interactive", "never"]);
    run(["config", "--local", `http.https://${GITHUB_HOST}/.extraHeader`, ""]);
  } catch (error) {
    try {
      await close();
    } catch (rollbackError) {
      // eslint-disable-next-line preserve-caught-error -- both errors are retained as AggregateError entries
      throw new AggregateError(
        [error, rollbackError],
        "Git credential lease setup failed and rollback also failed",
      );
    }
    throw error;
  }

  return {
    socketPath,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      await close();
    },
  };
}

async function runGitHubOperator(
  args: string[],
  owner: GitHubCredentialOwner,
): Promise<GitHubCliCommandResult> {
  try {
    return await owner.runOperator({
      args,
      cwd: process.cwd(),
      host: GITHUB_HOST,
      timeout: GITHUB_CLI_TIMEOUT_MS,
    });
  } catch (error) {
    return { succeeded: false, output: owner.scrub(formatCommandError(error)) };
  }
}

function assertSameGitHubCredential(
  expected: GitHubCredentialOwner,
  actual: GitHubCredentialOwner,
  phase: "before" | "after",
): void {
  if (!expected.sameCredential(actual)) {
    throw new Error(
      `The active ${GITHUB_HOST} account or token changed ${phase} exact-repository cleanup`,
    );
  }
}

async function deleteRepoAndVerifyAbsent(
  createdRepo: CreatedGitHubRepository | null,
  expectedOwner: GitHubCredentialOwner,
  runGitHubCommand: GitHubCliCommandRunner = runGitHubOperator,
  readActiveOwner: ActiveGitHubCredentialOwnerReader = readGitHubCredentialOwner,
): Promise<void> {
  if (!createdRepo) {
    return;
  }

  let ownerBefore: GitHubCredentialOwner;
  try {
    ownerBefore = await readActiveOwner();
  } catch (error) {
    throw new Error(
      `Failed to start cleanup of temporary GitHub repo ${createdRepo.fullName}: the active ${GITHUB_HOST} identity could not be proved`,
      { cause: error },
    );
  }
  assertSameGitHubCredential(expectedOwner, ownerBefore, "before");

  const exactRepoEndpoint = `repos/${createdRepo.fullName}`;
  const accessResult = await runGitHubCommand(
    ["api", "--hostname", GITHUB_HOST, exactRepoEndpoint],
    expectedOwner,
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
  const deleteResult = await runGitHubCommand(
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
    expectedOwner,
  );
  const readbackResult = await runGitHubCommand(
    ["api", "--hostname", GITHUB_HOST, exactRepoEndpoint],
    expectedOwner,
  );

  let ownerAfter: GitHubCredentialOwner;
  try {
    ownerAfter = await readActiveOwner();
  } catch (error) {
    throw new Error(
      `Failed to prove cleanup of temporary GitHub repo ${createdRepo.fullName}: the active ${GITHUB_HOST} identity was unavailable after the exact-repository readback`,
      { cause: error },
    );
  }
  assertSameGitHubCredential(expectedOwner, ownerAfter, "after");

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

interface DaemonContextCloseResult {
  stopped: boolean;
  flushed: boolean;
  error: unknown;
}

async function closeDaemonContextForCredentialBoundary(
  ctx: DaemonTestContext,
): Promise<DaemonContextCloseResult> {
  const errors: unknown[] = [];
  let stopped = false;
  let flushed = false;
  try {
    await ctx.client.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await ctx.daemon.daemon.stop();
    stopped = true;
  } catch (error) {
    errors.push(error);
  }
  if (stopped) {
    try {
      await ctx.daemon.daemon.agentManager.flush();
      flushed = true;
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await ctx.daemon.close();
  } catch (error) {
    errors.push(error);
  }
  if (!stopped) {
    try {
      await ctx.daemon.daemon.stop();
      stopped = true;
    } catch (error) {
      errors.push(error);
    }
    if (stopped) {
      try {
        await ctx.daemon.daemon.agentManager.flush();
        flushed = true;
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (stopped && !flushed) {
    try {
      await ctx.daemon.daemon.agentManager.flush();
      flushed = true;
    } catch (error) {
      errors.push(error);
    }
  }
  return { stopped, flushed, error: aggregateCleanupErrors(errors) };
}

function valueContainsCredential(value: unknown, owner: GitHubCredentialOwner): boolean {
  const serialized =
    JSON.stringify(value, (_key, currentValue) => {
      if (currentValue instanceof AggregateError) {
        return {
          ...currentValue,
          name: currentValue.name,
          message: currentValue.message,
          stack: currentValue.stack,
          cause: currentValue.cause,
          errors: currentValue.errors,
        };
      }
      if (currentValue instanceof Error) {
        return {
          ...currentValue,
          name: currentValue.name,
          message: currentValue.message,
          stack: currentValue.stack,
          cause: currentValue.cause,
        };
      }
      return currentValue;
    }) ?? String(value);
  return owner.scrub(serialized) !== serialized;
}

async function pollForMergeReadyPullRequest(
  ctx: DaemonTestContext,
  worktreePath: string,
  observedProtocolValues: unknown[],
): Promise<number> {
  const deadline = Date.now() + 30_000;
  let lastMergeable = "UNKNOWN";
  let lastMergeStateStatus: string | null = null;
  while (Date.now() < deadline) {
    const response = await ctx.client.checkoutPrStatus(worktreePath);
    observedProtocolValues.push(response);
    if (response.error) {
      throw new Error(`Failed to read pull request status: ${response.error.message}`);
    }
    const status = response.status;
    lastMergeable = status?.mergeable ?? "UNKNOWN";
    lastMergeStateStatus = status?.github?.mergeStateStatus ?? null;
    if (
      status?.number &&
      status.mergeable === "MERGEABLE" &&
      (lastMergeStateStatus === "CLEAN" || lastMergeStateStatus === "HAS_HOOKS")
    ) {
      return status.number;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(
    `Timed out waiting for a merge-ready GitHub PR; mergeable=${lastMergeable}, mergeStateStatus=${lastMergeStateStatus}`,
  );
}

describe("checkout ship live GitHub mutation safety", () => {
  const fixtureToken = "fixture-token-not-a-secret";
  const fixtureOwner = createGitHubCredentialOwner("octocat", fixtureToken, async () => ({}));
  const fixtureRepo: CreatedGitHubRepository = {
    id: 12345,
    nodeId: "R_fixtureNodeId",
    fullName: "octocat/checkout-ship-test",
    marker: "paseo-checkout-ship-e2e:fixture-run",
  };
  const readFixtureOwner = async (): Promise<GitHubCredentialOwner> =>
    createGitHubCredentialOwner("octocat", fixtureToken, async () => ({}));
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

  test("GitHub and Git child options remove inherited credentials and bound command timeouts", () => {
    const options = createGitHubCliSyncOptions({
      GH_HOST: "github.example.com",
      GH_TOKEN: fixtureToken,
      NODE_DEBUG: "child_process",
      TOKEN_ALIAS: fixtureToken,
    });
    const gitOptions = createGitSyncOptions("/tmp/fixture-repo", undefined, fixtureOwner);

    expect(options.env.GH_HOST).toBe(GITHUB_HOST);
    expect(options.env.GH_TOKEN).toBeUndefined();
    expect(options.env.NODE_DEBUG).toBeUndefined();
    expect(options.env.TOKEN_ALIAS).toBeUndefined();
    expect(options.timeout).toBe(GITHUB_CLI_TIMEOUT_MS);
    expect(gitOptions.env["GH_TOKEN"]).toBeUndefined();
    expect(gitOptions.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(gitOptions.timeout).toBe(GIT_COMMAND_TIMEOUT_MS);
  });

  test("NODE_DEBUG child diagnostics cannot print the operation credential", () => {
    const script = `
      const { spawnSync } = require("node:child_process");
      ${createTokenFreeChildEnvironment.toString()}
      let token = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => token += chunk);
      process.stdin.on("end", () => {
        const env = createTokenFreeChildEnvironment(
          {
            ...process.env,
            GH_TOKEN: token,
            TOKEN_ALIAS: "prefix-" + token,
            ["TOKEN_" + token]: "alias",
          },
          [token],
        );
        spawnSync(process.execPath, ["-e", "process.stdout.write('ok')"], { env });
      });
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
      env: { ...process.env, NODE_DEBUG: "child_process" },
      input: fixtureToken,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("CHILD_PROCESS");
    expect(result.stderr).not.toContain(fixtureToken);
  });

  test("live process sanitization removes trace controls and credential aliases until restored", () => {
    const credentialAliasKey = `TOKEN_${fixtureToken}`;
    const previousTraceRedact = process.env.GIT_TRACE_REDACT;
    process.env.GIT_TRACE_REDACT = "0";
    process.env[credentialAliasKey] = "alias";

    const restore = sanitizeProcessEnvironmentForCredential(fixtureOwner);
    try {
      expect(process.env.GIT_TRACE_REDACT).toBeUndefined();
      expect(process.env[credentialAliasKey]).toBeUndefined();
      restore();

      expect(process.env.GIT_TRACE_REDACT).toBe("0");
      expect(process.env[credentialAliasKey]).toBe("alias");
    } finally {
      restore();
      delete process.env[credentialAliasKey];
      if (previousTraceRedact === undefined) {
        delete process.env.GIT_TRACE_REDACT;
      } else {
        process.env.GIT_TRACE_REDACT = previousTraceRedact;
      }
    }
  });

  test("operation credentials stay out of argv, errors, and audit logs", async () => {
    let argvError: unknown;
    try {
      executeGit(["remote", "add", "origin", fixtureToken], {
        cwd: "/tmp",
        owner: fixtureOwner,
      });
    } catch (error) {
      argvError = error;
    }
    expect(argvError).toBeInstanceOf(Error);
    expect((argvError as Error).message).not.toContain(fixtureToken);
    expect(
      valueContainsCredential(
        Buffer.from(`x-access-token:${fixtureToken}`).toString("base64"),
        fixtureOwner,
      ),
    ).toBe(true);

    const audit: GitHubRunnerAuditEntry[] = [];
    const failingOwner = createGitHubCredentialOwner("octocat", fixtureToken, async () => {
      throw new Error(`simulated failure containing ${fixtureToken}`);
    });
    const runner = createPinnedGitHubRunner(() => failingOwner, audit);
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

    expect((runnerError as Error).message).not.toContain(fixtureToken);
    expect(JSON.stringify(audit)).not.toContain(fixtureToken);
  });

  test("in-process operator implements the checkout PR command surface", async () => {
    const repoDir = tmpCwd("github-operator-");
    const requests: GitHubApiRequest[] = [];
    const pullRequest = {
      number: 7,
      url: "https://api.github.com/repos/octocat/operator-test/pulls/7",
      html_url: "https://github.com/octocat/operator-test/pull/7",
      title: "Operator test",
      state: "open" as const,
      draft: false,
      base: { ref: "main" },
      head: {
        ref: "ship-loop-ready",
        sha: "abc123",
        repo: { owner: { login: "octocat" } },
      },
      merged_at: null,
      merge_commit_sha: null,
      mergeable: true,
    };
    const owner = createGitHubCredentialOwner("octocat", fixtureToken, async (request) => {
      requests.push(request);
      if (request.endpoint.includes("pulls?")) {
        return [{ number: pullRequest.number }];
      }
      if (request.endpoint.endsWith(`/pulls/${pullRequest.number}/merge`)) {
        return { merged: true, message: "Pull Request successfully merged", sha: "def456" };
      }
      if (request.endpoint.endsWith(`/pulls/${pullRequest.number}`)) {
        return pullRequest;
      }
      if (request.endpoint === "graphql") {
        return { data: {} };
      }
      return { url: pullRequest.url, number: pullRequest.number };
    });
    const runner = createPinnedGitHubRunner(() => owner, []);

    try {
      initGitRepo(repoDir);
      executeGit(["remote", "add", "origin", "https://github.com/octocat/operator-test.git"], {
        cwd: repoDir,
        owner,
      });
      executeGit(["branch", "-m", "ship-loop-ready"], { cwd: repoDir, owner });

      const created = await runner(
        [
          "api",
          "-X",
          "POST",
          "repos/octocat/operator-test/pulls",
          "-f",
          "title=Operator test",
          "-f",
          "head=ship-loop-ready",
          "-f",
          "base=main",
        ],
        { cwd: repoDir },
      );
      expect(JSON.parse(created.stdout)).toEqual({ url: pullRequest.url, number: 7 });

      const viewed = await runner(["pr", "view"], { cwd: repoDir });
      expect(JSON.parse(viewed.stdout)).toMatchObject({
        number: 7,
        state: "OPEN",
        mergeable: "MERGEABLE",
        headRefName: "ship-loop-ready",
      });

      await runner(
        ["api", "graphql", "-f", "query=query Test { viewer { login } }", "-F", "number=7"],
        { cwd: repoDir },
      );
      await runner(["pr", "merge", "7", "--merge"], { cwd: repoDir });

      expect(requests).toContainEqual({
        method: "POST",
        endpoint: "repos/octocat/operator-test/pulls",
        body: { title: "Operator test", head: "ship-loop-ready", base: "main" },
      });
      expect(requests).toContainEqual({
        method: "POST",
        endpoint: "graphql",
        body: { query: "query Test { viewer { login } }", variables: { number: 7 } },
      });
      expect(requests).toContainEqual({
        method: "PUT",
        endpoint: "repos/octocat/operator-test/pulls/7/merge",
        body: { merge_method: "merge" },
      });
      expect(valueContainsCredential(requests, owner)).toBe(false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("credential lease setup rolls back its daemon and directory after configuration fails", async () => {
    const repoDir = tmpCwd("credential-lease-rollback-repo-");
    const credentialDir = realpathSync(mkdtempSync("/tmp/pgh-rollback-"));
    let daemonPid: number | undefined;
    let configurationCalls = 0;
    initGitRepo(repoDir);
    const originalGitConfig = readFileSync(path.join(repoDir, ".git", "config"));

    try {
      await expect(
        createGitCredentialLease(repoDir, fixtureOwner, {
          credentialDir,
          async startDaemon(socketPath, owner) {
            const child = await startGitCredentialCacheDaemon(socketPath, owner);
            daemonPid = child.pid;
            return child;
          },
          execute(args, options) {
            configurationCalls += 1;
            if (configurationCalls === 4) {
              throw new Error("simulated Git configuration failure");
            }
            return executeGit(args, options);
          },
        }),
      ).rejects.toThrow("simulated Git configuration failure");
      expect(configurationCalls).toBe(4);
      expect(readFileSync(path.join(repoDir, ".git", "config"))).toEqual(originalGitConfig);
      expect(existsSync(credentialDir)).toBe(false);
      expect(daemonPid).toBeTypeOf("number");
      expect(() => process.kill(daemonPid as number, 0)).toThrow();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(credentialDir, { recursive: true, force: true });
    }
  });

  test("inconclusive repository creation recovers only the matching run for cleanup", async () => {
    const intendedRepo: IntendedGitHubRepository = {
      fullName: fixtureRepo.fullName,
      marker: fixtureRepo.marker,
    };
    const matchingOwner = createGitHubCredentialOwner("octocat", fixtureToken, async () =>
      JSON.parse(fixtureOwnershipOutput),
    );
    const collisionOwner = createGitHubCredentialOwner("octocat", fixtureToken, async () => ({
      ...JSON.parse(fixtureOwnershipOutput),
      description: "another-run",
    }));
    const absentOwner = createGitHubCredentialOwner("octocat", fixtureToken, async () => {
      throw new GitHubApiError(404, "not found");
    });
    let delayedReadCount = 0;
    const delayedOwner = createGitHubCredentialOwner("octocat", fixtureToken, async () => {
      delayedReadCount += 1;
      if (delayedReadCount === 1) {
        throw new GitHubApiError(404, "not visible yet");
      }
      return JSON.parse(fixtureOwnershipOutput);
    });

    await expect(recoverCreatedRepoForCleanup(null, intendedRepo, matchingOwner)).resolves.toEqual(
      fixtureRepo,
    );
    await expect(
      recoverCreatedRepoForCleanup(null, intendedRepo, absentOwner, { settlementTimeoutMs: 0 }),
    ).rejects.toThrow("Could not certify absence");
    await expect(
      recoverCreatedRepoForCleanup(null, intendedRepo, delayedOwner, {
        settlementTimeoutMs: 100,
        pollIntervalMs: 0,
      }),
    ).resolves.toEqual(fixtureRepo);
    expect(delayedReadCount).toBe(2);
    await expect(recoverCreatedRepoForCleanup(null, intendedRepo, collisionOwner)).rejects.toThrow(
      "run marker does not match",
    );
  });

  test("daemon cleanup flushes after a recovered stop before credential restoration", async () => {
    const events: string[] = [];
    let stopCalls = 0;
    const closeContext = {
      client: {
        async close() {
          events.push("client-close");
        },
      },
      daemon: {
        daemon: {
          async stop() {
            stopCalls += 1;
            events.push(`stop-${stopCalls}`);
            if (stopCalls === 1) {
              throw new Error("simulated first stop failure");
            }
          },
          agentManager: {
            async flush() {
              events.push("flush");
            },
          },
        },
        async close() {
          events.push("test-daemon-close");
        },
      },
    } as unknown as DaemonTestContext;

    const result = await closeDaemonContextForCredentialBoundary(closeContext);

    expect(result.stopped).toBe(true);
    expect(result.flushed).toBe(true);
    expect(result.error).toBeInstanceOf(Error);
    expect(events).toEqual(["client-close", "stop-1", "test-daemon-close", "stop-2", "flush"]);
  });

  test("successful deletion plus same-credential 404 certifies exact-repo cleanup", async () => {
    const calls: string[][] = [];
    const runGitHubCommand: GitHubCliCommandRunner = async (args) => {
      calls.push(args);
      if (args.includes("graphql")) {
        return { succeeded: true, output: fixtureDeleteOutput };
      }
      return calls.length === 1
        ? { succeeded: true, output: fixtureOwnershipOutput }
        : { succeeded: false, output: "HTTP 404: Not Found" };
    };

    await expect(
      deleteRepoAndVerifyAbsent(fixtureRepo, fixtureOwner, runGitHubCommand, readFixtureOwner),
    ).resolves.toBeUndefined();
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

  test("cleanup refuses a name collision or replacement with different immutable ownership", async () => {
    const calls: string[][] = [];
    const runGitHubCommand: GitHubCliCommandRunner = async (args) => {
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

    await expect(
      deleteRepoAndVerifyAbsent(fixtureRepo, fixtureOwner, runGitHubCommand, readFixtureOwner),
    ).rejects.toThrow("immutable repository identity or run marker changed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("graphql");
  });

  test("cleanup is not armed before a successful create returns immutable ownership", async () => {
    let ownerRead = false;
    let commandRun = false;
    const runGitHubCommand: GitHubCliCommandRunner = async () => {
      commandRun = true;
      return { succeeded: false, output: "must not run" };
    };
    const readActiveOwner: ActiveGitHubCredentialOwnerReader = () => {
      ownerRead = true;
      return Promise.resolve(fixtureOwner);
    };

    await expect(
      deleteRepoAndVerifyAbsent(null, fixtureOwner, runGitHubCommand, readActiveOwner),
    ).resolves.toBeUndefined();
    expect(ownerRead).toBe(false);
    expect(commandRun).toBe(false);
  });

  test("failed deletion plus 404 is surfaced instead of certifying cleanup", async () => {
    let apiCalls = 0;
    const runGitHubCommand: GitHubCliCommandRunner = async (args) => {
      if (args.includes("graphql")) {
        return { succeeded: false, output: "HTTP 403: delete_repo scope required" };
      }
      apiCalls += 1;
      return apiCalls === 1
        ? { succeeded: true, output: fixtureOwnershipOutput }
        : { succeeded: false, output: "HTTP 404: Not Found" };
    };

    await expect(
      deleteRepoAndVerifyAbsent(fixtureRepo, fixtureOwner, runGitHubCommand, readFixtureOwner),
    ).rejects.toThrow(
      "Failed to clean up temporary GitHub repo octocat/checkout-ship-test: deletion was not confirmed for its immutable ID and run marker",
    );
  });

  test("404 with lost token access is an inconclusive hard cleanup failure", async () => {
    let apiCalls = 0;
    const runGitHubCommand: GitHubCliCommandRunner = async (args) => {
      if (args.includes("graphql")) {
        return { succeeded: true, output: fixtureDeleteOutput };
      }
      apiCalls += 1;
      return apiCalls === 1
        ? { succeeded: true, output: fixtureOwnershipOutput }
        : { succeeded: false, output: "HTTP 404: Not Found" };
    };
    let ownerReads = 0;
    const readActiveOwner = async (): Promise<GitHubCredentialOwner> => {
      ownerReads += 1;
      if (ownerReads === 1) {
        return readFixtureOwner();
      }
      throw new Error("active token lost access");
    };

    await expect(
      deleteRepoAndVerifyAbsent(fixtureRepo, fixtureOwner, runGitHubCommand, readActiveOwner),
    ).rejects.toThrow(
      "Failed to prove cleanup of temporary GitHub repo octocat/checkout-ship-test: the active github.com identity was unavailable after the exact-repository readback",
    );
  });

  test("GitHub API timeout is bounded and a timed-out delete cannot certify a 404", async () => {
    let apiCalls = 0;
    const timeoutOutput = formatCommandError({ code: "ETIMEDOUT" });
    const runGitHubCommand: GitHubCliCommandRunner = async (args) => {
      if (args.includes("graphql")) {
        return { succeeded: false, output: timeoutOutput };
      }
      apiCalls += 1;
      return apiCalls === 1
        ? { succeeded: true, output: fixtureOwnershipOutput }
        : { succeeded: false, output: "HTTP 404: Not Found" };
    };

    expect(timeoutOutput).toContain(`${GITHUB_CLI_TIMEOUT_MS}ms`);
    await expect(
      deleteRepoAndVerifyAbsent(fixtureRepo, fixtureOwner, runGitHubCommand, readFixtureOwner),
    ).rejects.toThrow("GitHub CLI command timed out");
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
  let operationOwner: GitHubCredentialOwner | null;
  let githubAudit: GitHubRunnerAuditEntry[];
  let daemonLogs: string[];
  let contextClosed: boolean;
  let contextInitialized: boolean;
  let boundLiveOwner: GitHubCredentialOwner | null;
  let restoreProcessEnvironment: (() => void) | null;

  beforeEach(async () => {
    operationOwner = null;
    githubAudit = [];
    daemonLogs = [];
    contextClosed = false;
    contextInitialized = false;
    boundLiveOwner = null;
    restoreProcessEnvironment = null;
    if (process.env[CHECKOUT_SHIP_LIVE_GITHUB_E2E] === "1") {
      boundLiveOwner = await assertCheckoutShipLiveGitHubMutationEnabled();
      restoreProcessEnvironment = sanitizeProcessEnvironmentForCredential(boundLiveOwner);
      operationOwner = boundLiveOwner;
    }
    const github = createGitHubService({
      resolveRepoHost: async () => GITHUB_HOST,
      runner: createPinnedGitHubRunner(() => {
        if (!operationOwner) {
          throw new Error("No checkout ship operation credential is active");
        }
        return operationOwner;
      }, githubAudit),
    });
    const logger = pino(
      { level: "trace" },
      {
        write(message: string) {
          daemonLogs.push(message);
        },
      },
    );
    const daemon = await createTestPaseoDaemon({ github, logger });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    ctx = {
      daemon,
      client,
      cleanup: async () => {
        await client.close();
        await daemon.close();
      },
    };
    contextInitialized = true;
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "test" } });
    } catch (error) {
      const closeResult = await closeDaemonContextForCredentialBoundary(ctx);
      contextClosed = closeResult.stopped && closeResult.flushed;
      if (contextClosed) {
        restoreProcessEnvironment?.();
        restoreProcessEnvironment = null;
      }
      throwCheckoutShipErrors(error, closeResult.error);
    }
  });

  afterEach(async () => {
    if (!contextInitialized) {
      return;
    }
    let teardownError: unknown;
    try {
      operationOwner = null;
      if (!contextClosed) {
        if (restoreProcessEnvironment) {
          const result = await closeDaemonContextForCredentialBoundary(ctx);
          contextClosed = result.stopped && result.flushed;
          teardownError = result.error;
        } else {
          await ctx.cleanup();
        }
      }
    } finally {
      if (contextClosed) {
        restoreProcessEnvironment?.();
        restoreProcessEnvironment = null;
      }
    }
    if (teardownError) {
      throw teardownError;
    }
  }, 60000);

  testWithExplicitLiveGitHubOptIn(
    "runs the full checkout ship loop via checkout RPCs",
    async () => {
      if (!boundLiveOwner) {
        throw new Error("The live GitHub credential was not bound before daemon startup");
      }
      const githubOwner = boundLiveOwner;
      const repoDir = tmpCwd("checkout-ship-");
      const repoName = createTempGithubRepoName("checkout-ship");
      const intendedRepo: IntendedGitHubRepository = {
        fullName: `${githubOwner.login}/${repoName}`,
        marker: `paseo-checkout-ship-e2e:${randomUUID()}`,
      };
      operationOwner = githubOwner;
      let createdRepo: CreatedGitHubRepository | null = null;
      let repoCreateAttempted = false;
      let credentialLease: GitCredentialLease | null = null;
      const gitAudit: string[][] = [];
      let agentId: string | null = null;
      let testError: unknown;
      let repoCleanupError: unknown;
      const observedProtocolValues: unknown[] = [];

      try {
        initGitRepo(repoDir, githubOwner);

        repoCreateAttempted = true;
        createdRepo = await createPrivateRepo(intendedRepo, githubOwner);
        credentialLease = await createGitCredentialLease(repoDir, githubOwner, { audit: gitAudit });

        const credentialFreeRemote = `https://${GITHUB_HOST}/${createdRepo.fullName}.git`;
        executeGit(["remote", "add", "origin", credentialFreeRemote], {
          cwd: repoDir,
          owner: githubOwner,
        });
        expect(
          executeGit(["remote", "get-url", "origin"], { cwd: repoDir, owner: githubOwner }),
        ).toBe(credentialFreeRemote);
        expect(
          valueContainsCredential(
            readFileSync(path.join(repoDir, ".git", "config"), "utf8"),
            githubOwner,
          ),
        ).toBe(false);
        executeGit(["push", "-u", "origin", "main"], {
          cwd: repoDir,
          owner: githubOwner,
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
        observedProtocolValues.push(status);
        expect(status.isGit).toBe(true);
        expect(status.isPaseoOwnedWorktree).toBe(true);
        if (status.isGit) {
          expect(realpathSync(status.repoRoot)).toBe(realpathSync(worktree.worktreePath));
          expect(status.baseRef).toBe("main");
        }
        expect(valueContainsCredential(status, githubOwner)).toBe(false);

        executeGit(["branch", "-m", "ship-loop-ready"], {
          cwd: worktree.worktreePath,
          owner: githubOwner,
        });

        const updatedStatus = await ctx.client.getCheckoutStatus(worktree.worktreePath);
        observedProtocolValues.push(updatedStatus);
        expect(updatedStatus.currentBranch).toBe("ship-loop-ready");

        const readmePath = path.join(worktree.worktreePath, "README.md");
        writeFileSync(readmePath, "init\nship loop update\n");

        const diffUncommitted = await ctx.client.getCheckoutDiff(worktree.worktreePath, {
          mode: "uncommitted",
        });
        observedProtocolValues.push(diffUncommitted);
        expect(diffUncommitted.error).toBeNull();
        expect(diffUncommitted.files.length).toBeGreaterThan(0);

        const timelineBeforeCommit = ctx.daemon.daemon.agentManager.getTimeline(agent.id).length;
        const commitResult = await ctx.client.checkoutCommit(worktree.worktreePath, {
          addAll: true,
        });
        observedProtocolValues.push(commitResult);
        expect(commitResult.error).toBeNull();
        expect(commitResult.success).toBe(true);
        const timelineAfterCommit = ctx.daemon.daemon.agentManager.getTimeline(agent.id).length;
        expect(timelineAfterCommit).toBe(timelineBeforeCommit);

        const diffAfterCommit = await ctx.client.getCheckoutDiff(worktree.worktreePath, {
          mode: "uncommitted",
        });
        observedProtocolValues.push(diffAfterCommit);
        expect(diffAfterCommit.files.length).toBe(0);

        const baseDiff = await ctx.client.getCheckoutDiff(worktree.worktreePath, {
          mode: "base",
          baseRef: "main",
        });
        observedProtocolValues.push(baseDiff);
        expect(baseDiff.files.length).toBeGreaterThan(0);

        const timelineBeforePr = ctx.daemon.daemon.agentManager.getTimeline(agent.id).length;
        const prCreate = await ctx.client.checkoutPrCreate(worktree.worktreePath, {
          baseRef: "main",
        });
        observedProtocolValues.push(prCreate);
        expect(prCreate.error).toBeNull();
        expect(prCreate.number).not.toBeNull();
        expect(prCreate.url).toBe(
          `https://api.github.com/repos/${createdRepo.fullName}/pulls/${prCreate.number}`,
        );
        const ownershipReadback = GitHubRepositoryOwnershipSchema.parse(
          await githubOwner.request({
            method: "GET",
            endpoint: `repos/${createdRepo.fullName}`,
          }),
        );
        observedProtocolValues.push(ownershipReadback);
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
        expect(githubAudit.every((entry) => entry.login === githubOwner.login)).toBe(true);
        expect(valueContainsCredential(githubAudit, githubOwner)).toBe(false);
        const timelineAfterPr = ctx.daemon.daemon.agentManager.getTimeline(agent.id).length;
        expect(timelineAfterPr).toBe(timelineBeforePr);

        const mergeablePrNumber = await pollForMergeReadyPullRequest(
          ctx,
          worktree.worktreePath,
          observedProtocolValues,
        );
        expect(mergeablePrNumber).toBe(prCreate.number);
        const headCommit = executeGit(["rev-parse", "HEAD"], {
          cwd: worktree.worktreePath,
          owner: githubOwner,
        });

        const mergeResult = await ctx.client.checkoutPrMerge(worktree.worktreePath, {
          method: "merge",
        });
        observedProtocolValues.push(mergeResult);
        expect(mergeResult.error).toBeNull();
        expect(mergeResult.success).toBe(true);

        if (prCreate.number === null) {
          throw new Error("checkoutPrCreate returned success without a PR number");
        }
        const remotePullRequest = GitHubPullRequestSchema.parse(
          await githubOwner.request({
            method: "GET",
            endpoint: `repos/${createdRepo.fullName}/pulls/${prCreate.number}`,
          }),
        );
        observedProtocolValues.push(remotePullRequest);
        expect(remotePullRequest.number).toBe(prCreate.number);
        expect(remotePullRequest.state).toBe("closed");
        expect(remotePullRequest.merged_at).toEqual(expect.any(String));
        expect(remotePullRequest.merge_commit_sha).toEqual(expect.any(String));
        executeGit(["fetch", "origin", "main"], { cwd: repoDir, owner: githubOwner });
        executeGit(["merge-base", "--is-ancestor", headCommit, "FETCH_HEAD"], {
          cwd: repoDir,
          owner: githubOwner,
        });

        const worktreeList = await ctx.client.getPaseoWorktreeList({
          cwd: repoDir,
        });
        observedProtocolValues.push(worktreeList);
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
        observedProtocolValues.push(archiveResult);
        expect(archiveResult.error).toBeNull();
        expect(archiveResult.success).toBe(true);

        // Archiving removes the agent from the active list but leaves the
        // worktree on disk — disk deletion is a separate, explicit step.
        const worktreeListAfter = await ctx.client.getPaseoWorktreeList({
          cwd: repoDir,
        });
        observedProtocolValues.push(worktreeListAfter);
        expect(
          worktreeListAfter.worktrees.some((entry) => entry.worktreePath === worktree.worktreePath),
        ).toBe(true);
        expect(existsSync(worktree.worktreePath)).toBe(true);

        const remainingAgents = await ctx.client.fetchAgents();
        observedProtocolValues.push(remainingAgents);
        expect(remainingAgents.entries.some((entry) => entry.agent.id === agent.id)).toBe(false);
        expect(
          valueContainsCredential({ remotePullRequest, worktreeListAfter, gitAudit }, githubOwner),
        ).toBe(false);
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
        if (repoCreateAttempted) {
          try {
            createdRepo = await recoverCreatedRepoForCleanup(
              createdRepo,
              intendedRepo,
              githubOwner,
            );
            await deleteRepoAndVerifyAbsent(createdRepo, githubOwner);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        try {
          await credentialLease?.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          rmSync(repoDir, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
        const contextCloseResult = await closeDaemonContextForCredentialBoundary(ctx);
        contextClosed = contextCloseResult.stopped && contextCloseResult.flushed;
        if (contextCloseResult.error) {
          cleanupErrors.push(contextCloseResult.error);
        }
        operationOwner = null;
        repoCleanupError = aggregateCleanupErrors(cleanupErrors);
      }

      if (
        valueContainsCredential(
          {
            daemonLogs,
            githubAudit,
            gitAudit,
            observedProtocolValues,
            testError,
            repoCleanupError,
          },
          githubOwner,
        )
      ) {
        throw new Error("The checkout ship operation credential reached an observable surface");
      }
      throwCheckoutShipErrors(testError, repoCleanupError);
    },
    900000,
  );

  test("credential-free GitHub remotes stay token-free in checkout protocol facts", async () => {
    const repoDir = tmpCwd("checkout-ship-token-free-status-");
    const sentinelToken = "sentinel-delete-repo-token";

    try {
      initGitRepo(repoDir);
      const remote = `https://${GITHUB_HOST}/octocat/checkout-ship-token-free.git`;
      executeGit(["remote", "add", "origin", remote], {
        cwd: repoDir,
        owner: createGitHubCredentialOwner("octocat", sentinelToken, async () => ({})),
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
