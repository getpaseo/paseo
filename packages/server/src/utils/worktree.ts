import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "fs";
import { rm, stat } from "fs/promises";
import { join, basename, dirname, resolve, sep } from "path";
import net from "node:net";
import { createHash } from "node:crypto";
import * as pty from "node-pty";
import stripAnsi from "strip-ansi";
import { buildStringCommandShellInvocation } from "./string-command-shell.js";
import {
  normalizeBaseRefName,
  readPaseoWorktreeMetadata,
  readPaseoWorktreeRuntimePort,
  writePaseoWorktreeMetadata,
  writePaseoWorktreeRuntimeMetadata,
} from "./worktree-metadata.js";
import { runGitCommand } from "./run-git-command.js";
import { resolvePaseoHome } from "../server/paseo-home.js";
import { ensureNodePtySpawnHelperExecutableForCurrentPlatform } from "../terminal/terminal.js";
import { parseGitRevParsePath, resolveGitRevParsePath } from "./git-rev-parse-path.js";

interface PaseoConfig {
  worktree?: {
    setup?: string[];
    teardown?: string[];
    terminals?: WorktreeTerminalConfig[];
  };
  scripts?: Record<
    string,
    {
      type?: unknown;
      command?: unknown;
      port?: unknown;
    }
  >;
}

const execFileAsync = promisify(execFile);
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

export interface PlainScriptConfig {
  type?: undefined;
  command: string;
  port?: undefined;
}

export interface ServiceScriptConfig {
  type: "service";
  command: string;
  port?: number; // explicit port override, otherwise auto-assigned
}

export type ScriptConfig = PlainScriptConfig | ServiceScriptConfig;

export function isServiceScript(config: ScriptConfig): config is ServiceScriptConfig {
  return "type" in config && config.type === "service";
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

export type WorktreeSource =
  | { kind: "branch-off"; baseBranch: string; newBranchName: string }
  | { kind: "checkout-branch"; branchName: string }
  | {
      kind: "checkout-github-pr";
      githubPrNumber: number;
      headRef: string;
      baseRefName: string;
    };

export interface CreateWorktreeOptions {
  cwd: string;
  worktreeSlug: string;
  source: WorktreeSource;
  runSetup: boolean;
  paseoHome?: string;
}

interface ResolveExistingWorktreeForSlugOptions {
  slug: string;
  repoRoot: string;
  paseoHome?: string;
}

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

export function getScriptConfigs(repoRoot: string): Map<string, ScriptConfig> {
  const config = readPaseoConfig(repoRoot);
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

export function processCarriageReturns(text: string): string {
  if (!text.includes("\r")) {
    return text;
  }

  const output: string[] = [];
  let line: string[] = [];
  let cursor = 0;

  const flushLine = () => {
    output.push(line.join(""));
    line = [];
    cursor = 0;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === "\r") {
      if (text[index + 1] === "\n") {
        flushLine();
        output.push("\n");
        index += 1;
        continue;
      }
      cursor = 0;
      continue;
    }

    if (char === "\n") {
      flushLine();
      output.push("\n");
      continue;
    }

    if (cursor < line.length) {
      line[cursor] = char;
    } else {
      line.push(char);
    }
    cursor += 1;
  }

  if (line.length > 0) {
    output.push(line.join(""));
  }

  return output.join("");
}

async function execSetupCommand(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<WorktreeSetupCommandResult> {
  const startedAt = Date.now();
  const shellInvocation = buildStringCommandShellInvocation({ command });
  try {
    const { stdout, stderr } = await execFileAsync(shellInvocation.shell, shellInvocation.args, {
      cwd: options.cwd,
      env: options.env,
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

    const emitOutput = (stream: "stdout" | "stderr", chunk: string) => {
      const text = stripAnsi(chunk);
      if (!text) {
        return;
      }
      if (stream === "stdout") {
        stdoutChunks.push(text);
      } else {
        stderrChunks.push(text);
      }
      options.onEvent?.({
        type: "output",
        index: options.index,
        total: options.total,
        command: options.command,
        cwd: options.cwd,
        stream,
        chunk: text,
      });
    };

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

    const spawnWithPipes = () => {
      const shellInvocation = buildStringCommandShellInvocation({ command: options.command });
      const child = spawn(shellInvocation.shell, shellInvocation.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout?.on("data", (chunk: Buffer | string) => {
        emitOutput("stdout", chunk.toString());
      });

      child.stderr?.on("data", (chunk: Buffer | string) => {
        emitOutput("stderr", chunk.toString());
      });

      child.on("error", (error) => {
        emitOutput("stderr", error instanceof Error ? error.message : String(error));
        finish(null);
      });

      child.on("close", (code) => {
        finish(typeof code === "number" ? code : null);
      });
    };

    try {
      ensureNodePtySpawnHelperExecutableForCurrentPlatform();
      const shellInvocation = buildStringCommandShellInvocation({ command: options.command });
      const terminal = pty.spawn(shellInvocation.shell, shellInvocation.args, {
        cwd: options.cwd,
        env: options.env,
        name: "xterm-color",
        cols: 120,
        rows: 30,
      });

      terminal.onData((data) => {
        emitOutput("stdout", data);
      });

      terminal.onExit(({ exitCode }) => {
        finish(typeof exitCode === "number" ? exitCode : null);
      });
    } catch (error) {
      emitOutput("stderr", error instanceof Error ? error.message : String(error));
      spawnWithPipes();
    }
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
  const resolvedCwd = normalizePathForOwnership(cwd);

  // repoRoot is best-effort: git may be unreachable from the worktree (e.g. a
  // previous archive attempt removed the admin dir before the working tree
  // could be fully cleaned up). We still want to allow archiving in that case.
  let repoRoot: string | undefined;
  try {
    const gitCommonDir = await getGitCommonDir(cwd);
    repoRoot = resolveRepoRootFromGitCommonDir(gitCommonDir);
  } catch {
    // ignore
  }

  const paseoHome = options?.paseoHome ? resolve(options.paseoHome) : resolvePaseoHome();
  const paseoWorktreesPrefix = normalizePathForOwnership(join(paseoHome, "worktrees")) + sep;

  // Ownership is defined by the path living under $PASEO_HOME/worktrees/<hash>/<slug>[/...].
  // The <hash>/<slug> prefix is Paseo-private — nothing else writes there — so the
  // path shape alone is sufficient proof of ownership, even when git has already
  // forgotten about the worktree.
  if (!resolvedCwd.startsWith(paseoWorktreesPrefix)) {
    return {
      allowed: false,
      ...(repoRoot !== undefined ? { repoRoot } : {}),
      worktreePath: resolvedCwd,
    };
  }

  const relative = resolvedCwd.slice(paseoWorktreesPrefix.length);
  const parts = relative.split(sep).filter((part) => part.length > 0);
  if (parts.length < 2) {
    return {
      allowed: false,
      ...(repoRoot !== undefined ? { repoRoot } : {}),
      worktreePath: resolvedCwd,
    };
  }

  const worktreesRoot = join(paseoHome, "worktrees", parts[0]!);
  return {
    allowed: true,
    ...(repoRoot !== undefined ? { repoRoot } : {}),
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

export async function resolveExistingWorktreeForSlug({
  slug,
  repoRoot,
  paseoHome,
}: ResolveExistingWorktreeForSlugOptions): Promise<WorktreeConfig | null> {
  const worktrees = await listPaseoWorktrees({
    cwd: repoRoot,
    paseoHome,
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
  worktreesRoot,
  paseoHome,
}: {
  cwd: string | null;
  worktreePath?: string;
  worktreeSlug?: string;
  worktreesRoot?: string;
  paseoHome?: string;
}): Promise<void> {
  if (!worktreePath && !worktreeSlug) {
    throw new Error("worktreePath or worktreeSlug is required");
  }

  // Resolve the worktrees-root. With a repo cwd we hash it the normal way; if
  // git has forgotten about the worktree we expect the caller to hand us the
  // path-derived worktreesRoot from the ownership check.
  let resolvedWorktreesRoot: string;
  if (worktreesRoot) {
    resolvedWorktreesRoot = worktreesRoot;
  } else if (cwd) {
    resolvedWorktreesRoot = await getPaseoWorktreesRoot(cwd, paseoHome);
  } else {
    throw new Error("cwd or worktreesRoot is required to delete a Paseo worktree");
  }

  const resolvedRoot = normalizePathForOwnership(resolvedWorktreesRoot) + sep;
  const requestedPath = worktreePath ?? join(resolvedWorktreesRoot, worktreeSlug!);
  const resolvedRequested = normalizePathForOwnership(requestedPath);
  const resolvedWorktree =
    (await resolvePaseoWorktreeRootForCwd(requestedPath, { paseoHome }))?.worktreePath ??
    resolvedRequested;

  if (!resolvedWorktree.startsWith(resolvedRoot)) {
    throw new Error("Refusing to delete non-Paseo worktree");
  }

  if (await pathExists(resolvedWorktree)) {
    await runWorktreeTeardownCommands({
      worktreePath: resolvedWorktree,
    });
  }

  if (cwd) {
    try {
      await runGitCommand(["worktree", "remove", resolvedWorktree, "--force"], {
        cwd,
        timeout: 120_000,
      });
    } catch {
      // `git worktree remove` fails if the admin dir is already gone (e.g. a
      // prior archive attempt removed it before the working tree could be
      // fully cleaned up), or if the repo root has moved. Fall through to the
      // rm retry loop below so the operation stays idempotent.
    }
  }

  await removeDirectoryWithRetries(resolvedWorktree);

  if (cwd) {
    try {
      await runGitCommand(["worktree", "prune"], { cwd, timeout: 30_000 });
    } catch {
      // not critical; git will prune lazily
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function removeDirectoryWithRetries(path: string): Promise<void> {
  if (!(await pathExists(path))) {
    return;
  }

  const delaysMs = [0, 100, 300, 700, 1500];
  let lastError: unknown = null;
  for (const delay of delaysMs) {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      await rm(path, { recursive: true, force: true });
      if (!(await pathExists(path))) {
        return;
      }
      lastError = new Error(`Directory still present after rm: ${path}`);
    } catch (error) {
      lastError = error;
    }
  }

  if (await pathExists(path)) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to remove worktree directory: ${path}`);
  }
}

/**
 * Create a git worktree with proper naming conventions
 */
export const createWorktree = async ({
  cwd,
  source,
  worktreeSlug,
  runSetup,
  paseoHome,
}: CreateWorktreeOptions): Promise<WorktreeConfig> => {
  const sourcePlan = await resolveWorktreeSourcePlan({ cwd, source, desiredSlug: worktreeSlug });
  let worktreePath = join(await getPaseoWorktreesRoot(cwd, paseoHome), worktreeSlug);
  mkdirSync(dirname(worktreePath), { recursive: true });

  // Also handle worktree path collision
  let finalWorktreePath = worktreePath;
  let pathSuffix = 1;
  while (existsSync(finalWorktreePath)) {
    finalWorktreePath = `${worktreePath}-${pathSuffix}`;
    pathSuffix++;
  }

  // Primitive owner for `git worktree add`; callers route through createWorktreeCore.
  await runGitCommand(["worktree", "add", finalWorktreePath, ...sourcePlan.addArguments], {
    cwd,
    timeout: 120_000,
  });
  worktreePath = normalizePathForOwnership(finalWorktreePath);

  writePaseoWorktreeMetadata(worktreePath, { baseRefName: sourcePlan.metadataBaseRefName });

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
};

interface ResolveWorktreeSourcePlanOptions {
  cwd: string;
  source: WorktreeSource;
  desiredSlug: string;
}

interface WorktreeSourcePlan {
  branchName: string;
  metadataBaseRefName: string;
  addArguments: string[];
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
      validateWorktreeBranchName(source.headRef);
      const normalizedBaseRefName = normalizeRequiredBaseBranch(source.baseRefName);
      await runGitCommand(
        [
          "fetch",
          "origin",
          `refs/pull/${source.githubPrNumber}/head:refs/heads/${source.headRef}`,
          "--force",
        ],
        {
          cwd,
          timeout: 120_000,
        },
      );

      return {
        branchName: source.headRef,
        metadataBaseRefName: normalizedBaseRefName,
        addArguments: [source.headRef],
      };
    }
  }
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
    throw new Error("Base branch is required when creating a Paseo worktree");
  }
  if (normalizedBaseBranch === "HEAD") {
    throw new Error("Base branch cannot be HEAD when creating a Paseo worktree");
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
  return parseWorktreeList(stdout).some((entry) => entry.branchName === branchName);
}
