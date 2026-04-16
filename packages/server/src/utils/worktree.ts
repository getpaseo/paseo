import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "fs";
import { join, basename, dirname, resolve, sep } from "path";
import net from "node:net";
import { createHash } from "node:crypto";
import { createNameId } from "mnemonic-id";
import {
  normalizeBaseRefName,
  readPaseoWorktreeMetadata,
  readPaseoWorktreeRuntimePort,
  writePaseoWorktreeMetadata,
  writePaseoWorktreeRuntimeMetadata,
} from "./worktree-metadata.js";
import { runGitCommand } from "./run-git-command.js";
import { platformBash, spawnProcess } from "./spawn.js";
import { resolvePaseoHome } from "../server/paseo-home.js";
import { parseGitRevParsePath, resolveGitRevParsePath } from "./git-rev-parse-path.js";

interface PaseoConfig {
  worktree?: {
    setup?: string[];
    teardown?: string[];
    terminals?: WorktreeTerminalConfig[];
  };
}

const execAsync = promisify(exec);
const READ_ONLY_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
};

export interface WorktreeConfig {
  branchName: string;
  worktreePath: string;
}

export type WorktreeRuntimeEnv = {
  PASEO_SOURCE_CHECKOUT_PATH: string;
  PASEO_ROOT_PATH: string;
  PASEO_WORKTREE_PATH: string;
  PASEO_BRANCH_NAME: string;
  PASEO_WORKTREE_PORT: string;
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

export interface PaseoWorktreeInfo {
  path: string;
  createdAt: string;
  branchName?: string;
  head?: string;
}

export type PaseoWorktreeOwnership = {
  allowed: boolean;
  repoRoot?: string;
  worktreeRoot?: string;
  worktreePath?: string;
};

interface CreateWorktreeOptions {
  branchName: string;
  cwd: string;
  baseBranch: string;
  worktreeSlug?: string;
  runSetup?: boolean;
  paseoHome?: string;
}

function readPaseoConfig(repoRoot: string): PaseoConfig | null {
  const paseoConfigPath = join(repoRoot, "paseo.json");
  if (!existsSync(paseoConfigPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(paseoConfigPath, "utf8"));
  } catch {
    throw new Error(`Failed to parse paseo.json`);
  }
}

export function getWorktreeSetupCommands(repoRoot: string): string[] {
  const config = readPaseoConfig(repoRoot);
  const setupCommands = config?.worktree?.setup;
  if (!setupCommands || setupCommands.length === 0) {
    return [];
  }
  return setupCommands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0);
}

export function getWorktreeTeardownCommands(repoRoot: string): string[] {
  const config = readPaseoConfig(repoRoot);
  const teardownCommands = config?.worktree?.teardown;
  if (!teardownCommands || teardownCommands.length === 0) {
    return [];
  }
  return teardownCommands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0);
}

export function getWorktreeTerminalSpecs(repoRoot: string): WorktreeTerminalConfig[] {
  const config = readPaseoConfig(repoRoot);
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
      const { stdout } = await runGitCommand(["rev-parse", "--show-toplevel"], {
        cwd: worktreePath,
        env: READ_ONLY_GIT_ENV,
      });
      const topLevel = parseGitRevParsePath(stdout);
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
  // Read paseo.json from the worktree (it will have the same content as the source repo)
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
  const setupEnv = {
    ...process.env,
    ...runtimeEnv,
  };

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

  let worktreePort = readPaseoWorktreeRuntimePort(options.worktreePath);
  if (worktreePort === null) {
    worktreePort = await getAvailablePort();
    const metadata = readPaseoWorktreeMetadata(options.worktreePath);
    if (metadata) {
      writePaseoWorktreeRuntimeMetadata(options.worktreePath, { worktreePort });
    }
  } else {
    await assertPortAvailable(worktreePort);
  }

  return {
    // Source checkout path is the original git repo root (shared across worktrees), not the
    // worktree itself. This allows setup scripts to copy local files (e.g. .env) from the
    // source checkout.
    PASEO_SOURCE_CHECKOUT_PATH: repoRootPath,
    // Backward-compatible alias.
    PASEO_ROOT_PATH: repoRootPath,
    PASEO_WORKTREE_PATH: options.worktreePath,
    PASEO_BRANCH_NAME: branchName,
    PASEO_WORKTREE_PORT: String(worktreePort),
  };
}

export async function runWorktreeTeardownCommands(options: {
  worktreePath: string;
  branchName?: string;
  repoRootPath?: string;
}): Promise<WorktreeTeardownCommandResult[]> {
  // Read paseo.json from the worktree (it will have the same content as the source repo)
  const teardownCommands = getWorktreeTeardownCommands(options.worktreePath);
  if (teardownCommands.length === 0) {
    return [];
  }

  const repoRootPath =
    options.repoRootPath ?? (await inferRepoRootPathFromWorktreePath(options.worktreePath));
  const branchName =
    options.branchName ?? (await resolveBranchNameForWorktreePath(options.worktreePath));
  const worktreePort = readPaseoWorktreeRuntimePort(options.worktreePath);

  const teardownEnv: NodeJS.ProcessEnv = {
    ...process.env,
    // Source checkout path is the original git repo root (shared across worktrees), not the
    // worktree itself. This allows lifecycle scripts to copy or clean resources using paths
    // from the source checkout.
    PASEO_SOURCE_CHECKOUT_PATH: repoRootPath,
    // Backward-compatible alias.
    PASEO_ROOT_PATH: repoRootPath,
    PASEO_WORKTREE_PATH: options.worktreePath,
    PASEO_BRANCH_NAME: branchName,
    ...(worktreePort !== null ? { PASEO_WORKTREE_PORT: String(worktreePort) } : {}),
  };

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
  const { stdout } = await runGitCommand(["rev-parse", "--git-common-dir"], {
    cwd,
    env: READ_ONLY_GIT_ENV,
  });
  const commonDir = resolveGitRevParsePath(cwd, stdout);
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

export async function getPaseoWorktreesRoot(cwd: string, paseoHome?: string): Promise<string> {
  const home = paseoHome ? resolve(paseoHome) : resolvePaseoHome();
  const projectHash = await deriveWorktreeProjectHash(cwd);
  return join(home, "worktrees", projectHash);
}

export async function computeWorktreePath(
  cwd: string,
  slug: string,
  paseoHome?: string,
): Promise<string> {
  const worktreesRoot = await getPaseoWorktreesRoot(cwd, paseoHome);
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

export async function isPaseoOwnedWorktreeCwd(
  cwd: string,
  options?: { paseoHome?: string },
): Promise<PaseoWorktreeOwnership> {
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
  const worktreesRoot = await getPaseoWorktreesRoot(cwd, options?.paseoHome);
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

  const worktrees = await listPaseoWorktrees({ cwd, paseoHome: options?.paseoHome });
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

type ParsedPaseoWorktreeInfo = Omit<PaseoWorktreeInfo, "createdAt">;

function parseWorktreeList(output: string): ParsedPaseoWorktreeInfo[] {
  const entries: ParsedPaseoWorktreeInfo[] = [];
  let current: ParsedPaseoWorktreeInfo | null = null;

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

export async function listPaseoWorktrees({
  cwd,
  paseoHome,
}: {
  cwd: string;
  paseoHome?: string;
}): Promise<PaseoWorktreeInfo[]> {
  const worktreesRoot = await getPaseoWorktreesRoot(cwd, paseoHome);
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

export async function resolvePaseoWorktreeRootForCwd(
  cwd: string,
  options?: { paseoHome?: string },
): Promise<{ repoRoot: string; worktreeRoot: string; worktreePath: string } | null> {
  let gitCommonDir: string;
  try {
    gitCommonDir = await getGitCommonDir(cwd);
  } catch {
    return null;
  }

  const worktreesRoot = await getPaseoWorktreesRoot(cwd, options?.paseoHome);
  const resolvedRoot = normalizePathForOwnership(worktreesRoot) + sep;

  let worktreeRoot: string | null = null;
  try {
    const { stdout } = await runGitCommand(["rev-parse", "--show-toplevel"], {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    worktreeRoot = parseGitRevParsePath(stdout);
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

  const knownWorktrees = await listPaseoWorktrees({
    cwd,
    paseoHome: options?.paseoHome,
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

export async function deletePaseoWorktree({
  cwd,
  worktreePath,
  worktreeSlug,
  paseoHome,
}: {
  cwd: string;
  worktreePath?: string;
  worktreeSlug?: string;
  paseoHome?: string;
}): Promise<void> {
  if (!worktreePath && !worktreeSlug) {
    throw new Error("worktreePath or worktreeSlug is required");
  }

  const worktreesRoot = await getPaseoWorktreesRoot(cwd, paseoHome);
  const resolvedRoot = normalizePathForOwnership(worktreesRoot) + sep;
  const requestedPath = worktreePath ?? join(worktreesRoot, worktreeSlug!);
  const resolvedRequested = normalizePathForOwnership(requestedPath);
  const resolvedWorktree =
    (await resolvePaseoWorktreeRootForCwd(requestedPath, { paseoHome }))?.worktreePath ??
    resolvedRequested;

  if (!resolvedWorktree.startsWith(resolvedRoot)) {
    throw new Error("Refusing to delete non-Paseo worktree");
  }

  await runWorktreeTeardownCommands({
    worktreePath: resolvedWorktree,
  });

  await runGitCommand(["worktree", "remove", resolvedWorktree, "--force"], {
    cwd,
    timeout: 120_000,
  });

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
  paseoHome,
}: CreateWorktreeOptions): Promise<WorktreeConfig> {
  // Validate branch name
  const validation = validateBranchSlug(branchName);
  if (!validation.valid) {
    throw new Error(`Invalid branch name: ${validation.error}`);
  }

  const normalizedBaseBranch = baseBranch ? normalizeBaseRefName(baseBranch) : "";
  if (!normalizedBaseBranch) {
    throw new Error("Base branch is required when creating a Paseo worktree");
  }
  if (normalizedBaseBranch === "HEAD") {
    throw new Error("Base branch cannot be HEAD when creating a Paseo worktree");
  }

  // Resolve the base branch - prefer origin/{branch}, then fall back to local
  let resolvedBaseBranch = normalizedBaseBranch;
  try {
    await runGitCommand(["rev-parse", "--verify", `origin/${normalizedBaseBranch}`], { cwd });
    resolvedBaseBranch = `origin/${normalizedBaseBranch}`;
  } catch {
    try {
      await runGitCommand(["rev-parse", "--verify", normalizedBaseBranch], { cwd });
    } catch {
      throw new Error(`Base branch not found: ${normalizedBaseBranch}`);
    }
  }

  let worktreePath: string;
  const desiredSlug = worktreeSlug || generateWorktreeSlug();

  worktreePath = join(await getPaseoWorktreesRoot(cwd, paseoHome), desiredSlug);
  mkdirSync(dirname(worktreePath), { recursive: true });

  // Check if branch already exists
  let branchExists = false;
  try {
    await runGitCommand(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
      cwd,
    });
    branchExists = true;
  } catch {
    branchExists = false;
  }

  // Always create a new branch for the worktree
  // If branchName already exists, use it as base and create worktree-slug as branch name
  // If branchName doesn't exist, create it from baseBranch (resolved to remote if needed)
  const base = branchExists ? branchName : resolvedBaseBranch;
  const candidateBranch = branchExists ? desiredSlug : branchName;

  // Find unique branch name if collision
  let newBranchName = candidateBranch;
  let suffix = 1;
  while (true) {
    try {
      await runGitCommand(["show-ref", "--verify", "--quiet", `refs/heads/${newBranchName}`], {
        cwd,
      });
      // Branch exists, try with suffix
      newBranchName = `${candidateBranch}-${suffix}`;
      suffix++;
    } catch {
      break;
    }
  }

  // Also handle worktree path collision
  let finalWorktreePath = worktreePath;
  let pathSuffix = 1;
  while (existsSync(finalWorktreePath)) {
    finalWorktreePath = `${worktreePath}-${pathSuffix}`;
    pathSuffix++;
  }

  await runGitCommand(["worktree", "add", finalWorktreePath, "-b", newBranchName, base], {
    cwd,
    timeout: 120_000,
  });
  worktreePath = normalizePathForOwnership(finalWorktreePath);

  writePaseoWorktreeMetadata(worktreePath, { baseRefName: normalizedBaseBranch });

  if (runSetup) {
    await runWorktreeSetupCommands({
      worktreePath,
      branchName: newBranchName,
      cleanupOnFailure: true,
    });
  }

  return {
    branchName: newBranchName,
    worktreePath,
  };
}
