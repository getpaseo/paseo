import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "fs";
import { join, basename, dirname, resolve, sep } from "path";
import net from "node:net";
import { createHash } from "node:crypto";
import { createNameId } from "mnemonic-id";
import {
  normalizeBaseRefName,
  readHubcodeWorktreeMetadata,
  readHubcodeWorktreeRuntimePort,
  writeHubcodeWorktreeMetadata,
  writeHubcodeWorktreeRuntimeMetadata,
} from "./worktree-metadata.js";
import { childEnv } from "./child-env.js";
import { runGitCommand } from "./run-git-command.js";
import { platformBash, spawnProcess } from "./spawn.js";
import { resolveHubcodeHome } from "../server/hubcode-home.js";

interface HubcodeConfig {
  worktree?: {
    setup?: string[];
    teardown?: string[];
    terminals?: WorktreeTerminalConfig[];
  };
  scripts?: Record<string, { command?: string; type?: string; port?: number } | undefined>;
}

export interface PlainScriptConfig {
  type?: undefined;
  command: string;
  port?: undefined;
}

export interface ServiceScriptConfig {
  type: "service";
  command: string;
  port?: number;
}

export type ScriptConfig = PlainScriptConfig | ServiceScriptConfig;

export function isServiceScript(config: ScriptConfig): config is ServiceScriptConfig {
  return "type" in config && config.type === "service";
}

export type WorktreeSource =
  | { kind: "branch-off"; baseBranch: string; newBranchName: string }
  | { kind: "checkout-branch"; branchName: string }
  | {
      kind: "checkout-github-pr";
      githubPrNumber: number;
      headRef: string;
      baseRefName: string;
      localBranchName?: string;
      pushRemoteUrl?: string;
    };

export class BranchAlreadyCheckedOutError extends Error {
  readonly branchName: string;

  constructor(branchName: string) {
    super(`Branch already checked out: ${branchName}`);
    this.name = "BranchAlreadyCheckedOutError";
    this.branchName = branchName;
  }
}

export class UnknownBranchError extends Error {
  readonly branchName: string;
  readonly cwd: string;

  constructor(params: { branchName: string; cwd: string }) {
    super(`Unknown branch: ${params.branchName}`);
    this.name = "UnknownBranchError";
    this.branchName = params.branchName;
    this.cwd = params.cwd;
  }
}

const execAsync = promisify(exec);
const READ_ONLY_GIT_ENV: NodeJS.ProcessEnv = childEnv({ GIT_OPTIONAL_LOCKS: "0" });

export interface WorktreeConfig {
  branchName: string;
  worktreePath: string;
}

export type WorktreeRuntimeEnv = {
  HUBCODE_SOURCE_CHECKOUT_PATH: string;
  HUBCODE_ROOT_PATH: string;
  HUBCODE_WORKTREE_PATH: string;
  HUBCODE_BRANCH_NAME: string;
  HUBCODE_WORKTREE_PORT: string;
};

export type WorktreeSetupCommandResult = {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
};

export type WorktreeSetupCommandProgressEvent =
  | {
      type: "command_started";
      index: number;
      total: number;
      command: string;
      cwd: string;
    }
  | {
      type: "output";
      index: number;
      total: number;
      command: string;
      cwd: string;
      stream: "stdout" | "stderr";
      chunk: string;
    }
  | {
      type: "command_completed";
      index: number;
      total: number;
      command: string;
      cwd: string;
      exitCode: number | null;
      durationMs: number;
      stdout: string;
      stderr: string;
    };

export interface WorktreeTerminalConfig {
  name?: string;
  command: string;
}

export class WorktreeSetupError extends Error {
  readonly results: WorktreeSetupCommandResult[];

  constructor(message: string, results: WorktreeSetupCommandResult[]) {
    super(message);
    this.name = "WorktreeSetupError";
    this.results = results;
  }
}

export type WorktreeTeardownCommandResult = WorktreeSetupCommandResult;

export class WorktreeTeardownError extends Error {
  readonly results: WorktreeTeardownCommandResult[];

  constructor(message: string, results: WorktreeTeardownCommandResult[]) {
    super(message);
    this.name = "WorktreeTeardownError";
    this.results = results;
  }
}

export interface HubcodeWorktreeInfo {
  path: string;
  createdAt: string;
  branchName?: string;
  head?: string;
}

export type HubcodeWorktreeOwnership = {
  allowed: boolean;
  repoRoot?: string;
  worktreeRoot?: string;
  worktreePath?: string;
};

interface CreateWorktreeOptions {
  branchName?: string;
  cwd: string;
  baseBranch?: string;
  worktreeSlug?: string;
  runSetup?: boolean;
  hubcodeHome?: string;
  /**
   * Optional discriminated source describing how the worktree should be
   * provisioned. When supplied, takes precedence over the legacy
   * branchName/baseBranch fields used by older callers.
   */
  source?: WorktreeSource;
}

function readHubcodeConfig(repoRoot: string): HubcodeConfig | null {
  const hubcodeConfigPath = join(repoRoot, "hubcode.json");
  if (!existsSync(hubcodeConfigPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(hubcodeConfigPath, "utf8"));
  } catch (error) {
    // Surface both the absolute path and the underlying parse detail so
    // callers (setup/teardown/terminal scripts) report something actionable
    // instead of a bare "Failed to parse hubcode.json".
    const detail = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(`Failed to parse hubcode.json at ${hubcodeConfigPath}: ${detail}`, {
      cause: error,
    });
    throw wrapped;
  }
}

// Normalizes a hubcode.json `setup`/`teardown` field into a list of commands.
// The field can be a single string ("npm install") or a heterogeneous array
// (e.g. mixed strings + accidental nulls/numbers). Anything non-string is dropped.
function normalizeLifecycleCommands(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((cmd): cmd is string => typeof cmd === "string" && cmd.trim().length > 0);
}

export function getWorktreeSetupCommands(repoRoot: string): string[] {
  const config = readHubcodeConfig(repoRoot);
  return normalizeLifecycleCommands(config?.worktree?.setup);
}

export function getWorktreeTeardownCommands(repoRoot: string): string[] {
  const config = readHubcodeConfig(repoRoot);
  return normalizeLifecycleCommands(config?.worktree?.teardown);
}

export function getWorktreeTerminalSpecs(repoRoot: string): WorktreeTerminalConfig[] {
  const config = readHubcodeConfig(repoRoot);
  const terminals = config?.worktree?.terminals;
  if (!Array.isArray(terminals) || terminals.length === 0) {
    return [];
  }

  const specs: WorktreeTerminalConfig[] = [];
  for (const terminal of terminals) {
    if (!terminal || typeof terminal !== "object") {
      continue;
    }

    const rawCommand = terminal.command;
    if (typeof rawCommand !== "string") {
      continue;
    }
    const command = rawCommand.trim();
    if (!command) {
      continue;
    }

    const rawName = terminal.name;
    const name =
      typeof rawName === "string" && rawName.trim().length > 0 ? rawName.trim() : undefined;

    specs.push({
      ...(name ? { name } : {}),
      command,
    });
  }

  return specs;
}

async function execSetupCommand(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<WorktreeSetupCommandResult> {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: options.cwd,
      env: options.env,
      ...(process.platform === "win32" ? {} : { shell: "/bin/bash" }),
    });
    return {
      command,
      cwd: options.cwd,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      exitCode: 0,
      durationMs: Date.now() - startedAt,
    };
  } catch (error: any) {
    return {
      command,
      cwd: options.cwd,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? (error instanceof Error ? error.message : String(error)),
      exitCode: typeof error?.code === "number" ? error.code : null,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function execSetupCommandStreamed(options: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  index: number;
  total: number;
  onEvent?: (event: WorktreeSetupCommandProgressEvent) => void;
}): Promise<WorktreeSetupCommandResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let settled = false;

    const finish = (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      const result: WorktreeSetupCommandResult = {
        command: options.command,
        cwd: options.cwd,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode,
        durationMs: Date.now() - startedAt,
      };
      options.onEvent?.({
        type: "command_completed",
        index: options.index,
        total: options.total,
        command: options.command,
        cwd: options.cwd,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      resolve(result);
    };

    options.onEvent?.({
      type: "command_started",
      index: options.index,
      total: options.total,
      command: options.command,
      cwd: options.cwd,
    });

    const shell = platformBash();
    const child = spawnProcess(shell.command, [...shell.flag, options.command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdoutChunks.push(text);
      options.onEvent?.({
        type: "output",
        index: options.index,
        total: options.total,
        command: options.command,
        cwd: options.cwd,
        stream: "stdout",
        chunk: text,
      });
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderrChunks.push(text);
      options.onEvent?.({
        type: "output",
        index: options.index,
        total: options.total,
        command: options.command,
        cwd: options.cwd,
        stream: "stderr",
        chunk: text,
      });
    });

    child.on("error", (error) => {
      stderrChunks.push(error instanceof Error ? error.message : String(error));
      finish(null);
    });

    child.on("close", (code) => {
      finish(typeof code === "number" ? code : null);
    });
  });
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire available port")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      const message =
        error?.code === "EADDRINUSE"
          ? `Persisted worktree port ${port} is already in use`
          : error instanceof Error
            ? error.message
            : String(error);
      reject(new Error(message));
    });
    server.listen(port, () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
}

async function inferRepoRootPathFromWorktreePath(worktreePath: string): Promise<string> {
  try {
    const commonDir = await getGitCommonDir(worktreePath);
    const normalizedCommonDir = normalizePathForOwnership(commonDir);
    // Normal repo/worktree: common dir is <repoRoot>/.git
    if (basename(normalizedCommonDir) === ".git") {
      return dirname(normalizedCommonDir);
    }
    // Bare repo: common dir is the repo dir itself
    return normalizedCommonDir;
  } catch {
    // Fallback: best-effort resolve toplevel (will be the worktree root in typical cases)
    try {
      const { stdout } = await runGitCommand(
        ["rev-parse", "--path-format=absolute", "--show-toplevel"],
        {
          cwd: worktreePath,
          env: READ_ONLY_GIT_ENV,
        },
      );
      const topLevel = stdout.trim();
      if (topLevel) {
        return normalizePathForOwnership(topLevel);
      }
    } catch {
      // ignore
    }
    return normalizePathForOwnership(worktreePath);
  }
}

export async function runWorktreeSetupCommands(options: {
  worktreePath: string;
  branchName: string;
  cleanupOnFailure: boolean;
  repoRootPath?: string;
  runtimeEnv?: WorktreeRuntimeEnv;
  onEvent?: (event: WorktreeSetupCommandProgressEvent) => void;
}): Promise<WorktreeSetupCommandResult[]> {
  // Read hubcode.json from the worktree (it will have the same content as the source repo)
  const setupCommands = getWorktreeSetupCommands(options.worktreePath);
  if (setupCommands.length === 0) {
    return [];
  }

  const runtimeEnv =
    options.runtimeEnv ??
    (await resolveWorktreeRuntimeEnv({
      worktreePath: options.worktreePath,
      branchName: options.branchName,
      ...(options.repoRootPath ? { repoRootPath: options.repoRootPath } : {}),
    }));
  const setupEnv = childEnv(runtimeEnv);

  const results: WorktreeSetupCommandResult[] = [];
  for (const [index, cmd] of setupCommands.entries()) {
    const result = options.onEvent
      ? await execSetupCommandStreamed({
          command: cmd,
          cwd: options.worktreePath,
          env: setupEnv,
          index: index + 1,
          total: setupCommands.length,
          onEvent: options.onEvent,
        })
      : await execSetupCommand(cmd, {
          cwd: options.worktreePath,
          env: setupEnv,
        });
    results.push(result);

    if (result.exitCode !== 0) {
      if (options.cleanupOnFailure) {
        try {
          await runGitCommand(["worktree", "remove", options.worktreePath, "--force"], {
            cwd: options.worktreePath,
            timeout: 120_000,
          });
        } catch {
          rmSync(options.worktreePath, { recursive: true, force: true });
        }
      }
      throw new WorktreeSetupError(
        `Worktree setup command failed: ${cmd}\n${result.stderr}`.trim(),
        results,
      );
    }
  }

  return results;
}

async function resolveBranchNameForWorktreePath(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await runGitCommand(["branch", "--show-current"], {
      cwd: worktreePath,
      env: READ_ONLY_GIT_ENV,
    });
    const branchName = stdout.trim();
    if (branchName.length > 0) {
      return branchName;
    }
  } catch {
    // ignore
  }

  return basename(worktreePath);
}

export async function resolveWorktreeRuntimeEnv(options: {
  worktreePath: string;
  branchName?: string;
  repoRootPath?: string;
}): Promise<WorktreeRuntimeEnv> {
  const repoRootPath =
    options.repoRootPath ?? (await inferRepoRootPathFromWorktreePath(options.worktreePath));
  const branchName =
    options.branchName ?? (await resolveBranchNameForWorktreePath(options.worktreePath));

  let worktreePort = readHubcodeWorktreeRuntimePort(options.worktreePath);
  if (worktreePort === null) {
    worktreePort = await getAvailablePort();
    const metadata = readHubcodeWorktreeMetadata(options.worktreePath);
    if (metadata) {
      writeHubcodeWorktreeRuntimeMetadata(options.worktreePath, { worktreePort });
    }
  } else {
    await assertPortAvailable(worktreePort);
  }

  return {
    // Source checkout path is the original git repo root (shared across worktrees), not the
    // worktree itself. This allows setup scripts to copy local files (e.g. .env) from the
    // source checkout.
    HUBCODE_SOURCE_CHECKOUT_PATH: repoRootPath,
    // Backward-compatible alias.
    HUBCODE_ROOT_PATH: repoRootPath,
    HUBCODE_WORKTREE_PATH: options.worktreePath,
    HUBCODE_BRANCH_NAME: branchName,
    HUBCODE_WORKTREE_PORT: String(worktreePort),
  };
}

export async function runWorktreeTeardownCommands(options: {
  worktreePath: string;
  branchName?: string;
  repoRootPath?: string;
}): Promise<WorktreeTeardownCommandResult[]> {
  // Read hubcode.json from the worktree (it will have the same content as the source repo)
  const teardownCommands = getWorktreeTeardownCommands(options.worktreePath);
  if (teardownCommands.length === 0) {
    return [];
  }

  const repoRootPath =
    options.repoRootPath ?? (await inferRepoRootPathFromWorktreePath(options.worktreePath));
  const branchName =
    options.branchName ?? (await resolveBranchNameForWorktreePath(options.worktreePath));
  const worktreePort = readHubcodeWorktreeRuntimePort(options.worktreePath);

  const teardownEnv: NodeJS.ProcessEnv = childEnv({
    // Source checkout path is the original git repo root (shared across worktrees), not the
    // worktree itself. This allows lifecycle scripts to copy or clean resources using paths
    // from the source checkout.
    HUBCODE_SOURCE_CHECKOUT_PATH: repoRootPath,
    // Backward-compatible alias.
    HUBCODE_ROOT_PATH: repoRootPath,
    HUBCODE_WORKTREE_PATH: options.worktreePath,
    HUBCODE_BRANCH_NAME: branchName,
    ...(worktreePort !== null ? { HUBCODE_WORKTREE_PORT: String(worktreePort) } : {}),
  });

  const results: WorktreeTeardownCommandResult[] = [];
  for (const cmd of teardownCommands) {
    const result = await execSetupCommand(cmd, {
      cwd: options.worktreePath,
      env: teardownEnv,
    });
    results.push(result);

    if (result.exitCode !== 0) {
      throw new WorktreeTeardownError(
        `Worktree teardown command failed: ${cmd}\n${result.stderr}`.trim(),
        results,
      );
    }
  }

  return results;
}

/**
 * Get the git common directory (shared across worktrees) for a given cwd.
 * This is where refs, objects, etc. are stored.
 */
export async function getGitCommonDir(cwd: string): Promise<string> {
  const { stdout } = await runGitCommand(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd,
      env: READ_ONLY_GIT_ENV,
    },
  );
  const commonDir = stdout.trim();
  if (!commonDir) {
    throw new Error("Not in a git repository");
  }
  return commonDir;
}

/**
 * Validate that a string is a valid git branch name slug
 * Must be lowercase, alphanumeric, hyphens only
 */
export function validateBranchSlug(slug: string): {
  valid: boolean;
  error?: string;
} {
  if (!slug || slug.length === 0) {
    return { valid: false, error: "Branch name cannot be empty" };
  }

  if (slug.length > 100) {
    return { valid: false, error: "Branch name too long (max 100 characters)" };
  }

  // Check for valid characters: lowercase letters, numbers, hyphens, forward slashes
  const validPattern = /^[a-z0-9-/]+$/;
  if (!validPattern.test(slug)) {
    return {
      valid: false,
      error:
        "Branch name must contain only lowercase letters, numbers, hyphens, and forward slashes",
    };
  }

  // Cannot start or end with hyphen
  if (slug.startsWith("-") || slug.endsWith("-")) {
    return {
      valid: false,
      error: "Branch name cannot start or end with a hyphen",
    };
  }

  // Cannot have consecutive hyphens
  if (slug.includes("--")) {
    return { valid: false, error: "Branch name cannot have consecutive hyphens" };
  }

  return { valid: true };
}

const MAX_SLUG_LENGTH = 50;

/**
 * Convert string to kebab-case for branch names
 */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length <= MAX_SLUG_LENGTH) {
    return slug;
  }

  // Truncate at word boundary (hyphen) if possible
  const truncated = slug.slice(0, MAX_SLUG_LENGTH);
  const lastHyphen = truncated.lastIndexOf("-");
  if (lastHyphen > MAX_SLUG_LENGTH / 2) {
    return truncated.slice(0, lastHyphen);
  }
  return truncated.replace(/-+$/, "");
}

function generateWorktreeSlug(): string {
  return createNameId();
}

const WORKTREE_PROJECT_HASH_LENGTH = 8;

function deriveShortAlphanumericHash(value: string): string {
  const digest = createHash("sha256").update(value).digest();
  let hashValue = 0n;
  for (let index = 0; index < 8; index += 1) {
    hashValue = (hashValue << 8n) | BigInt(digest[index] ?? 0);
  }
  return hashValue.toString(36).padStart(13, "0").slice(0, WORKTREE_PROJECT_HASH_LENGTH);
}

export async function deriveWorktreeProjectHash(cwd: string): Promise<string> {
  try {
    const commonDir = await getGitCommonDir(cwd);
    const normalizedCommonDir = normalizePathForOwnership(commonDir);
    const repoRoot =
      basename(normalizedCommonDir) === ".git" ? dirname(normalizedCommonDir) : normalizedCommonDir;
    return deriveShortAlphanumericHash(repoRoot);
  } catch {
    return deriveShortAlphanumericHash(normalizePathForOwnership(cwd));
  }
}

export async function getHubcodeWorktreesRoot(cwd: string, hubcodeHome?: string): Promise<string> {
  const home = hubcodeHome ? resolve(hubcodeHome) : resolveHubcodeHome();
  const projectHash = await deriveWorktreeProjectHash(cwd);
  return join(home, "worktrees", projectHash);
}

export async function computeWorktreePath(
  cwd: string,
  slug: string,
  hubcodeHome?: string,
): Promise<string> {
  const worktreesRoot = await getHubcodeWorktreesRoot(cwd, hubcodeHome);
  return join(worktreesRoot, slug);
}

function normalizePathForOwnership(input: string): string {
  try {
    return realpathSync(input);
  } catch {
    return resolve(input);
  }
}

function resolveRepoRootFromGitCommonDir(commonDir: string): string {
  const normalizedCommonDir = normalizePathForOwnership(commonDir);
  return basename(normalizedCommonDir) === ".git"
    ? dirname(normalizedCommonDir)
    : normalizedCommonDir;
}

export async function isHubcodeOwnedWorktreeCwd(
  cwd: string,
  options?: { hubcodeHome?: string },
): Promise<HubcodeWorktreeOwnership> {
  let gitCommonDir: string;
  try {
    gitCommonDir = await getGitCommonDir(cwd);
  } catch {
    return {
      allowed: false,
      worktreePath: normalizePathForOwnership(cwd),
    };
  }
  const repoRoot = resolveRepoRootFromGitCommonDir(gitCommonDir);
  const worktreesRoot = await getHubcodeWorktreesRoot(cwd, options?.hubcodeHome);
  const resolvedRoot = normalizePathForOwnership(worktreesRoot) + sep;
  const resolvedCwd = normalizePathForOwnership(cwd);

  if (!resolvedCwd.startsWith(resolvedRoot)) {
    return {
      allowed: false,
      repoRoot,
      worktreeRoot: worktreesRoot,
      worktreePath: resolvedCwd,
    };
  }

  const worktrees = await listHubcodeWorktrees({ cwd, hubcodeHome: options?.hubcodeHome });
  const allowed = worktrees.some((entry) => {
    const worktreePath = resolve(entry.path);
    return resolvedCwd === worktreePath || resolvedCwd.startsWith(worktreePath + sep);
  });
  return {
    allowed,
    repoRoot,
    worktreeRoot: worktreesRoot,
    worktreePath: resolvedCwd,
  };
}

type ParsedHubcodeWorktreeInfo = Omit<HubcodeWorktreeInfo, "createdAt">;

function parseWorktreeList(output: string): ParsedHubcodeWorktreeInfo[] {
  const entries: ParsedHubcodeWorktreeInfo[] = [];
  let current: ParsedHubcodeWorktreeInfo | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current?.path) {
        entries.push(current);
      }
      current = { path: line.slice("worktree ".length).trim() };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branchName = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.trim().length === 0) {
      if (current.path) {
        entries.push(current);
      }
      current = null;
    }
  }

  if (current?.path) {
    entries.push(current);
  }

  return entries;
}

function resolveWorktreeCreatedAtIso(worktreePath: string): string {
  try {
    const stats = statSync(worktreePath);
    const birthtimeMs = stats.birthtimeMs;
    const createdAtMs =
      Number.isFinite(birthtimeMs) && birthtimeMs > 0 ? birthtimeMs : stats.ctimeMs;
    return new Date(createdAtMs).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

export async function listHubcodeWorktrees({
  cwd,
  hubcodeHome,
}: {
  cwd: string;
  hubcodeHome?: string;
}): Promise<HubcodeWorktreeInfo[]> {
  const worktreesRoot = await getHubcodeWorktreesRoot(cwd, hubcodeHome);
  const { stdout } = await runGitCommand(["worktree", "list", "--porcelain"], {
    cwd,
    env: READ_ONLY_GIT_ENV,
  });

  const rootPrefix = normalizePathForOwnership(worktreesRoot) + sep;
  return parseWorktreeList(stdout)
    .map((entry) => ({ ...entry, path: normalizePathForOwnership(entry.path) }))
    .filter((entry) => entry.path.startsWith(rootPrefix))
    .map((entry) => ({
      ...entry,
      createdAt: resolveWorktreeCreatedAtIso(entry.path),
    }));
}

export async function resolveHubcodeWorktreeRootForCwd(
  cwd: string,
  options?: { hubcodeHome?: string },
): Promise<{ repoRoot: string; worktreeRoot: string; worktreePath: string } | null> {
  let gitCommonDir: string;
  try {
    gitCommonDir = await getGitCommonDir(cwd);
  } catch {
    return null;
  }

  const worktreesRoot = await getHubcodeWorktreesRoot(cwd, options?.hubcodeHome);
  const resolvedRoot = normalizePathForOwnership(worktreesRoot) + sep;

  let worktreeRoot: string | null = null;
  try {
    const { stdout } = await runGitCommand(
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      {
        cwd,
        env: READ_ONLY_GIT_ENV,
      },
    );
    const trimmed = stdout.trim();
    worktreeRoot = trimmed.length > 0 ? trimmed : null;
  } catch {
    worktreeRoot = null;
  }

  if (!worktreeRoot) {
    return null;
  }

  const resolvedWorktreeRoot = normalizePathForOwnership(worktreeRoot);
  if (!resolvedWorktreeRoot.startsWith(resolvedRoot)) {
    return null;
  }

  const knownWorktrees = await listHubcodeWorktrees({
    cwd,
    hubcodeHome: options?.hubcodeHome,
  });
  const match = knownWorktrees.find((entry) => entry.path === resolvedWorktreeRoot);
  if (!match) {
    return null;
  }

  return {
    repoRoot: gitCommonDir,
    worktreeRoot: worktreesRoot,
    worktreePath: match.path,
  };
}

export async function deleteHubcodeWorktree({
  cwd,
  worktreePath,
  worktreeSlug,
  worktreesRoot,
  hubcodeHome,
}: {
  cwd: string | null;
  worktreePath?: string;
  worktreeSlug?: string;
  worktreesRoot?: string;
  hubcodeHome?: string;
}): Promise<void> {
  if (!worktreePath && !worktreeSlug) {
    throw new Error("worktreePath or worktreeSlug is required");
  }

  let resolvedWorktreesRoot: string;
  if (worktreesRoot) {
    resolvedWorktreesRoot = worktreesRoot;
  } else if (cwd) {
    resolvedWorktreesRoot = await getHubcodeWorktreesRoot(cwd, hubcodeHome);
  } else {
    throw new Error("cwd or worktreesRoot is required to delete a Hubcode worktree");
  }
  const resolvedRoot = normalizePathForOwnership(resolvedWorktreesRoot) + sep;
  const requestedPath = worktreePath ?? join(resolvedWorktreesRoot, worktreeSlug!);
  const resolvedRequested = normalizePathForOwnership(requestedPath);
  const resolvedWorktree =
    (await resolveHubcodeWorktreeRootForCwd(requestedPath, { hubcodeHome }))?.worktreePath ??
    resolvedRequested;

  if (!resolvedWorktree.startsWith(resolvedRoot)) {
    throw new Error("Refusing to delete non-Hubcode worktree");
  }

  await runWorktreeTeardownCommands({
    worktreePath: resolvedWorktree,
  });

  // Recover cleanly from a previously-interrupted archive: if the worktree
  // dir was already removed on disk but git's admin entry was left behind
  // (or vice versa), `git worktree remove --force` exits non-zero with
  // "is not a working tree" / "already exists". Tolerate that and prune
  // the admin side explicitly so the second attempt converges. (Paseo
  // 0.1.60 fix.)
  if (cwd) {
    try {
      await runGitCommand(["worktree", "remove", resolvedWorktree, "--force"], {
        cwd,
        timeout: 120_000,
      });
    } catch {
      // fall through — prune handles the admin side, rmSync the fs side.
    }

    // Prune always: clears dangling admin entries whether or not remove succeeded.
    await runGitCommand(["worktree", "prune"], { cwd, timeout: 60_000 }).catch(() => undefined);
  }

  if (existsSync(resolvedWorktree)) {
    rmSync(resolvedWorktree, { recursive: true, force: true });
  }
}

/**
 * Create a git worktree with proper naming conventions
 */
export async function createWorktree({
  branchName,
  cwd,
  baseBranch,
  worktreeSlug,
  runSetup = true,
  hubcodeHome,
  source,
}: CreateWorktreeOptions): Promise<WorktreeConfig> {
  // Derive a discriminated source if not given. Legacy callers pass
  // branchName/baseBranch which map to a "branch-off" source.
  let resolvedSource: WorktreeSource;
  if (source) {
    resolvedSource = source;
  } else {
    if (!branchName) {
      throw new Error("branchName is required when source is not provided");
    }
    if (!baseBranch) {
      throw new Error("baseBranch is required when source is not provided");
    }
    resolvedSource = {
      kind: "branch-off",
      baseBranch,
      newBranchName: branchName,
    };
  }

  const desiredSlug = worktreeSlug || generateWorktreeSlug();
  const sourcePlan = await resolveWorktreeSourcePlan({
    cwd,
    source: resolvedSource,
    desiredSlug,
  });

  let worktreePath = join(await getHubcodeWorktreesRoot(cwd, hubcodeHome), desiredSlug);
  mkdirSync(dirname(worktreePath), { recursive: true });

  // Handle worktree path collision
  let finalWorktreePath = worktreePath;
  let pathSuffix = 1;
  while (existsSync(finalWorktreePath)) {
    finalWorktreePath = `${worktreePath}-${pathSuffix}`;
    pathSuffix++;
  }

  await runGitCommand(["worktree", "add", finalWorktreePath, ...sourcePlan.addArguments], {
    cwd,
    timeout: 120_000,
  });
  worktreePath = normalizePathForOwnership(finalWorktreePath);

  if (sourcePlan.pushRemote) {
    await configureWorktreePushRemote({
      cwd,
      branchName: sourcePlan.branchName,
      remote: sourcePlan.pushRemote,
    });
  }

  writeHubcodeWorktreeMetadata(worktreePath, { baseRefName: sourcePlan.metadataBaseRefName });

  if (runSetup) {
    await runWorktreeSetupCommands({
      worktreePath,
      branchName: sourcePlan.branchName,
      cleanupOnFailure: true,
    });
  }

  return {
    branchName: sourcePlan.branchName,
    worktreePath,
  };
}

interface ResolveWorktreeSourcePlanOptions {
  cwd: string;
  source: WorktreeSource;
  desiredSlug: string;
}

interface WorktreeSourcePlan {
  branchName: string;
  metadataBaseRefName: string;
  addArguments: string[];
  pushRemote?: {
    name: string;
    url: string;
    headRef: string;
  };
}

async function resolveWorktreeSourcePlan({
  cwd,
  source,
  desiredSlug,
}: ResolveWorktreeSourcePlanOptions): Promise<WorktreeSourcePlan> {
  switch (source.kind) {
    case "branch-off": {
      const branchName = source.newBranchName;
      validateWorktreeBranchName(branchName);
      const normalizedBaseBranch = normalizeRequiredBaseBranch(source.baseBranch);
      const resolvedBaseBranch = await resolveBaseBranchForWorktree(cwd, normalizedBaseBranch);
      const branchExists = await localBranchExists(cwd, branchName);
      const base = branchExists ? branchName : resolvedBaseBranch;
      const candidateBranch = branchExists ? desiredSlug : branchName;
      const newBranchName = await resolveUniqueLocalBranchName(cwd, candidateBranch);

      return {
        branchName: newBranchName,
        metadataBaseRefName: normalizedBaseBranch,
        addArguments: ["-b", newBranchName, base],
      };
    }
    case "checkout-branch": {
      validateWorktreeBranchName(source.branchName);
      if (!(await localBranchExists(cwd, source.branchName))) {
        try {
          await runGitCommand(["fetch", "origin", `${source.branchName}:${source.branchName}`], {
            cwd,
            timeout: 120_000,
          });
        } catch {
          throw new UnknownBranchError({ branchName: source.branchName, cwd });
        }
      }
      if (await isBranchCheckedOut(cwd, source.branchName)) {
        throw new BranchAlreadyCheckedOutError(source.branchName);
      }

      return {
        branchName: source.branchName,
        metadataBaseRefName: source.branchName,
        addArguments: [source.branchName],
      };
    }
    case "checkout-github-pr": {
      const localBranchCandidate = source.localBranchName ?? source.headRef;
      validateWorktreeBranchName(localBranchCandidate);
      const localBranchName = await resolveUniqueLocalBranchName(cwd, localBranchCandidate);
      const normalizedBaseRefName = normalizeRequiredBaseBranch(source.baseRefName);
      await runGitCommand(
        [
          "fetch",
          "origin",
          `refs/pull/${source.githubPrNumber}/head:refs/heads/${localBranchName}`,
          "--force",
        ],
        {
          cwd,
          timeout: 120_000,
        },
      );

      return {
        branchName: localBranchName,
        metadataBaseRefName: normalizedBaseRefName,
        addArguments: [localBranchName],
        ...(source.pushRemoteUrl
          ? {
              pushRemote: {
                name: `hubcode-pr-${source.githubPrNumber}`,
                url: source.pushRemoteUrl,
                headRef: source.headRef,
              },
            }
          : {}),
      };
    }
  }
}

async function configureWorktreePushRemote(options: {
  cwd: string;
  branchName: string;
  remote: {
    name: string;
    url: string;
    headRef: string;
  };
}): Promise<void> {
  await runGitCommand(["config", `remote.${options.remote.name}.url`, options.remote.url], {
    cwd: options.cwd,
  });
  await runGitCommand(
    ["config", `remote.${options.remote.name}.push`, `HEAD:refs/heads/${options.remote.headRef}`],
    { cwd: options.cwd },
  );
  await runGitCommand(["config", `branch.${options.branchName}.remote`, options.remote.name], {
    cwd: options.cwd,
  });
  await runGitCommand(
    ["config", `branch.${options.branchName}.merge`, `refs/heads/${options.remote.headRef}`],
    { cwd: options.cwd },
  );
}

function validateWorktreeBranchName(branchName: string): void {
  const validation = validateBranchSlug(branchName);
  if (!validation.valid) {
    throw new Error(`Invalid branch name: ${validation.error}`);
  }
}

function normalizeRequiredBaseBranch(baseBranch: string): string {
  const normalizedBaseBranch = normalizeBaseRefName(baseBranch);
  if (!normalizedBaseBranch) {
    throw new Error("Base branch is required when creating a Hubcode worktree");
  }
  if (normalizedBaseBranch === "HEAD") {
    throw new Error("Base branch cannot be HEAD when creating a Hubcode worktree");
  }
  return normalizedBaseBranch;
}

async function resolveBaseBranchForWorktree(
  cwd: string,
  normalizedBaseBranch: string,
): Promise<string> {
  try {
    await runGitCommand(["rev-parse", "--verify", `origin/${normalizedBaseBranch}`], { cwd });
    return `origin/${normalizedBaseBranch}`;
  } catch {
    try {
      await runGitCommand(["rev-parse", "--verify", normalizedBaseBranch], { cwd });
      return normalizedBaseBranch;
    } catch {
      throw new Error(`Base branch not found: ${normalizedBaseBranch}`);
    }
  }
}

async function localBranchExists(cwd: string, branchName: string): Promise<boolean> {
  try {
    await runGitCommand(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
      cwd,
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveUniqueLocalBranchName(cwd: string, candidateBranch: string): Promise<string> {
  let newBranchName = candidateBranch;
  let suffix = 1;
  while (await localBranchExists(cwd, newBranchName)) {
    newBranchName = `${candidateBranch}-${suffix}`;
    suffix++;
  }
  return newBranchName;
}

async function isBranchCheckedOut(cwd: string, branchName: string): Promise<boolean> {
  const { stdout } = await runGitCommand(["worktree", "list", "--porcelain"], {
    cwd,
    env: READ_ONLY_GIT_ENV,
  });
  const lines = stdout.split("\n");
  const target = `branch refs/heads/${branchName}`;
  return lines.some((line) => line.trim() === target);
}

interface ResolveExistingWorktreeForSlugOptions {
  slug: string;
  repoRoot: string;
  hubcodeHome?: string;
}

export async function resolveExistingWorktreeForSlug({
  slug,
  repoRoot,
  hubcodeHome,
}: ResolveExistingWorktreeForSlugOptions): Promise<WorktreeConfig | null> {
  const worktrees = await listHubcodeWorktrees({
    cwd: repoRoot,
    hubcodeHome,
  });
  const slugSuffix = `${sep}${slug}`;
  const existingWorktree = worktrees.find((worktree) => worktree.path.endsWith(slugSuffix));
  if (!existingWorktree) {
    return null;
  }

  const { stdout } = await runGitCommand(["branch", "--show-current"], {
    cwd: existingWorktree.path,
    env: READ_ONLY_GIT_ENV,
  });
  const branchName = stdout.trim();
  if (!branchName) {
    throw new Error(`Unable to resolve branch for existing worktree: ${existingWorktree.path}`);
  }

  return {
    branchName,
    worktreePath: existingWorktree.path,
  };
}

export function getScriptConfigs(
  repoRoot: string,
  options?: { logger?: { warn: (obj: object, msg: string) => void } },
): Map<string, ScriptConfig> {
  // Isolate parse failures from the projection pipeline. A single malformed
  // hubcode.json should not break fetch_workspaces / script-status emission
  // for every other workspace — the user already sees a workspace-level
  // failure event; the projection just needs to treat this workspace as
  // having no scripts.
  let config: HubcodeConfig | null = null;
  try {
    config = readHubcodeConfig(repoRoot);
  } catch (err) {
    options?.logger?.warn(
      { repoRoot, err },
      "Failed to parse hubcode.json; treating workspace as having no scripts",
    );
    return new Map();
  }
  const scripts = config?.scripts;
  if (!scripts || typeof scripts !== "object") {
    return new Map();
  }

  const result = new Map<string, ScriptConfig>();
  for (const [name, entry] of Object.entries(scripts)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const rawCommand = entry.command;
    if (typeof rawCommand !== "string") {
      continue;
    }
    const command = rawCommand.trim();
    if (!command) {
      continue;
    }

    const scriptConfig: ScriptConfig =
      entry.type === "service"
        ? {
            type: "service",
            command,
          }
        : { command };

    if (
      isServiceScript(scriptConfig) &&
      typeof entry.port === "number" &&
      Number.isFinite(entry.port)
    ) {
      scriptConfig.port = entry.port;
    }

    result.set(name, scriptConfig);
  }

  return result;
}
