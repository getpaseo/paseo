import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, parse, resolve, sep } from "node:path";
import { parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import { resolveGitRevParsePath } from "./git-rev-parse-path.js";
import { getRealpathAwareRelativePath } from "./path.js";
import { runGitCommand } from "./run-git-command.js";
import { execCommand } from "./spawn.js";

export const WORKTREE_PATH_SCRIPT_TIMEOUT_MS = 30_000;
export const WORKTREE_PATH_SCRIPT_MAX_OUTPUT_BYTES = 4096;
// execCommand's maxBuffer caps stdout and stderr alike. Scripts are told
// to log to stderr, so the process buffer is generous; the 4KB contract
// cap on stdout is enforced on the captured output below instead.
const SCRIPT_PROCESS_MAX_BUFFER_BYTES = 64 * 1024;

const STDERR_TAIL_LENGTH = 500;

export type WorktreePathScriptMode =
  | "branch-off"
  | "checkout-branch"
  | "checkout-change-request"
  | "checkout-github-pr";

/**
 * Context passed to the worktrees.pathScript executable. Every value is
 * always present as a positional argument and as a PASEO_* env var; values
 * that do not apply (no remote, no base ref) are empty strings, never
 * omitted arguments. See public-docs/worktrees.md for the contract.
 */
export interface WorktreePathScriptContext {
  repoPath: string;
  repo: string;
  owner: string;
  remoteRepo: string;
  branchName: string;
  slug: string;
  repoHash: string;
  mode: WorktreePathScriptMode;
  baseRef: string;
  paseoHome: string;
}

export function buildWorktreePathScriptArgv(context: WorktreePathScriptContext): string[] {
  return [
    context.repoPath,
    context.repo,
    context.owner,
    context.remoteRepo,
    context.branchName,
    context.slug,
    context.repoHash,
    context.mode,
    context.baseRef,
    context.paseoHome,
  ];
}

export function buildWorktreePathScriptEnv(
  context: WorktreePathScriptContext,
): Record<string, string> {
  return {
    PASEO_REPO_PATH: context.repoPath,
    PASEO_REPO: context.repo,
    PASEO_OWNER: context.owner,
    PASEO_REMOTE_REPO: context.remoteRepo,
    PASEO_BRANCH_NAME: context.branchName,
    PASEO_WORKTREE_SLUG: context.slug,
    PASEO_REPO_HASH: context.repoHash,
    PASEO_WORKTREE_MODE: context.mode,
    PASEO_BASE_REF: context.baseRef,
    PASEO_HOME: context.paseoHome,
  };
}

// Same derivation as deriveWorktreeProjectHash in worktree.ts (SHA-256 of the
// repo root, first 8 digest bytes as base36, 8 chars). Duplicated here because
// worktree.ts imports this module; keep the two in sync.
export function deriveWorktreeRepoHash(repoPath: string): string {
  const digest = createHash("sha256").update(repoPath).digest();
  let hashValue = 0n;
  for (let index = 0; index < 8; index += 1) {
    hashValue = (hashValue << 8n) | BigInt(digest[index] ?? 0);
  }
  return hashValue.toString(36).padStart(13, "0").slice(0, 8);
}

function normalizeAbsolute(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

async function resolveRepoPath(cwd: string): Promise<string> {
  const { stdout } = await runGitCommand(["rev-parse", "--git-common-dir"], { cwd });
  const commonDir = resolveGitRevParsePath(cwd, stdout);
  if (!commonDir) {
    throw new Error(`Unable to resolve the git common directory for ${cwd}`);
  }
  const normalizedCommonDir = normalizeAbsolute(commonDir);
  return basename(normalizedCommonDir) === ".git"
    ? dirname(normalizedCommonDir)
    : normalizedCommonDir;
}

async function resolvePrimaryRemote(repoPath: string): Promise<{ owner: string; repo: string }> {
  const empty = { owner: "", repo: "" };
  let remoteNames: string[];
  try {
    const { stdout } = await runGitCommand(["remote"], { cwd: repoPath });
    remoteNames = stdout
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
  } catch {
    return empty;
  }
  const primary = remoteNames.includes("origin") ? "origin" : remoteNames[0];
  if (!primary) {
    return empty;
  }
  let remoteUrl: string;
  try {
    const { stdout } = await runGitCommand(["remote", "get-url", primary], { cwd: repoPath });
    remoteUrl = stdout.trim();
  } catch {
    return empty;
  }
  const location = parseGitRemoteLocation(remoteUrl);
  if (!location) {
    return empty;
  }
  const segments = location.path.split("/").filter((segment) => segment.length > 0);
  const repo = segments[segments.length - 1] ?? "";
  if (!repo) {
    return empty;
  }
  return { owner: segments.slice(0, -1).join("/"), repo };
}

export async function deriveWorktreePathScriptContext(options: {
  cwd: string;
  branchName: string;
  slug: string;
  mode: WorktreePathScriptMode;
  baseRef: string;
  paseoHome: string;
}): Promise<WorktreePathScriptContext> {
  const repoPath = await resolveRepoPath(options.cwd);
  const remote = await resolvePrimaryRemote(repoPath);
  return {
    repoPath,
    repo: basename(repoPath),
    owner: remote.owner,
    remoteRepo: remote.repo,
    branchName: options.branchName,
    slug: options.slug,
    repoHash: deriveWorktreeRepoHash(repoPath),
    mode: options.mode,
    baseRef: options.baseRef,
    paseoHome: resolve(options.paseoHome),
  };
}

function isGitWorktreeRoot(candidate: string): boolean {
  return existsSync(resolve(candidate, ".git"));
}

/**
 * Validate a path returned by the script. The script proposes, Paseo
 * disposes: placement logic is arbitrary, placement safety is not. Throws
 * with the reason on any violation; returns the normalized absolute path.
 */
export function validateWorktreeScriptPath(options: {
  candidate: string;
  repoPath: string;
}): string {
  const { candidate, repoPath } = options;
  if (!isAbsolute(candidate)) {
    throw new Error(
      `Worktree path script returned a relative path '${candidate}'; it must print an absolute path`,
    );
  }
  const normalized = normalizeAbsolute(candidate);
  const normalizedRepoPath = normalizeAbsolute(repoPath);

  if (normalized === parse(normalized).root) {
    throw new Error("Worktree path script returned the filesystem root, which is not allowed");
  }
  if (normalized === normalizeAbsolute(homedir())) {
    throw new Error(
      "Worktree path script returned the user's home directory, which is not allowed",
    );
  }
  if (normalized === normalizedRepoPath) {
    throw new Error(
      "Worktree path script returned the repository root itself, which is not allowed",
    );
  }
  if (normalized.split(sep).includes(".git")) {
    throw new Error(`Worktree path script returned a path inside a .git directory: ${normalized}`);
  }
  const relativeToCandidate = getRealpathAwareRelativePath(normalized, normalizedRepoPath);
  if (relativeToCandidate !== null && relativeToCandidate !== "") {
    throw new Error(`Worktree path script returned an ancestor of the repository: ${normalized}`);
  }
  if (existsSync(normalized)) {
    if (statSync(normalized).isDirectory() && !isGitWorktreeRoot(normalized)) {
      throw new Error(
        `Worktree path script returned an existing directory that is not a git worktree: ${normalized}. The script must not create the path it returns; Paseo creates it.`,
      );
    }
    throw new Error(
      `Worktree path script returned a path that already exists: ${normalized}. The script must not create the path it returns; Paseo creates it.`,
    );
  }
  return normalized;
}

interface ExecCommandFailure {
  code?: unknown;
  killed?: unknown;
  stderr?: unknown;
  stdout?: unknown;
}

function describeScriptFailure(script: string, error: unknown): Error {
  const failure = (error ?? {}) as ExecCommandFailure;
  const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
  const tail = stderr.length > STDERR_TAIL_LENGTH ? stderr.slice(-STDERR_TAIL_LENGTH) : stderr;
  let status = "failed to run";
  if (failure.killed === true) {
    status = `timed out after ${WORKTREE_PATH_SCRIPT_TIMEOUT_MS / 1000}s`;
  } else if (typeof failure.code === "number" || typeof failure.code === "string") {
    status = `exited with code ${failure.code}`;
  }
  const detail = tail || (error instanceof Error ? error.message : String(error));
  return new Error(`Worktree path script '${script}' ${status}: ${detail}`, { cause: error });
}

/**
 * Run the configured pathScript and return the validated worktree path.
 * The script must be a pure function of its inputs: it prints one absolute
 * path and creates nothing. Any failure throws; callers fail creation.
 */
export async function resolveWorktreePathFromScript(options: {
  script: string;
  context: WorktreePathScriptContext;
}): Promise<string> {
  const { script, context } = options;
  if (!isAbsolute(script)) {
    throw new Error(
      `worktrees.pathScript must be an absolute path to an executable, got '${script}'`,
    );
  }

  let stdout: string;
  try {
    const result = await execCommand(script, buildWorktreePathScriptArgv(context), {
      cwd: context.repoPath,
      envOverlay: buildWorktreePathScriptEnv(context),
      timeout: WORKTREE_PATH_SCRIPT_TIMEOUT_MS,
      maxBuffer: SCRIPT_PROCESS_MAX_BUFFER_BYTES,
      shell: false,
    });
    stdout = result.stdout;
  } catch (error) {
    throw describeScriptFailure(script, error);
  }

  if (Buffer.byteLength(stdout, "utf8") > WORKTREE_PATH_SCRIPT_MAX_OUTPUT_BYTES) {
    throw new Error(
      `Worktree path script '${script}' printed more than ${WORKTREE_PATH_SCRIPT_MAX_OUTPUT_BYTES} bytes; it must print exactly one line containing the absolute worktree path (send logs to stderr)`,
    );
  }

  const output = stdout.trim();
  if (output.length === 0) {
    throw new Error(
      `Worktree path script '${script}' printed nothing; it must print exactly one line containing the absolute worktree path`,
    );
  }
  if (output.includes("\n")) {
    throw new Error(
      `Worktree path script '${script}' printed more than one line; it must print exactly one line containing the absolute worktree path (send logs to stderr)`,
    );
  }

  try {
    return validateWorktreeScriptPath({ candidate: output, repoPath: context.repoPath });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Worktree path script '${script}': ${reason}`, { cause: error });
  }
}
