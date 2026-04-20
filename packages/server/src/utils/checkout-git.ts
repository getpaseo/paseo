import { resolve, dirname, basename } from "path";
import { existsSync, realpathSync } from "fs";
import { open as openFile, stat as statFile } from "fs/promises";
import { TTLCache } from "@isaacs/ttlcache";
import type { ParsedDiffFile } from "../server/utils/diff-highlighter.js";
import { parseAndHighlightDiff } from "../server/utils/diff-highlighter.js";
import {
  GitHubAuthenticationError,
  GitHubCliMissingError,
  createGitHubService,
  resolveGitHubRepo,
  type GitHubRepoRemoteUrlResolver,
  type GitHubService,
} from "../services/github-service.js";
import { parseGitRevParsePath, resolveGitRevParsePath } from "./git-rev-parse-path.js";
import { runGitCommand } from "./run-git-command.js";
import { isPaseoOwnedWorktreeCwd } from "./worktree.js";
import { requirePaseoWorktreeBaseRefName } from "./worktree-metadata.js";
const READ_ONLY_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
};

const DEFAULT_PULL_REQUEST_STATUS_CACHE_TTL_MS = 30_000;
const PULL_REQUEST_STATUS_CACHE_MAX = 1_000;
const DEFAULT_SHORTSTAT_CACHE_TTL_MS = 15_000;
const SHORTSTAT_CACHE_MAX = 1_000;

let pullRequestStatusCacheTtlMs = DEFAULT_PULL_REQUEST_STATUS_CACHE_TTL_MS;
let pullRequestStatusCache = createPullRequestStatusCache(pullRequestStatusCacheTtlMs);
const pullRequestStatusInFlight = new Map<string, Promise<PullRequestStatusResult>>();
let shortstatCacheTtlMs = DEFAULT_SHORTSTAT_CACHE_TTL_MS;
let shortstatCache = createShortstatCache(shortstatCacheTtlMs);
const shortstatInFlight = new Map<string, Promise<CheckoutShortstat | null>>();

interface CheckoutReadCacheOptions {
  force?: boolean;
  reason?: string;
}

function createPullRequestStatusCache(ttlMs: number) {
  return new TTLCache<string, PullRequestStatusResult>({
    ttl: ttlMs,
    max: PULL_REQUEST_STATUS_CACHE_MAX,
    checkAgeOnGet: true,
  });
}

function createShortstatCache(ttlMs: number) {
  return new TTLCache<string, CheckoutShortstat | null>({
    ttl: ttlMs,
    max: SHORTSTAT_CACHE_MAX,
    checkAgeOnGet: true,
  });
}

function getPullRequestStatusCacheKey(cwd: string): string {
  return resolve(cwd);
}

function getShortstatCacheKey(cwd: string): string {
  return resolve(cwd);
}

export function __resetPullRequestStatusCacheForTests(): void {
  pullRequestStatusCache.clear();
  pullRequestStatusCache.cancelTimer();
  pullRequestStatusCacheTtlMs = DEFAULT_PULL_REQUEST_STATUS_CACHE_TTL_MS;
  pullRequestStatusCache = createPullRequestStatusCache(pullRequestStatusCacheTtlMs);
  pullRequestStatusInFlight.clear();
}

export function __setPullRequestStatusCacheTtlForTests(ttlMs: number): void {
  pullRequestStatusCache.clear();
  pullRequestStatusCache.cancelTimer();
  pullRequestStatusCacheTtlMs = ttlMs;
  pullRequestStatusCache = createPullRequestStatusCache(ttlMs);
  pullRequestStatusInFlight.clear();
}

export function __resetCheckoutShortstatCacheForTests(): void {
  shortstatCache.clear();
  shortstatCache.cancelTimer();
  shortstatCacheTtlMs = DEFAULT_SHORTSTAT_CACHE_TTL_MS;
  shortstatCache = createShortstatCache(shortstatCacheTtlMs);
  shortstatInFlight.clear();
}

export function __setCheckoutShortstatCacheTtlForTests(ttlMs: number): void {
  shortstatCache.clear();
  shortstatCache.cancelTimer();
  shortstatCacheTtlMs = ttlMs;
  shortstatCache = createShortstatCache(ttlMs);
  shortstatInFlight.clear();
}

type CheckoutFileChange = {
  path: string;
  oldPath?: string;
  status: string;
  isNew: boolean;
  isDeleted: boolean;
  isUntracked?: boolean;
};

function normalizeBranchSuggestionName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  let normalized = trimmed;
  if (normalized.startsWith("refs/heads/")) {
    normalized = normalized.slice("refs/heads/".length);
  } else if (normalized.startsWith("refs/remotes/")) {
    normalized = normalized.slice("refs/remotes/".length);
  }

  if (normalized.startsWith("origin/")) {
    normalized = normalized.slice("origin/".length);
  }

  if (!normalized || normalized === "HEAD" || normalized === "origin") {
    return null;
  }

  return normalized;
}

interface GitRef {
  name: string;
  committerDate: number;
}

export interface BranchSuggestion {
  name: string;
  committerDate: number;
  hasLocal: boolean;
  hasRemote: boolean;
}

async function listGitRefs(cwd: string, refPrefix: string): Promise<GitRef[]> {
  const { stdout } = await runGitCommand(
    [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname)%09%(committerdate:unix)",
      refPrefix,
    ],
    { cwd, env: READ_ONLY_GIT_ENV },
  );
  return stdout
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      const [name, dateStr] = trimmed.split("\t");
      if (!name) return null;
      return { name, committerDate: Number(dateStr) || 0 };
    })
    .filter((ref): ref is GitRef => ref !== null);
}

interface BranchSuggestionMeta {
  committerDate: number;
  hasLocal: boolean;
  hasRemote: boolean;
}

function sortBranchSuggestions(
  branchNames: string[],
  branchMeta: Map<string, BranchSuggestionMeta>,
  query: string,
): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  const hasQuery = normalizedQuery.length > 0;
  return branchNames.sort((a, b) => {
    if (hasQuery) {
      const aPrefix = a.toLowerCase().startsWith(normalizedQuery);
      const bPrefix = b.toLowerCase().startsWith(normalizedQuery);
      if (aPrefix !== bPrefix) {
        return aPrefix ? -1 : 1;
      }
    }

    const aMeta = branchMeta.get(a);
    const bMeta = branchMeta.get(b);
    const aDate = aMeta?.committerDate ?? 0;
    const bDate = bMeta?.committerDate ?? 0;
    if (aDate !== bDate) {
      return bDate - aDate;
    }

    return a.localeCompare(b);
  });
}

export async function listBranchSuggestions(
  cwd: string,
  options?: { query?: string; limit?: number },
): Promise<BranchSuggestion[]> {
  await requireGitRepo(cwd);

  const requestedLimit = options?.limit ?? 50;
  const limit = Math.max(1, Math.min(200, requestedLimit));
  const query = options?.query?.trim().toLowerCase() ?? "";

  const [localRefs, remoteRefs] = await Promise.all([
    listGitRefs(cwd, "refs/heads"),
    listGitRefs(cwd, "refs/remotes/origin"),
  ]);

  const branchMeta = new Map<string, BranchSuggestionMeta>();

  for (const ref of localRefs) {
    const normalized = normalizeBranchSuggestionName(ref.name);
    if (!normalized) continue;
    const existing = branchMeta.get(normalized);
    branchMeta.set(normalized, {
      hasLocal: true,
      hasRemote: existing?.hasRemote ?? false,
      committerDate: Math.max(ref.committerDate, existing?.committerDate ?? 0),
    });
  }

  for (const ref of remoteRefs) {
    const normalized = normalizeBranchSuggestionName(ref.name);
    if (!normalized) continue;
    const existing = branchMeta.get(normalized);
    if (!existing) {
      branchMeta.set(normalized, {
        hasLocal: false,
        hasRemote: true,
        committerDate: ref.committerDate,
      });
    } else {
      branchMeta.set(normalized, {
        ...existing,
        hasRemote: true,
        committerDate: Math.max(ref.committerDate, existing.committerDate),
      });
    }
  }

  const filteredNames = Array.from(branchMeta.keys()).filter((name) =>
    query ? name.toLowerCase().includes(query) : true,
  );
  if (filteredNames.length === 0) {
    return [];
  }

  const ordered = sortBranchSuggestions(filteredNames, branchMeta, query);
  return ordered.slice(0, limit).map((name) => {
    const meta = branchMeta.get(name);
    return {
      name,
      committerDate: meta?.committerDate ?? 0,
      hasLocal: meta?.hasLocal ?? false,
      hasRemote: meta?.hasRemote ?? false,
    };
  });
}

export interface LocalBranchCheckoutResolution {
  kind: "local";
  name: string;
}

export interface RemoteOnlyBranchCheckoutResolution {
  kind: "remote-only";
  name: string;
  remoteRef: string;
}

export interface NotFoundBranchCheckoutResolution {
  kind: "not-found";
}

export type BranchCheckoutResolution =
  | LocalBranchCheckoutResolution
  | RemoteOnlyBranchCheckoutResolution
  | NotFoundBranchCheckoutResolution;

export async function resolveBranchCheckout(
  cwd: string,
  name: string,
): Promise<BranchCheckoutResolution> {
  await requireGitRepo(cwd);

  const normalized = normalizeBranchSuggestionName(name);
  if (!normalized) {
    return { kind: "not-found" };
  }

  const localRef = `refs/heads/${normalized}`;
  const localResult = await runGitCommand(["rev-parse", "--verify", "--quiet", localRef], {
    cwd,
    env: READ_ONLY_GIT_ENV,
    acceptExitCodes: [0, 1],
  });
  const hasLocal = localResult.exitCode === 0;
  if (hasLocal) {
    return { kind: "local", name: normalized };
  }

  const remoteRef = `origin/${normalized}`;
  const remoteRefPath = `refs/remotes/${remoteRef}`;
  const remoteResult = await runGitCommand(["rev-parse", "--verify", "--quiet", remoteRefPath], {
    cwd,
    env: READ_ONLY_GIT_ENV,
    acceptExitCodes: [0, 1],
  });
  const hasRemote = remoteResult.exitCode === 0;
  if (hasRemote) {
    return { kind: "remote-only", name: normalized, remoteRef };
  }

  return { kind: "not-found" };
}

export type BranchCheckoutSource = "local" | "remote";

export interface CheckoutExistingBranchResult {
  source: BranchCheckoutSource;
}

export interface CheckoutResolvedBranchInput {
  cwd: string;
  resolution: BranchCheckoutResolution;
  requestedBranch?: string;
}

export async function checkoutResolvedBranch(
  input: CheckoutResolvedBranchInput,
): Promise<CheckoutExistingBranchResult> {
  const { cwd, resolution } = input;

  switch (resolution.kind) {
    case "local": {
      const { stdout } = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
      const current = stdout.trim();
      if (current === resolution.name) {
        return { source: "local" };
      }

      await runGitCommand(["checkout", resolution.name], { cwd });
      return { source: "local" };
    }
    case "remote-only":
      await runGitCommand(["checkout", "-b", resolution.name, "--track", resolution.remoteRef], {
        cwd,
      });
      return { source: "remote" };
    case "not-found":
      throw new Error(`Branch not found: ${input.requestedBranch ?? "unknown"}`);
  }
}

async function listCheckoutFileChanges(
  cwd: string,
  ref: string,
  ignoreWhitespace = false,
): Promise<CheckoutFileChange[]> {
  const changes: CheckoutFileChange[] = [];

  const { stdout: nameStatusOut } = await runGitCommand(
    buildGitDiffArgs({
      ignoreWhitespace,
      extra: ["--name-status", ref],
    }),
    { cwd, env: READ_ONLY_GIT_ENV },
  );
  for (const line of nameStatusOut
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    // `--name-status` uses TAB separators, which preserves filenames with spaces.
    const tabParts = line.split("\t");
    const rawStatus = (tabParts[0] ?? "").trim();
    if (!rawStatus) continue;

    if (rawStatus.startsWith("R") || rawStatus.startsWith("C")) {
      const oldPath = tabParts[1];
      const newPath = tabParts[2];
      if (newPath) {
        changes.push({
          path: newPath,
          ...(oldPath ? { oldPath } : {}),
          status: rawStatus,
          isNew: false,
          isDeleted: false,
        });
      }
      continue;
    }

    const path = tabParts[1];
    if (!path) continue;
    const code = rawStatus[0];
    changes.push({
      path,
      status: rawStatus,
      isNew: code === "A",
      isDeleted: code === "D",
    });
  }

  const { stdout: untrackedOut } = await runGitCommand(
    ["ls-files", "--others", "--exclude-standard"],
    {
      cwd,
      env: READ_ONLY_GIT_ENV,
    },
  );
  for (const file of untrackedOut
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    changes.push({
      path: file,
      status: "U",
      isNew: true,
      isDeleted: false,
      isUntracked: true,
    });
  }

  // Deduplicate by path (prefer tracked status over untracked marker if both appear).
  const byPath = new Map<string, CheckoutFileChange>();
  for (const change of changes) {
    const existing = byPath.get(change.path);
    if (!existing) {
      byPath.set(change.path, change);
      continue;
    }
    if (existing.isUntracked && !change.isUntracked) {
      byPath.set(change.path, change);
    }
  }
  return Array.from(byPath.values());
}

async function readGitFileContentAtRef(
  cwd: string,
  ref: string,
  path: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["show", `${ref}:${path}`], {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    return stdout;
  } catch {
    return null;
  }
}

async function tryResolveMergeBase(cwd: string, baseRef: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["merge-base", baseRef, "HEAD"], {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

type FileStat = { additions: number; deletions: number; isBinary: boolean } | null;

function normalizeNumstatPath(pathField: string): string {
  const braceRenameMatch = pathField.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braceRenameMatch) {
    const [, prefix, , renamed, suffix] = braceRenameMatch;
    return `${prefix}${renamed}${suffix}`;
  }

  const inlineRenameMatch = pathField.match(/^(.*) => (.*)$/);
  if (inlineRenameMatch) {
    return inlineRenameMatch[2] ?? pathField;
  }

  return pathField;
}

function buildGitDiffArgs(args: { ignoreWhitespace?: boolean; extra: string[] }): string[] {
  return ["diff", ...(args.ignoreWhitespace ? ["-w"] : []), ...args.extra];
}

const TRACKED_DIFF_NUMSTAT_MAX_BYTES = 2 * 1024 * 1024; // 2MB
const TRACKED_MAX_CHANGED_LINES = 40_000;

async function getTrackedNumstatByPath(
  cwd: string,
  ref: string,
  ignoreWhitespace = false,
): Promise<Map<string, FileStat>> {
  const result = await runGitCommand(
    buildGitDiffArgs({
      ignoreWhitespace,
      extra: ["--numstat", ref],
    }),
    {
      cwd,
      env: READ_ONLY_GIT_ENV,
      maxOutputBytes: TRACKED_DIFF_NUMSTAT_MAX_BYTES,
      acceptExitCodes: [0],
    },
  );

  const stats = new Map<string, FileStat>();
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) {
      continue;
    }

    const additionsField = parts[0] ?? "";
    const deletionsField = parts[1] ?? "";
    const rawPath = parts.slice(2).join("\t");
    const path = normalizeNumstatPath(rawPath);

    if (!path) {
      continue;
    }

    if (additionsField === "-" || deletionsField === "-") {
      stats.set(path, { additions: 0, deletions: 0, isBinary: true });
      continue;
    }

    const additions = Number.parseInt(additionsField, 10);
    const deletions = Number.parseInt(deletionsField, 10);
    if (Number.isNaN(additions) || Number.isNaN(deletions)) {
      stats.set(path, null);
      continue;
    }

    stats.set(path, { additions, deletions, isBinary: false });
  }

  return stats;
}

function isTrackedDiffTooLarge(stat: FileStat): boolean {
  if (!stat || stat.isBinary) {
    return false;
  }
  return stat.additions + stat.deletions > TRACKED_MAX_CHANGED_LINES;
}

export class NotGitRepoError extends Error {
  readonly cwd: string;
  readonly code = "NOT_GIT_REPO";

  constructor(cwd: string) {
    super(`Not a git repository: ${cwd}`);
    this.name = "NotGitRepoError";
    this.cwd = cwd;
  }
}

export class MergeConflictError extends Error {
  readonly baseRef: string;
  readonly currentBranch: string;
  readonly conflictFiles: string[];

  constructor(options: { baseRef: string; currentBranch: string; conflictFiles: string[] }) {
    super(`Merge conflict while merging ${options.currentBranch} into ${options.baseRef}`);
    this.name = "MergeConflictError";
    this.baseRef = options.baseRef;
    this.currentBranch = options.currentBranch;
    this.conflictFiles = options.conflictFiles;
  }
}

export class MergeFromBaseConflictError extends Error {
  readonly baseRef: string;
  readonly currentBranch: string;
  readonly conflictFiles: string[];

  constructor(options: { baseRef: string; currentBranch: string; conflictFiles: string[] }) {
    super(
      `Merge conflict while merging ${options.baseRef} into ${options.currentBranch}. Please merge manually.`,
    );
    this.name = "MergeFromBaseConflictError";
    this.baseRef = options.baseRef;
    this.currentBranch = options.currentBranch;
    this.conflictFiles = options.conflictFiles;
  }
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

export interface CheckoutStatus {
  isGit: false;
}

export type CheckoutStatusGitNonPaseo = {
  isGit: true;
  repoRoot: string;
  currentBranch: string | null;
  isDirty: boolean;
  baseRef: string | null;
  aheadBehind: AheadBehind | null;
  aheadOfOrigin: number | null;
  behindOfOrigin: number | null;
  hasRemote: boolean;
  remoteUrl: string | null;
  isPaseoOwnedWorktree: false;
};

export type CheckoutStatusGitPaseo = {
  isGit: true;
  repoRoot: string;
  mainRepoRoot: string;
  currentBranch: string | null;
  isDirty: boolean;
  baseRef: string;
  aheadBehind: AheadBehind | null;
  aheadOfOrigin: number | null;
  behindOfOrigin: number | null;
  hasRemote: boolean;
  remoteUrl: string | null;
  isPaseoOwnedWorktree: true;
};

export type CheckoutStatusGit = CheckoutStatusGitNonPaseo | CheckoutStatusGitPaseo;

export type CheckoutStatusResult = CheckoutStatus | CheckoutStatusGit;

export interface CheckoutDiffResult {
  diff: string;
  structured?: ParsedDiffFile[];
}

export interface CheckoutDiffCompare {
  mode: "uncommitted" | "base";
  baseRef?: string;
  ignoreWhitespace?: boolean;
  includeStructured?: boolean;
}

export interface MergeToBaseOptions {
  baseRef?: string;
  mode?: "merge" | "squash";
  commitMessage?: string;
}

export interface MergeFromBaseOptions {
  baseRef?: string;
  requireCleanTarget?: boolean;
}

export type CheckoutContext = {
  paseoHome?: string;
};

function isGitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /not a git repository/i.test(error.message) || /git repository/i.test(error.message);
}

async function requireGitRepo(cwd: string): Promise<void> {
  try {
    await runGitCommand(["rev-parse", "--git-dir"], { cwd, env: READ_ONLY_GIT_ENV });
  } catch (error) {
    throw new NotGitRepoError(cwd);
  }
}

export async function getCurrentBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

async function getWorktreeRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["rev-parse", "--show-toplevel"], {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    return parseGitRevParsePath(stdout);
  } catch {
    return null;
  }
}

export async function getMainRepoRoot(cwd: string): Promise<string> {
  const { stdout: commonDirOut } = await runGitCommand(["rev-parse", "--git-common-dir"], {
    cwd,
    env: READ_ONLY_GIT_ENV,
  });
  const commonDir = resolveGitRevParsePath(cwd, commonDirOut);
  if (!commonDir) {
    throw new Error("Not in a git repository");
  }
  const normalized = realpathSync(commonDir);

  if (basename(normalized) === ".git") {
    return dirname(normalized);
  }

  const { stdout: worktreeOut } = await runGitCommand(["worktree", "list", "--porcelain"], {
    cwd,
    env: READ_ONLY_GIT_ENV,
  });
  const worktrees = parseWorktreeList(worktreeOut);
  const nonBareNonPaseo = worktrees.filter((wt) => !wt.isBare && !isPaseoWorktreePath(wt.path));
  const childrenOfBareRepo = nonBareNonPaseo.filter((wt) => isDescendantPath(wt.path, normalized));
  const mainChild = childrenOfBareRepo.find((wt) => basename(wt.path) === "main");
  return mainChild?.path ?? childrenOfBareRepo[0]?.path ?? nonBareNonPaseo[0]?.path ?? normalized;
}

export type GitWorktreeEntry = {
  path: string;
  branchRef?: string;
  isBare?: boolean;
};

/** Check whether a path contains a `.paseo/worktrees/` segment (both `/` and `\`). */
export function isPaseoWorktreePath(p: string): boolean {
  return /[/\\]\.paseo[/\\]worktrees[/\\]/.test(p);
}

/** True when `child` is strictly inside `parent` (handles both `/` and `\`). */
export function isDescendantPath(child: string, parent: string): boolean {
  let c = child.replace(/\\/g, "/").replace(/\/+$/, "");
  let p = parent.replace(/\\/g, "/").replace(/\/+$/, "");
  // Case-insensitive on Windows (drive letter like C: or D:)
  if (/^[A-Za-z]:/.test(c) || /^[A-Za-z]:/.test(p)) {
    c = c.toLowerCase();
    p = p.toLowerCase();
  }
  if (!c.startsWith(p)) return false;
  if (c.length === p.length) return false;
  return c[p.length] === "/";
}

export function parseWorktreeList(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("worktree ")) {
      if (current) {
        entries.push(current);
      }
      current = { path: trimmed.slice("worktree ".length).trim() };
      continue;
    }
    if (current && trimmed.startsWith("branch ")) {
      current.branchRef = trimmed.slice("branch ".length).trim();
    }
    if (current && trimmed === "bare") {
      current.isBare = true;
    }
  }
  if (current) {
    entries.push(current);
  }
  return entries;
}

async function getWorktreePathForBranch(cwd: string, branchName: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["worktree", "list", "--porcelain"], {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    const entries = parseWorktreeList(stdout);
    const ref = branchName.startsWith("refs/heads/") ? branchName : `refs/heads/${branchName}`;
    return entries.find((entry) => entry.branchRef === ref)?.path ?? null;
  } catch {
    return null;
  }
}

export async function renameCurrentBranch(
  cwd: string,
  newName: string,
): Promise<{ previousBranch: string | null; currentBranch: string | null }> {
  await requireGitRepo(cwd);

  const previousBranch = await getCurrentBranch(cwd);
  if (!previousBranch || previousBranch === "HEAD") {
    throw new Error("Cannot rename branch in detached HEAD state");
  }

  await runGitCommand(["branch", "-m", newName], {
    cwd,
    timeout: 120_000,
  });

  const currentBranch = await getCurrentBranch(cwd);
  return { previousBranch, currentBranch };
}

type ConfiguredBaseRefForCwd =
  | { baseRef: null; isPaseoOwnedWorktree: false }
  | { baseRef: string; isPaseoOwnedWorktree: true };

async function getConfiguredBaseRefForCwd(
  cwd: string,
  context?: CheckoutContext,
): Promise<ConfiguredBaseRefForCwd> {
  // Fast-path reject: non-worktree paths do not need expensive ownership checks.
  if (!/[\\/]worktrees[\\/]/.test(cwd)) {
    return { baseRef: null, isPaseoOwnedWorktree: false };
  }

  const ownership = await isPaseoOwnedWorktreeCwd(cwd, { paseoHome: context?.paseoHome });
  if (!ownership.allowed) {
    return { baseRef: null, isPaseoOwnedWorktree: false };
  }

  const worktreeRoot = (await getWorktreeRoot(cwd)) ?? cwd;
  return {
    baseRef: requirePaseoWorktreeBaseRefName(worktreeRoot),
    isPaseoOwnedWorktree: true,
  };
}

async function isWorkingTreeDirty(cwd: string): Promise<boolean> {
  const { stdout } = await runGitCommand(["status", "--porcelain"], {
    cwd,
    env: READ_ONLY_GIT_ENV,
  });
  return stdout.trim().length > 0;
}

export async function getOriginRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["config", "--get", "remote.origin.url"], {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    const url = stdout.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

export async function hasOriginRemote(cwd: string): Promise<boolean> {
  const url = await getOriginRemoteUrl(cwd);
  return url !== null;
}

export async function resolveAbsoluteGitDir(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["rev-parse", "--absolute-git-dir"], {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    const gitDir = stdout.trim();
    return gitDir.length > 0 ? gitDir : null;
  } catch {
    return null;
  }
}

async function abortGitPullConflictState(cwd: string): Promise<void> {
  const gitDir = await resolveAbsoluteGitDir(cwd);
  if (!gitDir) {
    return;
  }

  const mergeHeadPath = resolve(gitDir, "MERGE_HEAD");
  const rebaseMergePath = resolve(gitDir, "rebase-merge");
  const rebaseApplyPath = resolve(gitDir, "rebase-apply");

  if (existsSync(mergeHeadPath)) {
    try {
      await runGitCommand(["merge", "--abort"], { cwd, timeout: 120_000 });
    } catch {
      // ignore
    }
  }

  if (existsSync(rebaseMergePath) || existsSync(rebaseApplyPath)) {
    try {
      await runGitCommand(["rebase", "--abort"], { cwd, timeout: 120_000 });
    } catch {
      // ignore
    }
  }
}

export async function resolveRepositoryDefaultBranch(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      {
        cwd: repoRoot,
        env: READ_ONLY_GIT_ENV,
      },
    );
    const ref = stdout.trim();
    if (ref) {
      // Prefer a local branch name (e.g. "main") over the remote-tracking ref (e.g. "origin/main")
      // so that status/diff/merge all operate against the same base ref.
      const remoteShort = ref.replace(/^refs\/remotes\//, "");
      const localName = remoteShort.startsWith("origin/")
        ? remoteShort.slice("origin/".length)
        : remoteShort;
      try {
        await runGitCommand(["show-ref", "--verify", "--quiet", `refs/heads/${localName}`], {
          cwd: repoRoot,
          env: READ_ONLY_GIT_ENV,
        });
        return localName;
      } catch {
        return remoteShort;
      }
    }
  } catch {
    // ignore
  }

  const { stdout } = await runGitCommand(["branch", "--format=%(refname:short)"], {
    cwd: repoRoot,
    env: READ_ONLY_GIT_ENV,
  });
  const branches = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (branches.includes("main")) {
    return "main";
  }
  if (branches.includes("master")) {
    return "master";
  }

  return null;
}

async function resolveBaseRef(repoRoot: string): Promise<string | null> {
  return resolveRepositoryDefaultBranch(repoRoot);
}

function normalizeLocalBranchRefName(input: string): string {
  if (input.startsWith("refs/remotes/origin/")) {
    return input.slice("refs/remotes/origin/".length);
  }
  if (input.startsWith("refs/heads/")) {
    return input.slice("refs/heads/".length);
  }
  if (input.startsWith("origin/")) {
    return input.slice("origin/".length);
  }
  return input;
}

interface ComparisonBaseRefName {
  localName: string;
  originRef: string;
}

function normalizeComparisonBaseRefName(input: string): ComparisonBaseRefName {
  const localName = normalizeLocalBranchRefName(input);
  return { localName, originRef: `origin/${localName}` };
}

async function doesGitRefExist(cwd: string, fullRef: string): Promise<boolean> {
  const result = await runGitCommand(["show-ref", "--verify", "--quiet", fullRef], {
    cwd,
    env: READ_ONLY_GIT_ENV,
    acceptExitCodes: [0, 1],
  });
  return result.exitCode === 0;
}

async function resolveBestComparisonBaseRef(cwd: string, baseRef: string): Promise<string> {
  const normalized = normalizeComparisonBaseRefName(baseRef);
  const [hasLocal, hasOrigin] = await Promise.all([
    doesGitRefExist(cwd, `refs/heads/${normalized.localName}`),
    doesGitRefExist(cwd, `refs/remotes/origin/${normalized.localName}`),
  ]);

  if (hasOrigin) {
    return normalized.originRef;
  }
  if (hasLocal) {
    return normalized.localName;
  }

  const refName =
    baseRef.startsWith("origin/") || baseRef.startsWith("refs/remotes/origin/")
      ? normalized.originRef
      : normalized.localName;
  throw new Error(`Base branch not found locally or on origin: ${refName}`);
}

async function resolveMostAheadBaseRef(cwd: string, normalizedBaseRef: string): Promise<string> {
  const [hasLocal, hasOrigin] = await Promise.all([
    doesGitRefExist(cwd, `refs/heads/${normalizedBaseRef}`),
    doesGitRefExist(cwd, `refs/remotes/origin/${normalizedBaseRef}`),
  ]);

  if (hasLocal && !hasOrigin) {
    return normalizedBaseRef;
  }
  if (!hasLocal && hasOrigin) {
    return `origin/${normalizedBaseRef}`;
  }
  if (!hasLocal && !hasOrigin) {
    throw new Error(`Base branch not found locally or on origin: ${normalizedBaseRef}`);
  }

  const { stdout } = await runGitCommand(
    ["rev-list", "--left-right", "--count", `${normalizedBaseRef}...origin/${normalizedBaseRef}`],
    { cwd, env: READ_ONLY_GIT_ENV },
  );
  const [localOnlyRaw, originOnlyRaw] = stdout.trim().split(/\s+/);
  const localOnly = Number.parseInt(localOnlyRaw ?? "0", 10);
  const originOnly = Number.parseInt(originOnlyRaw ?? "0", 10);
  if (Number.isNaN(localOnly) || Number.isNaN(originOnly)) {
    return normalizedBaseRef;
  }
  if (originOnly > localOnly) {
    return `origin/${normalizedBaseRef}`;
  }

  return normalizedBaseRef;
}

async function getAheadBehind(
  cwd: string,
  baseRef: string,
  currentBranch: string,
): Promise<AheadBehind | null> {
  const normalizedBaseRef = normalizeLocalBranchRefName(baseRef);
  if (!normalizedBaseRef || !currentBranch || normalizedBaseRef === currentBranch) {
    return null;
  }
  const comparisonBaseRef = await resolveBestComparisonBaseRef(cwd, baseRef);
  const { stdout } = await runGitCommand(
    ["rev-list", "--left-right", "--count", `${comparisonBaseRef}...${currentBranch}`],
    { cwd, env: READ_ONLY_GIT_ENV },
  );
  const [behindRaw, aheadRaw] = stdout.trim().split(/\s+/);
  const behind = Number.parseInt(behindRaw ?? "0", 10);
  const ahead = Number.parseInt(aheadRaw ?? "0", 10);
  if (Number.isNaN(behind) || Number.isNaN(ahead)) {
    return null;
  }
  return { ahead, behind };
}

async function getAheadOfOrigin(cwd: string, currentBranch: string): Promise<number | null> {
  if (!currentBranch) {
    return null;
  }
  try {
    const { stdout } = await runGitCommand(
      ["rev-list", "--count", `origin/${currentBranch}..${currentBranch}`],
      { cwd, env: READ_ONLY_GIT_ENV },
    );
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(count) ? null : count;
  } catch {
    try {
      const { stdout } = await runGitCommand(["rev-list", "--count", currentBranch], {
        cwd,
        env: READ_ONLY_GIT_ENV,
      });
      const count = Number.parseInt(stdout.trim(), 10);
      return Number.isNaN(count) ? null : count;
    } catch {
      return null;
    }
  }
}

async function getBehindOfOrigin(cwd: string, currentBranch: string): Promise<number | null> {
  if (!currentBranch) {
    return null;
  }
  try {
    const { stdout } = await runGitCommand(
      ["rev-list", "--count", `${currentBranch}..origin/${currentBranch}`],
      { cwd, env: READ_ONLY_GIT_ENV },
    );
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(count) ? null : count;
  } catch {
    return null;
  }
}

type CheckoutInspectionContext = {
  worktreeRoot: string;
  currentBranch: string | null;
  remoteUrl: string | null;
  configured: ConfiguredBaseRefForCwd;
};

async function inspectCheckoutContext(
  cwd: string,
  context?: CheckoutContext,
): Promise<CheckoutInspectionContext | null> {
  try {
    const root = await getWorktreeRoot(cwd);
    if (!root) {
      return null;
    }

    const [currentBranch, remoteUrl, configured] = await Promise.all([
      getCurrentBranch(cwd),
      getOriginRemoteUrl(cwd),
      getConfiguredBaseRefForCwd(cwd, context),
    ]);

    return {
      worktreeRoot: root,
      currentBranch,
      remoteUrl,
      configured,
    };
  } catch (error) {
    if (isGitError(error)) {
      return null;
    }
    throw error;
  }
}

const PER_FILE_DIFF_MAX_BYTES = 1024 * 1024; // 1MB
const TOTAL_DIFF_MAX_BYTES = 2 * 1024 * 1024; // 2MB
const UNTRACKED_BINARY_SNIFF_BYTES = 16 * 1024;

async function isLikelyBinaryFile(absolutePath: string): Promise<boolean> {
  const handle = await openFile(absolutePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(UNTRACKED_BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) {
      return false;
    }

    let suspicious = 0;
    for (let i = 0; i < bytesRead; i += 1) {
      const byte = buffer[i];
      if (byte === 0) {
        return true;
      }
      // Treat control bytes as suspicious while allowing common whitespace.
      if (byte < 7 || (byte > 14 && byte < 32) || byte === 127) {
        suspicious += 1;
      }
    }

    return suspicious / bytesRead > 0.3;
  } finally {
    await handle.close();
  }
}

async function inspectUntrackedFile(
  cwd: string,
  relativePath: string,
): Promise<{ stat: FileStat; truncated: boolean }> {
  const absolutePath = resolve(cwd, relativePath);
  const metadata = await statFile(absolutePath);

  if (!metadata.isFile()) {
    return { stat: null, truncated: false };
  }

  if (await isLikelyBinaryFile(absolutePath)) {
    return {
      stat: { additions: 0, deletions: 0, isBinary: true },
      truncated: false,
    };
  }

  if (metadata.size > PER_FILE_DIFF_MAX_BYTES) {
    return {
      stat: { additions: 0, deletions: 0, isBinary: false },
      truncated: true,
    };
  }

  return {
    stat: { additions: 0, deletions: 0, isBinary: false },
    truncated: false,
  };
}

function buildPlaceholderParsedDiffFile(
  change: CheckoutFileChange,
  options: { status: "too_large" | "binary"; stat?: FileStat },
): ParsedDiffFile {
  return {
    path: change.path,
    isNew: change.isNew,
    isDeleted: change.isDeleted,
    additions: options.stat?.additions ?? 0,
    deletions: options.stat?.deletions ?? 0,
    hunks: [],
    status: options.status,
  };
}

async function getUntrackedDiffText(
  cwd: string,
  change: CheckoutFileChange,
  ignoreWhitespace = false,
): Promise<{ text: string; truncated: boolean; stat: FileStat }> {
  try {
    const inspected = await inspectUntrackedFile(cwd, change.path);
    if (inspected.stat?.isBinary || inspected.truncated) {
      return { text: "", truncated: inspected.truncated, stat: inspected.stat };
    }
  } catch {
    // Fall through to git diff path if metadata probing fails.
  }

  const result = await runGitCommand(
    buildGitDiffArgs({
      ignoreWhitespace,
      extra: ["--no-index", "/dev/null", "--", change.path],
    }),
    {
      cwd,
      env: READ_ONLY_GIT_ENV,
      maxOutputBytes: PER_FILE_DIFF_MAX_BYTES,
      acceptExitCodes: [0, 1],
    },
  );
  return {
    text: result.stdout,
    truncated: result.truncated,
    stat: { additions: 0, deletions: 0, isBinary: false },
  };
}

export async function getCheckoutStatus(
  cwd: string,
  context?: CheckoutContext,
): Promise<CheckoutStatusResult> {
  const inspected = await inspectCheckoutContext(cwd, context);
  if (!inspected) {
    return { isGit: false };
  }

  const worktreeRoot = inspected.worktreeRoot;
  const currentBranch = inspected.currentBranch;
  const remoteUrl = inspected.remoteUrl;
  const configured = inspected.configured;
  const isDirty = await isWorkingTreeDirty(cwd);
  const hasRemote = remoteUrl !== null;
  const baseRef = configured.baseRef ?? (await resolveBaseRef(cwd));
  const [aheadBehind, aheadOfOrigin, behindOfOrigin] = await Promise.all([
    baseRef && currentBranch ? getAheadBehind(cwd, baseRef, currentBranch) : Promise.resolve(null),
    hasRemote && currentBranch ? getAheadOfOrigin(cwd, currentBranch) : Promise.resolve(null),
    hasRemote && currentBranch ? getBehindOfOrigin(cwd, currentBranch) : Promise.resolve(null),
  ]);

  if (configured.isPaseoOwnedWorktree) {
    const mainRepoRoot = await getMainRepoRoot(cwd);
    return {
      isGit: true,
      repoRoot: worktreeRoot,
      mainRepoRoot,
      currentBranch,
      isDirty,
      baseRef: configured.baseRef,
      aheadBehind,
      aheadOfOrigin,
      behindOfOrigin,
      hasRemote,
      remoteUrl,
      isPaseoOwnedWorktree: true,
    };
  }

  return {
    isGit: true,
    repoRoot: worktreeRoot,
    currentBranch,
    isDirty,
    baseRef,
    aheadBehind,
    aheadOfOrigin,
    behindOfOrigin,
    hasRemote,
    remoteUrl,
    isPaseoOwnedWorktree: false,
  };
}

export interface CheckoutShortstat {
  additions: number;
  deletions: number;
}

function parseCheckoutShortstat(text: string): CheckoutShortstat | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  let additions = 0;
  let deletions = 0;
  const addMatch = trimmed.match(/(\d+)\s+insertion/);
  if (addMatch) {
    additions = Number.parseInt(addMatch[1]!, 10);
  }
  const delMatch = trimmed.match(/(\d+)\s+deletion/);
  if (delMatch) {
    deletions = Number.parseInt(delMatch[1]!, 10);
  }

  if (additions === 0 && deletions === 0) {
    return null;
  }

  return { additions, deletions };
}

function combineCheckoutShortstats(
  first: CheckoutShortstat | null,
  second: CheckoutShortstat | null,
): CheckoutShortstat | null {
  const additions = (first?.additions ?? 0) + (second?.additions ?? 0);
  const deletions = (first?.deletions ?? 0) + (second?.deletions ?? 0);

  if (additions === 0 && deletions === 0) {
    return null;
  }

  return { additions, deletions };
}

async function getCheckoutShortstatUncached(
  cwd: string,
  context?: CheckoutContext,
): Promise<CheckoutShortstat | null> {
  try {
    await requireGitRepo(cwd);
  } catch {
    return null;
  }

  const configured = await getConfiguredBaseRefForCwd(cwd, context);
  const localBaseRef = configured.baseRef ?? (await resolveBaseRef(cwd));
  const currentBranch = await getCurrentBranch(cwd);

  let comparisonRef: string;

  if (currentBranch && localBaseRef && currentBranch !== localBaseRef) {
    try {
      comparisonRef = await resolveBestComparisonBaseRef(cwd, localBaseRef);
    } catch {
      return null;
    }
  } else if (currentBranch) {
    const hasOrigin = await doesGitRefExist(cwd, `refs/remotes/origin/${currentBranch}`);
    if (!hasOrigin) {
      return null;
    }
    comparisonRef = `origin/${currentBranch}`;
  } else {
    return null;
  }

  try {
    const { stdout: mergeBaseOut } = await runGitCommand(["merge-base", "HEAD", comparisonRef], {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    const mergeBase = mergeBaseOut.trim();
    if (!mergeBase) {
      return null;
    }

    const { stdout: aheadBehindOut } = await runGitCommand(
      ["rev-list", "--left-right", "--count", `HEAD...${comparisonRef}`],
      { cwd, env: READ_ONLY_GIT_ENV },
    );
    const [headOnlyRaw, comparisonOnlyRaw] = aheadBehindOut.trim().split(/\s+/);
    const headOnly = Number.parseInt(headOnlyRaw ?? "0", 10);
    const comparisonOnly = Number.parseInt(comparisonOnlyRaw ?? "0", 10);
    if (Number.isNaN(headOnly) || Number.isNaN(comparisonOnly)) {
      return null;
    }

    // Incoming uses a two-ref diff, so add the working tree diff separately.
    const showIncoming = headOnly === 0 && comparisonOnly > 0;
    const { stdout } = await runGitCommand(
      ["diff", "--shortstat", mergeBase, ...(showIncoming ? [comparisonRef] : [])],
      {
        cwd,
        env: READ_ONLY_GIT_ENV,
      },
    );
    const committedShortstat = parseCheckoutShortstat(stdout);

    if (!showIncoming) {
      return committedShortstat;
    }

    const { stdout: worktreeOut } = await runGitCommand(["diff", "--shortstat", "HEAD"], {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    return combineCheckoutShortstats(committedShortstat, parseCheckoutShortstat(worktreeOut));
  } catch {
    return null;
  }
}

function getOrLoadCheckoutShortstat(
  cwd: string,
  context?: CheckoutContext,
  options?: CheckoutReadCacheOptions,
): Promise<CheckoutShortstat | null> {
  const cacheKey = getShortstatCacheKey(cwd);
  if (!options?.force) {
    const cached = shortstatCache.get(cacheKey);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }

    const existing = shortstatInFlight.get(cacheKey);
    if (existing) {
      return existing;
    }
  }

  const load = getCheckoutShortstatUncached(cwd, context)
    .then((shortstat) => {
      shortstatCache.set(cacheKey, shortstat);
      return shortstat;
    })
    .finally(() => {
      shortstatInFlight.delete(cacheKey);
    });

  shortstatInFlight.set(cacheKey, load);
  return load;
}

export async function getCheckoutShortstat(
  cwd: string,
  context?: CheckoutContext,
  options?: CheckoutReadCacheOptions,
): Promise<CheckoutShortstat | null> {
  return getOrLoadCheckoutShortstat(cwd, context, options);
}

export function getCachedCheckoutShortstat(cwd: string): CheckoutShortstat | null | undefined {
  return shortstatCache.get(getShortstatCacheKey(cwd));
}

export function warmCheckoutShortstatInBackground(
  cwd: string,
  context?: CheckoutContext,
  onComplete?: () => void,
): void {
  const cacheKey = getShortstatCacheKey(cwd);
  if (shortstatCache.get(cacheKey) !== undefined || shortstatInFlight.has(cacheKey)) {
    return;
  }

  void getOrLoadCheckoutShortstat(cwd, context)
    .then(() => {
      onComplete?.();
    })
    .catch(() => {
      // Non-critical: keep listing path resilient even if git commands fail.
    });
}

export async function getCheckoutDiff(
  cwd: string,
  compare: CheckoutDiffCompare,
  context?: CheckoutContext,
): Promise<CheckoutDiffResult> {
  await requireGitRepo(cwd);

  let refForDiff: string;

  if (compare.mode === "uncommitted") {
    refForDiff = "HEAD";
  } else {
    const configured = await getConfiguredBaseRefForCwd(cwd, context);
    const baseRef = configured.baseRef ?? compare.baseRef ?? (await resolveBaseRef(cwd));
    if (!baseRef) {
      return { diff: "" };
    }
    if (configured.isPaseoOwnedWorktree && compare.baseRef && compare.baseRef !== baseRef) {
      throw new Error(`Base ref mismatch: expected ${baseRef}, got ${compare.baseRef}`);
    }

    const bestBaseRef = await resolveBestComparisonBaseRef(cwd, baseRef);
    refForDiff = (await tryResolveMergeBase(cwd, bestBaseRef)) ?? bestBaseRef;
  }

  const ignoreWhitespace = compare.ignoreWhitespace === true;
  const changes = await listCheckoutFileChanges(cwd, refForDiff, ignoreWhitespace);
  changes.sort((a, b) => {
    if (a.path === b.path) return 0;
    return a.path < b.path ? -1 : 1;
  });

  const structured: ParsedDiffFile[] = [];
  let diffText = "";
  let diffBytes = 0;
  const appendDiff = (text: string) => {
    if (!text) return;
    if (diffBytes >= TOTAL_DIFF_MAX_BYTES) return;
    const buf = Buffer.from(text, "utf8");
    if (diffBytes + buf.length <= TOTAL_DIFF_MAX_BYTES) {
      diffText += text;
      diffBytes += buf.length;
      return;
    }
    const remaining = TOTAL_DIFF_MAX_BYTES - diffBytes;
    if (remaining > 0) {
      diffText += buf.subarray(0, remaining).toString("utf8");
      diffBytes = TOTAL_DIFF_MAX_BYTES;
    }
  };

  const trackedChanges = changes.filter((change) => !change.isUntracked);
  const untrackedChanges = changes.filter((change) => change.isUntracked === true);
  const trackedChangeByPath = new Map(trackedChanges.map((change) => [change.path, change]));

  const trackedNumstatByPath =
    trackedChanges.length > 0
      ? await getTrackedNumstatByPath(cwd, refForDiff, ignoreWhitespace)
      : new Map<string, FileStat>();
  const trackedDiffPaths: string[] = [];
  const trackedPlaceholderByPath = new Map<
    string,
    { status: "binary" | "too_large"; stat: FileStat }
  >();

  for (const change of trackedChanges) {
    const stat = trackedNumstatByPath.get(change.path) ?? null;
    if (stat?.isBinary) {
      trackedPlaceholderByPath.set(change.path, { status: "binary", stat });
      continue;
    }
    if (isTrackedDiffTooLarge(stat)) {
      trackedPlaceholderByPath.set(change.path, { status: "too_large", stat });
      continue;
    }
    trackedDiffPaths.push(change.path);
  }

  let trackedDiffText = "";
  let trackedDiffTruncated = false;
  if (trackedDiffPaths.length > 0) {
    const trackedDiffResult = await runGitCommand(
      buildGitDiffArgs({
        ignoreWhitespace,
        extra: [refForDiff, "--", ...trackedDiffPaths],
      }),
      {
        cwd,
        env: READ_ONLY_GIT_ENV,
        maxOutputBytes: TOTAL_DIFF_MAX_BYTES,
      },
    );
    trackedDiffText = trackedDiffResult.stdout;
    trackedDiffTruncated = trackedDiffResult.truncated;
    appendDiff(trackedDiffText);
    if (trackedDiffTruncated) {
      appendDiff("# tracked diff truncated\n");
    }
  }

  const appendTrackedPlaceholderComment = (
    change: CheckoutFileChange,
    status: "binary" | "too_large",
  ) => {
    if (status === "binary") {
      appendDiff(`# ${change.path}: binary diff omitted\n`);
      return;
    }
    appendDiff(`# ${change.path}: diff too large omitted\n`);
  };

  if (compare.includeStructured) {
    const parsedTrackedFiles =
      trackedDiffText.length > 0
        ? await parseAndHighlightDiff(trackedDiffText, cwd, {
            getOldFileContent: async (file) => {
              const change = trackedChangeByPath.get(file.path);
              if (!change || change.isNew) {
                return null;
              }
              const refPath = change.oldPath ?? change.path;
              return readGitFileContentAtRef(cwd, refForDiff, refPath);
            },
          })
        : [];
    const parsedTrackedByPath = new Map(parsedTrackedFiles.map((file) => [file.path, file]));

    for (const change of trackedChanges) {
      const placeholder = trackedPlaceholderByPath.get(change.path);
      if (placeholder) {
        structured.push(
          buildPlaceholderParsedDiffFile(change, {
            status: placeholder.status,
            stat: placeholder.stat,
          }),
        );
        appendTrackedPlaceholderComment(change, placeholder.status);
        continue;
      }

      const stat = trackedNumstatByPath.get(change.path) ?? null;
      const parsedFile = parsedTrackedByPath.get(change.path);
      if (parsedFile) {
        structured.push({
          ...parsedFile,
          path: change.path,
          isNew: change.isNew,
          isDeleted: change.isDeleted,
          status: "ok",
        });
        continue;
      }

      // `git diff -w --name-status` can still report a modified path even when the
      // whitespace-filtered patch and numstat are both empty. Skip emitting a
      // structured placeholder in that case so whitespace-only edits truly disappear.
      if (
        ignoreWhitespace &&
        !trackedDiffTruncated &&
        change.status.startsWith("M") &&
        (!stat || (!stat.isBinary && stat.additions === 0 && stat.deletions === 0))
      ) {
        continue;
      }

      structured.push({
        path: change.path,
        isNew: change.isNew,
        isDeleted: change.isDeleted,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        hunks: [],
        status: trackedDiffTruncated ? "too_large" : "ok",
      });
    }
  } else {
    for (const change of trackedChanges) {
      const placeholder = trackedPlaceholderByPath.get(change.path);
      if (placeholder) {
        appendTrackedPlaceholderComment(change, placeholder.status);
      }
    }
  }

  for (const change of untrackedChanges) {
    if (diffBytes >= TOTAL_DIFF_MAX_BYTES) {
      break;
    }
    const { text, truncated, stat } = await getUntrackedDiffText(cwd, change, ignoreWhitespace);

    if (!compare.includeStructured) {
      if (stat?.isBinary) {
        appendDiff(`# ${change.path}: binary diff omitted\n`);
      } else if (truncated) {
        appendDiff(`# ${change.path}: diff too large omitted\n`);
      } else {
        appendDiff(text);
      }
      continue;
    }

    if (stat?.isBinary) {
      structured.push(buildPlaceholderParsedDiffFile(change, { status: "binary", stat }));
      appendDiff(`# ${change.path}: binary diff omitted\n`);
      continue;
    }

    if (truncated) {
      structured.push(buildPlaceholderParsedDiffFile(change, { status: "too_large", stat }));
      appendDiff(`# ${change.path}: diff too large omitted\n`);
      continue;
    }

    appendDiff(text);
    const parsed = await parseAndHighlightDiff(text, cwd);
    const parsedFile =
      parsed[0] ??
      ({
        path: change.path,
        isNew: change.isNew,
        isDeleted: change.isDeleted,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        hunks: [],
      } satisfies ParsedDiffFile);

    structured.push({
      ...parsedFile,
      path: change.path,
      isNew: change.isNew,
      isDeleted: change.isDeleted,
      status: "ok",
    });
  }

  if (compare.includeStructured) {
    return { diff: diffText, structured };
  }
  return { diff: diffText };
}

export async function commitChanges(
  cwd: string,
  options: { message: string; addAll?: boolean },
): Promise<void> {
  await requireGitRepo(cwd);
  if (options.addAll ?? true) {
    await runGitCommand(["add", "-A"], { cwd, timeout: 120_000 });
  }
  await runGitCommand(["-c", "commit.gpgsign=false", "commit", "-m", options.message], {
    cwd,
    timeout: 120_000,
  });
}

export async function commitAll(cwd: string, message: string): Promise<void> {
  await commitChanges(cwd, { message, addAll: true });
}

export async function mergeToBase(
  cwd: string,
  options: MergeToBaseOptions = {},
  context?: CheckoutContext,
): Promise<string> {
  await requireGitRepo(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  const configured = await getConfiguredBaseRefForCwd(cwd, context);
  const baseRef = configured.baseRef ?? options.baseRef ?? (await resolveBaseRef(cwd));
  if (!baseRef) {
    throw new Error("Unable to determine base branch for merge");
  }
  if (configured.isPaseoOwnedWorktree && options.baseRef && options.baseRef !== baseRef) {
    throw new Error(`Base ref mismatch: expected ${baseRef}, got ${options.baseRef}`);
  }
  if (!currentBranch) {
    throw new Error("Unable to determine current branch for merge");
  }
  let normalizedBaseRef = baseRef;
  normalizedBaseRef = normalizeLocalBranchRefName(normalizedBaseRef);
  const currentWorktreeRoot = (await getWorktreeRoot(cwd)) ?? cwd;
  if (normalizedBaseRef === currentBranch) {
    return currentWorktreeRoot;
  }

  const baseWorktree = await getWorktreePathForBranch(cwd, normalizedBaseRef);
  const operationCwd = baseWorktree ?? currentWorktreeRoot;
  const isSameCheckout = resolve(operationCwd) === resolve(currentWorktreeRoot);
  const originalBranch = await getCurrentBranch(operationCwd);
  const mode = options.mode ?? "merge";
  try {
    await runGitCommand(["checkout", normalizedBaseRef], {
      cwd: operationCwd,
      timeout: 120_000,
    });
    if (mode === "squash") {
      await runGitCommand(["merge", "--squash", currentBranch], {
        cwd: operationCwd,
        timeout: 120_000,
      });
      const message =
        options.commitMessage ?? `Squash merge ${currentBranch} into ${normalizedBaseRef}`;
      await runGitCommand(["-c", "commit.gpgsign=false", "commit", "-m", message], {
        cwd: operationCwd,
        timeout: 120_000,
      });
    } else {
      await runGitCommand(["merge", currentBranch], { cwd: operationCwd, timeout: 120_000 });
    }
  } catch (error) {
    const errorDetails =
      error instanceof Error
        ? `${error.message}\n${(error as any).stderr ?? ""}\n${(error as any).stdout ?? ""}`
        : String(error);
    try {
      const [unmergedOutput, lsFilesOutput, statusOutput] = await Promise.all([
        runGitCommand(["diff", "--name-only", "--diff-filter=U"], { cwd: operationCwd }),
        runGitCommand(["ls-files", "-u"], { cwd: operationCwd }),
        runGitCommand(["status", "--porcelain"], { cwd: operationCwd }),
      ]);
      const statusConflicts = statusOutput.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => /^(UU|AA|DD|AU|UA|UD|DU)\s/.test(line))
        .map((line) => line.slice(3).trim());
      const conflicts = [
        ...unmergedOutput.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        ...lsFilesOutput.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.split("\t").pop() as string),
        ...statusConflicts,
      ].filter(Boolean);
      const conflictDetected =
        conflicts.length > 0 || /CONFLICT|Automatic merge failed/i.test(errorDetails);
      if (conflictDetected) {
        try {
          await runGitCommand(["merge", "--abort"], { cwd: operationCwd, timeout: 120_000 });
        } catch {
          // ignore
        }
        throw new MergeConflictError({
          baseRef: normalizedBaseRef,
          currentBranch,
          conflictFiles: conflicts.length > 0 ? conflicts : [],
        });
      }
    } catch (innerError) {
      if (innerError instanceof MergeConflictError) {
        throw innerError;
      }
      // ignore detection failures
    }

    throw error;
  } finally {
    if (isSameCheckout && originalBranch && originalBranch !== normalizedBaseRef) {
      try {
        await runGitCommand(["checkout", originalBranch], {
          cwd: operationCwd,
          timeout: 120_000,
        });
      } catch {
        // ignore
      }
    }
  }
  return operationCwd;
}

export async function mergeFromBase(
  cwd: string,
  options: MergeFromBaseOptions = {},
  context?: CheckoutContext,
): Promise<void> {
  await requireGitRepo(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  if (!currentBranch || currentBranch === "HEAD") {
    throw new Error("Unable to determine current branch for merge");
  }

  const configured = await getConfiguredBaseRefForCwd(cwd, context);
  const baseRef = configured.baseRef ?? options.baseRef ?? (await resolveBaseRef(cwd));
  if (!baseRef) {
    throw new Error("Unable to determine base branch for merge");
  }
  if (configured.isPaseoOwnedWorktree && options.baseRef && options.baseRef !== baseRef) {
    throw new Error(`Base ref mismatch: expected ${baseRef}, got ${options.baseRef}`);
  }

  const requireCleanTarget = options.requireCleanTarget ?? true;
  if (requireCleanTarget) {
    const { stdout } = await runGitCommand(["status", "--porcelain"], {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    if (stdout.trim().length > 0) {
      throw new Error("Working directory has uncommitted changes.");
    }
  }

  const normalizedBaseRef = normalizeLocalBranchRefName(baseRef);
  const bestBaseRef = await resolveMostAheadBaseRef(cwd, normalizedBaseRef);
  if (bestBaseRef === currentBranch) {
    return;
  }

  try {
    await runGitCommand(["merge", bestBaseRef], { cwd, timeout: 120_000 });
  } catch (error) {
    const errorDetails =
      error instanceof Error
        ? `${error.message}\n${(error as any).stderr ?? ""}\n${(error as any).stdout ?? ""}`
        : String(error);
    try {
      const [unmergedOutput, lsFilesOutput, statusOutput] = await Promise.all([
        runGitCommand(["diff", "--name-only", "--diff-filter=U"], { cwd }),
        runGitCommand(["ls-files", "-u"], { cwd }),
        runGitCommand(["status", "--porcelain"], { cwd }),
      ]);
      const statusConflicts = statusOutput.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => /^(UU|AA|DD|AU|UA|UD|DU)\s/.test(line))
        .map((line) => line.slice(3).trim());
      const conflicts = [
        ...unmergedOutput.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        ...lsFilesOutput.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.split("\t").pop() as string),
        ...statusConflicts,
      ].filter(Boolean);
      const conflictDetected =
        conflicts.length > 0 || /CONFLICT|Automatic merge failed/i.test(errorDetails);
      if (conflictDetected) {
        try {
          await runGitCommand(["merge", "--abort"], { cwd, timeout: 120_000 });
        } catch {
          // ignore
        }
        throw new MergeFromBaseConflictError({
          baseRef: bestBaseRef,
          currentBranch,
          conflictFiles: conflicts.length > 0 ? conflicts : [],
        });
      }
    } catch (innerError) {
      if (innerError instanceof MergeFromBaseConflictError) {
        throw innerError;
      }
      // ignore detection failures
    }

    throw error;
  }
}

export async function pullCurrentBranch(cwd: string, github?: GitHubService): Promise<void> {
  await requireGitRepo(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  if (!currentBranch || currentBranch === "HEAD") {
    throw new Error("Unable to determine current branch for pull");
  }
  const hasRemote = await hasOriginRemote(cwd);
  if (!hasRemote) {
    throw new Error("Remote 'origin' is not configured.");
  }
  try {
    await runGitCommand(["pull"], { cwd, timeout: 120_000 });
    github?.invalidate({ cwd });
  } catch (error) {
    await abortGitPullConflictState(cwd);
    throw error;
  }
}

export async function pushCurrentBranch(cwd: string, github?: GitHubService): Promise<void> {
  await requireGitRepo(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  if (!currentBranch || currentBranch === "HEAD") {
    throw new Error("Unable to determine current branch for push");
  }
  const hasRemote = await hasOriginRemote(cwd);
  if (!hasRemote) {
    throw new Error("Remote 'origin' is not configured.");
  }
  await runGitCommand(["push", "-u", "origin", currentBranch], { cwd, timeout: 120_000 });
  github?.invalidate({ cwd });
}

export interface CreatePullRequestOptions {
  title: string;
  body?: string;
  base?: string;
  head?: string;
  draft?: boolean;
}

export interface PullRequestStatus {
  number?: number;
  repoOwner?: string;
  repoName?: string;
  url: string;
  title: string;
  state: string;
  baseRefName: string;
  headRefName: string;
  isMerged: boolean;
  isDraft?: boolean;
  checks?: PullRequestCheck[];
  checksStatus?: ChecksStatus;
  reviewDecision?: ReviewDecision;
}

export interface PullRequestStatusResult {
  status: PullRequestStatus | null;
  githubFeaturesEnabled: boolean;
}

export type PullRequestCheck = {
  name: string;
  status: "success" | "failure" | "pending" | "skipped" | "cancelled";
  url: string | null;
  workflow?: string;
  duration?: string;
};

export type ChecksStatus = "none" | "pending" | "success" | "failure";

export type ReviewDecision = "approved" | "changes_requested" | "pending" | null;

export async function createPullRequest(
  cwd: string,
  options: CreatePullRequestOptions,
  github: GitHubService = createGitHubService(),
  workspaceGitService: GitHubRepoRemoteUrlResolver,
): Promise<{ url: string; number: number }> {
  await requireGitRepo(cwd);
  const repo = await resolveGitHubRepo(cwd, { workspaceGitService });
  if (!repo) {
    throw new Error("Unable to determine GitHub repo from git remote");
  }

  const head = options.head ?? (await getCurrentBranch(cwd));
  const configured = await getConfiguredBaseRefForCwd(cwd);
  const base = configured.baseRef ?? options.base ?? (await resolveBaseRef(cwd));
  if (!head) {
    throw new Error("Unable to determine head branch for PR");
  }
  if (!base) {
    throw new Error("Unable to determine base branch for PR");
  }
  const normalizedBase = normalizeLocalBranchRefName(base);
  if (configured.isPaseoOwnedWorktree && options.base && options.base !== base) {
    throw new Error(`Base ref mismatch: expected ${base}, got ${options.base}`);
  }

  await runGitCommand(["push", "-u", "origin", head], { cwd, timeout: 120_000 });

  const result = await github.createPullRequest({
    cwd,
    repo,
    title: options.title,
    body: options.body,
    head,
    base: normalizedBase,
  });
  github.invalidate({ cwd });
  return result;
}

export async function getPullRequestStatus(
  cwd: string,
  github: GitHubService = createGitHubService(),
  options?: CheckoutReadCacheOptions,
): Promise<PullRequestStatusResult> {
  const cacheKey = getPullRequestStatusCacheKey(cwd);
  if (!options?.force) {
    const cached = pullRequestStatusCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const existing = pullRequestStatusInFlight.get(cacheKey);
    if (existing) {
      return existing;
    }
  }

  const lookup = getPullRequestStatusUncached(cwd, github, options)
    .then((status) => {
      pullRequestStatusCache.set(cacheKey, status);
      return status;
    })
    .finally(() => {
      pullRequestStatusInFlight.delete(cacheKey);
    });

  pullRequestStatusInFlight.set(cacheKey, lookup);
  return lookup;
}

async function getPullRequestStatusUncached(
  cwd: string,
  github: GitHubService,
  options?: CheckoutReadCacheOptions,
): Promise<PullRequestStatusResult> {
  await requireGitRepo(cwd);
  const head = await getCurrentBranch(cwd);
  if (!head) {
    return {
      status: null,
      githubFeaturesEnabled: false,
    };
  }
  try {
    const status = await github.getCurrentPullRequestStatus({
      cwd,
      headRef: head,
      reason: options?.reason,
    });
    return {
      status,
      githubFeaturesEnabled: true,
    };
  } catch (error) {
    if (error instanceof GitHubCliMissingError || error instanceof GitHubAuthenticationError) {
      return { status: null, githubFeaturesEnabled: false };
    }
    throw error;
  }
}
