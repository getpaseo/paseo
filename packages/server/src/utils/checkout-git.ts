import { resolve, dirname, basename } from "path";
import { existsSync, realpathSync } from "fs";
import { open as openFile, readFile, stat as statFile } from "fs/promises";
import { TTLCache } from "@isaacs/ttlcache";
import type { CheckoutCommit, CheckoutCommitFile } from "@getpaseo/protocol/messages";
import { parseGitHubRemoteIdentity, parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import { maxBase64EncryptedPlaintextByteLength } from "@getpaseo/relay";
import type { Logger } from "pino";
import type { ParsedDiffFile } from "../server/utils/diff-highlighter.js";
import {
  highlightDiffWithFileContent,
  parseAndHighlightDiff,
  parseDiff,
} from "../server/utils/diff-highlighter.js";
import { parseGitHubRepoFromRemote } from "../server/workspace-git-metadata.js";
import { createGitHubService } from "../services/github-service.js";
import type {
  CurrentPullRequestStatus,
  ForgeAuthState,
  ForgeService,
  ForgeSpecificStatusFacts,
  PullRequestMergeable,
} from "../services/forge-service.js";
import {
  ForgeAuthenticationError,
  ForgeCliMissingError,
  ForgeCommandError,
} from "../services/forge-cli-command.js";
import { parseGitRevParsePath, resolveGitRevParsePath } from "./git-rev-parse-path.js";
import { runGitCommand } from "./run-git-command.js";
import { isPaseoOwnedWorktreeCwd, resolvePaseoWorktreesBaseRoot } from "./worktree.js";
import {
  branchNameFromRef,
  getPaseoWorktreeChangeRequestHintForBranch,
  type PaseoWorktreeMetadata,
  readPaseoWorktreeMetadata,
  rebindPaseoWorktreeChangeRequestHint,
} from "./worktree-metadata.js";
const READ_ONLY_GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
} as const;

/**
 * Why a git mutation is forcing a workspace snapshot refresh. Shared between the
 * Session shell (which owns the refresh primitive) and the checkout subsystem
 * (which triggers most of these reasons after a write).
 */
export type GitMutationRefreshReason =
  | "commit-changes"
  | "pull"
  | "push"
  | "merge-to-base"
  | "merge-from-base"
  | "merge-pr"
  | "enable-pr-auto-merge"
  | "disable-pr-auto-merge"
  | "create-pr"
  | "switch-branch"
  | "rename-branch"
  | "create-branch"
  | "stash-push"
  | "stash-pop"
  | "create-worktree";

const DEFAULT_PULL_REQUEST_STATUS_CACHE_TTL_MS = 30_000;
const PULL_REQUEST_STATUS_CACHE_MAX = 1_000;
const DEFAULT_SHORTSTAT_CACHE_TTL_MS = 15_000;
const SHORTSTAT_CACHE_MAX = 1_000;

let pullRequestStatusCacheTtlMs = DEFAULT_PULL_REQUEST_STATUS_CACHE_TTL_MS;
let pullRequestStatusCache = createPullRequestStatusCache(pullRequestStatusCacheTtlMs);
const pullRequestStatusInFlight = new Map<string, Promise<PullRequestStatusResult>>();
const lastSuccessfulPullRequestStatus = new Map<string, PullRequestStatusResult>();
let shortstatCacheTtlMs = DEFAULT_SHORTSTAT_CACHE_TTL_MS;
let shortstatCache = createShortstatCache(shortstatCacheTtlMs);
const shortstatInFlight = new Map<string, Promise<CheckoutShortstat | null>>();

interface CheckoutReadCacheOptions {
  force?: boolean;
  reason?: string;
}

interface PullRequestStatusLookupTarget {
  headRef: string;
  headSha?: string;
  headRepositoryOwner?: string;
}

interface PullRequestLookupTargetBranchConfig {
  currentBranch: string;
  branchRemoteName: string | null;
  branchMergeRef: string | null;
  branchRemoteUrl: string | null;
  originRemoteUrl: string | null;
  resolvedBaseRef: string | null;
}

interface PullRequestLookupTargetPushConfig {
  currentBranch: string;
  pushRemoteName: string | null;
  pushRefspec: string | null;
  pushRemoteUrl: string | null;
  originRemoteUrl: string | null;
  resolvedBaseRef: string | null;
}

function getErrorStderr(error: Error): string {
  return "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
}

function getErrorStdout(error: Error): string {
  return "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
}

function throwBranchNotFound(branch: string | undefined): never {
  throw new Error(`Branch not found: ${branch ?? "unknown"}`);
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

function getPullRequestStatusCacheKey(cwd: string, headSha: string | null): string {
  return `${resolve(cwd)}\u0000${headSha ?? ""}`;
}

function rememberPullRequestStatus(cacheKey: string, status: PullRequestStatusResult): void {
  lastSuccessfulPullRequestStatus.set(cacheKey, status);
  if (lastSuccessfulPullRequestStatus.size <= PULL_REQUEST_STATUS_CACHE_MAX) {
    return;
  }
  const oldest = lastSuccessfulPullRequestStatus.keys().next();
  if (!oldest.done) {
    lastSuccessfulPullRequestStatus.delete(oldest.value);
  }
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
  lastSuccessfulPullRequestStatus.clear();
}

export function __setPullRequestStatusCacheTtlForTests(ttlMs: number): void {
  pullRequestStatusCache.clear();
  pullRequestStatusCache.cancelTimer();
  pullRequestStatusCacheTtlMs = ttlMs;
  pullRequestStatusCache = createPullRequestStatusCache(ttlMs);
  pullRequestStatusInFlight.clear();
  lastSuccessfulPullRequestStatus.clear();
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

interface CheckoutFileChange {
  path: string;
  oldPath?: string;
  status: string;
  isNew: boolean;
  isDeleted: boolean;
  isUntracked?: boolean;
}

interface CheckoutDiffRefs {
  baseRef: string;
  targetRef?: string;
  includeUntracked: boolean;
}

function getCheckoutDiffRefArgs(refs: CheckoutDiffRefs): string[] {
  return [refs.baseRef, ...(refs.targetRef ? [refs.targetRef] : [])];
}

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
  oid: string;
}

export interface BranchSuggestion {
  name: string;
  committerDate: number;
  hasLocal: boolean;
  hasRemote: boolean;
  localAhead?: number;
  localBehind?: number;
}

async function listGitRefs(cwd: string, refPrefix: string): Promise<GitRef[]> {
  const { stdout } = await runGitCommand(
    [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname)%09%(committerdate:unix)%09%(objectname)",
      refPrefix,
    ],
    { cwd, envOverlay: READ_ONLY_GIT_ENV },
  );
  return stdout
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      const [name, dateStr, oid] = trimmed.split("\t");
      if (!name || !oid) return null;
      return { name, committerDate: Number(dateStr) || 0, oid };
    })
    .filter((ref): ref is GitRef => ref !== null);
}

interface BranchSuggestionMeta {
  committerDate: number;
  hasLocal: boolean;
  hasRemote: boolean;
  localOid?: string;
  remoteOid?: string;
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
  const rawQuery = options?.query?.trim().toLowerCase() ?? "";
  const query = normalizeBranchSuggestionName(rawQuery) ?? rawQuery;

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
      localOid: ref.oid,
      ...(existing?.remoteOid ? { remoteOid: existing.remoteOid } : {}),
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
        remoteOid: ref.oid,
        committerDate: ref.committerDate,
      });
    } else {
      branchMeta.set(normalized, {
        ...existing,
        hasRemote: true,
        remoteOid: ref.oid,
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
  return Promise.all(
    ordered.slice(0, limit).map(async (name): Promise<BranchSuggestion> => {
      const meta = branchMeta.get(name);
      const suggestion: BranchSuggestion = {
        name,
        committerDate: meta?.committerDate ?? 0,
        hasLocal: meta?.hasLocal ?? false,
        hasRemote: meta?.hasRemote ?? false,
      };
      if (!suggestion.hasLocal || !suggestion.hasRemote) {
        return suggestion;
      }
      if (meta?.localOid && meta.localOid === meta.remoteOid) {
        suggestion.localAhead = 0;
        suggestion.localBehind = 0;
        return suggestion;
      }

      try {
        const { stdout } = await runGitCommand(
          [
            "rev-list",
            "--left-right",
            "--count",
            `refs/heads/${name}...refs/remotes/origin/${name}`,
          ],
          { cwd, envOverlay: READ_ONLY_GIT_ENV },
        );
        const [localAhead, localBehind] = stdout.trim().split(/\s+/).map(Number);
        if (Number.isFinite(localAhead) && Number.isFinite(localBehind)) {
          suggestion.localAhead = localAhead;
          suggestion.localBehind = localBehind;
        }
      } catch {
        // A ref may disappear between listing and comparison. Keep the branch
        // available without divergence metadata and let creation re-resolve it.
      }
      return suggestion;
    }),
  );
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
    envOverlay: READ_ONLY_GIT_ENV,
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
    envOverlay: READ_ONLY_GIT_ENV,
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
    default:
      return throwBranchNotFound(input.requestedBranch);
  }
}

async function listCheckoutFileChanges(
  cwd: string,
  refs: CheckoutDiffRefs,
  ignoreWhitespace = false,
): Promise<CheckoutFileChange[]> {
  const changes: CheckoutFileChange[] = [];

  const { stdout: nameStatusOut } = await runGitCommand(
    buildGitDiffArgs({
      ignoreWhitespace,
      extra: ["--name-status", ...getCheckoutDiffRefArgs(refs)],
    }),
    { cwd, envOverlay: READ_ONLY_GIT_ENV },
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

  if (refs.includeUntracked) {
    const { stdout: untrackedOut } = await runGitCommand(
      ["ls-files", "--others", "--exclude-standard"],
      {
        cwd,
        envOverlay: READ_ONLY_GIT_ENV,
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
      envOverlay: READ_ONLY_GIT_ENV,
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
      envOverlay: READ_ONLY_GIT_ENV,
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
const TRACKED_DIFF_BATCH_SIZE = 8;
const EMPTY_TREE_OBJECT_ID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function isUnbornHeadDiffError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("--name-status HEAD") &&
    error.message.includes("ambiguous argument 'HEAD'")
  );
}

async function getTrackedNumstatByPath(
  cwd: string,
  refs: CheckoutDiffRefs,
  ignoreWhitespace = false,
): Promise<Map<string, FileStat>> {
  const result = await runGitCommand(
    buildGitDiffArgs({
      ignoreWhitespace,
      extra: ["--numstat", ...getCheckoutDiffRefArgs(refs)],
    }),
    {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
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

async function getTrackedDiffTextForPath(input: {
  cwd: string;
  refsForDiff: CheckoutDiffRefs;
  path: string;
  ignoreWhitespace: boolean;
}): Promise<{ path: string; text: string; truncated: boolean }> {
  const result = await runGitCommand(
    buildGitDiffArgs({
      ignoreWhitespace: input.ignoreWhitespace,
      extra: [...getCheckoutDiffRefArgs(input.refsForDiff), "--", input.path],
    }),
    {
      cwd: input.cwd,
      envOverlay: READ_ONLY_GIT_ENV,
      maxOutputBytes: PER_FILE_DIFF_MAX_BYTES,
    },
  );

  return {
    path: input.path,
    text: result.stdout,
    truncated: result.truncated,
  };
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

export class MergeCleanupError extends AggregateError {
  readonly baseRef: string;
  readonly currentBranch: string;
  readonly conflictFiles: string[];
  readonly diagnosticErrors: unknown[];
  readonly cleanupErrors: unknown[];
  readonly operationErrors: unknown[];

  constructor(options: {
    baseRef: string;
    currentBranch: string;
    conflictFiles: string[];
    diagnosticErrors?: unknown[];
    cleanupErrors: unknown[];
    operationErrors?: unknown[];
  }) {
    const diagnosticErrors = options.diagnosticErrors ? [...options.diagnosticErrors] : [];
    const cleanupErrors = [...options.cleanupErrors];
    const operationErrors = options.operationErrors ? [...options.operationErrors] : [];
    super(
      [...operationErrors, ...diagnosticErrors, ...cleanupErrors],
      `Merge cleanup failed while merging ${options.currentBranch} and ${options.baseRef}; checkout may require manual recovery`,
      { cause: operationErrors[0] ?? cleanupErrors[0] },
    );
    this.name = "MergeCleanupError";
    this.baseRef = options.baseRef;
    this.currentBranch = options.currentBranch;
    this.conflictFiles = [...options.conflictFiles];
    this.diagnosticErrors = diagnosticErrors;
    this.cleanupErrors = cleanupErrors;
    this.operationErrors = operationErrors;
  }
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

export interface CheckoutStatus {
  isGit: false;
}

export interface CheckoutStatusGitNonPaseo {
  isGit: true;
  repoRoot: string;
  mainRepoRoot: string | null;
  currentBranch: string | null;
  isDirty: boolean;
  baseRef: string | null;
  aheadBehind: AheadBehind | null;
  // Remote-tracking ref for currentBranch, e.g. "refs/remotes/origin/main". Null when the
  // branch has no upstream or git could not resolve it. aheadOfOrigin/behindOfOrigin are
  // measured against exactly this ref.
  upstreamRef: string | null;
  aheadOfOrigin: number | null;
  behindOfOrigin: number | null;
  hasRemote: boolean;
  remoteUrl: string | null;
  isPaseoOwnedWorktree: false;
}

export interface CheckoutStatusGitPaseo {
  isGit: true;
  repoRoot: string;
  mainRepoRoot: string;
  currentBranch: string | null;
  isDirty: boolean;
  baseRef: string;
  aheadBehind: AheadBehind | null;
  upstreamRef: string | null;
  aheadOfOrigin: number | null;
  behindOfOrigin: number | null;
  hasRemote: boolean;
  remoteUrl: string | null;
  isPaseoOwnedWorktree: true;
}

export type CheckoutStatusGit = CheckoutStatusGitNonPaseo | CheckoutStatusGitPaseo;

export type CheckoutStatusResult = CheckoutStatus | CheckoutStatusGit;

export type CheckoutDiffResult =
  | { diff: string; structured?: ParsedDiffFile[]; diffTooLarge?: false }
  | { diff: ""; structured: []; diffTooLarge: true };

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

export interface CheckoutContext {
  paseoHome?: string;
  worktreesRoot?: string;
  logger?: Pick<Logger, "trace" | "warn">;
  facts?: CheckoutSnapshotFacts | null;
}

export type CheckoutSnapshotFacts =
  | {
      isGit: false;
    }
  | {
      isGit: true;
      worktreeRoot: string;
      currentBranch: string | null;
      remoteUrl: string | null;
      absoluteGitDir: string | null;
      gitCommonDir: string | null;
      paseoWorktree: PaseoWorktreeForCwd;
      storedBaseRef: string | null;
      resolvedBaseRef: string | null;
      mainRepoRoot: string | null;
      comparisonBaseRef: string | null;
      branchRemoteName: string | null;
      branchMergeRef: string | null;
      upstreamStatus: UpstreamStatus | null;
      pullRequestLookupTarget: PullRequestStatusLookupTarget | null;
    };

function isNotGitRepositoryError(error: unknown): boolean {
  return error instanceof Error && /not a git repository/i.test(error.message);
}

async function requireGitRepo(cwd: string): Promise<void> {
  try {
    await runGitCommand(["rev-parse", "--git-dir"], { cwd, envOverlay: READ_ONLY_GIT_ENV });
  } catch {
    throw new NotGitRepoError(cwd);
  }
}

async function requireGitWorktreeRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await runGitCommand(["rev-parse", "--show-toplevel"], {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
    });
    const worktreeRoot = parseGitRevParsePath(stdout);
    if (!worktreeRoot) {
      throw new Error("Git returned no worktree root");
    }
    return worktreeRoot;
  } catch {
    throw new NotGitRepoError(cwd);
  }
}

export async function getCurrentBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
    });
    const branch = stdout.trim();
    if (branch === "HEAD") {
      return await getRebaseHeadBranch(cwd);
    }
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

async function getCurrentHeadSha(cwd: string, context?: CheckoutContext): Promise<string | null> {
  const knownSha = context?.facts?.isGit
    ? context.facts.pullRequestLookupTarget?.headSha
    : undefined;
  if (knownSha) {
    return knownSha;
  }
  try {
    const { stdout } = await runGitCommand(["rev-parse", "HEAD"], {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
      logger: context?.logger,
    });
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

async function addHeadShaToPullRequestLookupTarget(
  cwd: string,
  target: PullRequestStatusLookupTarget | null,
  context?: CheckoutContext,
): Promise<PullRequestStatusLookupTarget | null> {
  if (!target) {
    return null;
  }
  const headSha = await getCurrentHeadSha(cwd, context);
  return headSha ? { ...target, headSha } : target;
}

async function getRebaseHeadBranch(cwd: string): Promise<string | null> {
  const paths = ["rebase-merge/head-name", "rebase-apply/head-name"];
  const results = await Promise.all(
    paths.map(async (path): Promise<string | null> => {
      try {
        const { stdout } = await runGitCommand(["rev-parse", "--git-path", path], {
          cwd,
          envOverlay: READ_ONLY_GIT_ENV,
        });
        const headName = (await readFile(resolve(cwd, stdout.trim()), "utf8")).trim();
        if (headName.startsWith("refs/heads/")) {
          return headName.slice("refs/heads/".length) || null;
        }
        return headName || null;
      } catch {
        return null;
      }
    }),
  );
  return results.find((result): result is string => result !== null) ?? null;
}

async function getWorktreeRoot(cwd: string, context?: CheckoutContext): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["rev-parse", "--show-toplevel"], {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
      logger: context?.logger,
    });
    return parseGitRevParsePath(stdout);
  } catch (error) {
    if (!isNotGitRepositoryError(error)) {
      context?.logger?.warn(
        { err: error, cwd },
        "Git worktree discovery failed; treating directory as non-Git",
      );
    }
    return null;
  }
}

export async function getMainRepoRoot(cwd: string): Promise<string> {
  const { stdout: commonDirOut } = await runGitCommand(["rev-parse", "--git-common-dir"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  return getMainRepoRootFromCommonDir(cwd, resolveGitRevParsePath(cwd, commonDirOut));
}

async function getMainRepoRootFromCommonDir(
  cwd: string,
  commonDir: string | null,
  context?: CheckoutContext,
): Promise<string> {
  if (!commonDir) {
    throw new Error("Not in a git repository");
  }
  const normalized = realpathSync(commonDir);

  if (basename(normalized) === ".git") {
    return dirname(normalized);
  }

  const { stdout: worktreeOut } = await runGitCommand(["worktree", "list", "--porcelain"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  const worktrees = parseWorktreeList(worktreeOut);
  const nonBareNonPaseo = worktrees.filter(
    (wt) =>
      !wt.isBare &&
      !isPaseoWorktreePath(wt.path, {
        paseoHome: context?.paseoHome,
        worktreesRoot: context?.worktreesRoot,
      }),
  );
  const childrenOfBareRepo = nonBareNonPaseo.filter((wt) => isDescendantPath(wt.path, normalized));
  const mainChild = childrenOfBareRepo.find((wt) => basename(wt.path) === "main");
  return mainChild?.path ?? childrenOfBareRepo[0]?.path ?? nonBareNonPaseo[0]?.path ?? normalized;
}

export interface GitWorktreeEntry {
  path: string;
  branchRef?: string;
  isBare?: boolean;
}

/** Check whether a path is under Paseo's worktree root. */
export function isPaseoWorktreePath(
  p: string,
  options?: { paseoHome?: string; worktreesRoot?: string },
): boolean {
  if (options?.worktreesRoot || options?.paseoHome) {
    return isDescendantPath(p, resolvePaseoWorktreesBaseRoot(options));
  }
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
      envOverlay: READ_ONLY_GIT_ENV,
    });
    const entries = parseWorktreeList(stdout);
    const ref = branchName.startsWith("refs/heads/") ? branchName : `refs/heads/${branchName}`;
    return entries.find((entry) => entry.branchRef === ref)?.path ?? null;
  } catch {
    return null;
  }
}

export async function localBranchExists(cwd: string, branchName: string): Promise<boolean> {
  return doesGitRefExist(cwd, `refs/heads/${branchName}`);
}

export async function renameCurrentBranch(
  cwd: string,
  newName: string,
): Promise<{ previousBranch: string | null; currentBranch: string | null }> {
  const worktreeRoot = await requireGitWorktreeRoot(cwd);

  const previousBranch = await getCurrentBranch(cwd);
  if (!previousBranch || previousBranch === "HEAD") {
    throw new Error("Cannot rename branch in detached HEAD state");
  }

  await runGitCommand(["branch", "-m", newName], {
    cwd,
    timeout: 120_000,
  });

  const currentBranch = await getCurrentBranch(cwd);
  if (currentBranch) {
    rebindPaseoWorktreeChangeRequestHint(worktreeRoot, previousBranch, currentBranch);
  }
  return { previousBranch, currentBranch };
}

type PaseoWorktreeForCwd =
  | { isPaseoOwnedWorktree: false }
  | { isPaseoOwnedWorktree: true; worktreeRoot: string };

interface PaseoWorktreeLookupOptions {
  context?: CheckoutContext;
  knownWorktreeRoot?: string | null;
  knownGitCommonDir?: string | null;
}

async function getPaseoWorktreeForCwd(
  cwd: string,
  options: PaseoWorktreeLookupOptions = {},
): Promise<PaseoWorktreeForCwd> {
  // Fast-path reject: non-worktree paths do not need expensive ownership checks.
  if (!/[\\/]worktrees[\\/]/.test(cwd)) {
    return { isPaseoOwnedWorktree: false };
  }

  const ownership = await isPaseoOwnedWorktreeCwd(cwd, {
    paseoHome: options.context?.paseoHome,
    worktreesRoot: options.context?.worktreesRoot,
    knownGitCommonDir: options.knownGitCommonDir,
  });
  if (!ownership.allowed) {
    return { isPaseoOwnedWorktree: false };
  }

  return {
    isPaseoOwnedWorktree: true,
    worktreeRoot: options.knownWorktreeRoot ?? (await getWorktreeRoot(cwd, options.context)) ?? cwd,
  };
}

// Worktrees created before baseRef existed only stored the stripped name; it resolves
// local-first, which is the base they were actually cut from.
function storedBaseRefFromMetadata(metadata: PaseoWorktreeMetadata | null): string | null {
  return metadata?.baseRef ?? metadata?.baseRefName ?? null;
}

function readPaseoWorktreeBaseRef(worktreeRoot: string): string | null {
  return storedBaseRefFromMetadata(readPaseoWorktreeMetadata(worktreeRoot));
}

async function getStoredBaseRefForCwd(
  cwd: string,
  context?: CheckoutContext,
): Promise<string | null> {
  if (context?.facts?.isGit) {
    return context.facts.storedBaseRef;
  }
  const paseoWorktree = await getPaseoWorktreeForCwd(cwd, { context });
  if (!paseoWorktree.isPaseoOwnedWorktree) {
    return null;
  }

  return readPaseoWorktreeBaseRef(paseoWorktree.worktreeRoot);
}

async function getResolvedBaseRefForCwd(
  cwd: string,
  context?: CheckoutContext,
): Promise<string | null> {
  if (context?.facts?.isGit) {
    return context.facts.resolvedBaseRef;
  }
  const { resolvedBaseRef } = await resolveBaseRefForCwd(cwd, context);
  return resolvedBaseRef;
}

interface BaseRefResolution {
  storedBaseRef: string | null;
  resolvedBaseRef: string | null;
}

async function resolveBaseRefForCwd(
  cwd: string,
  context?: CheckoutContext,
): Promise<BaseRefResolution> {
  if (context?.facts?.isGit) {
    return {
      storedBaseRef: context.facts.storedBaseRef,
      resolvedBaseRef: context.facts.resolvedBaseRef,
    };
  }
  const storedBaseRef = await getStoredBaseRefForCwd(cwd, context);
  return {
    storedBaseRef,
    resolvedBaseRef: storedBaseRef ?? (await resolveBaseRef(cwd)),
  };
}

// The worktree stores the exact ref it was cut from ("refs/remotes/upstream/main") while
// callers still send its display name ("main"). A different qualified ref retains its own
// identity even when it has the same branch name.
function isSameBaseRef(stored: string, requested: string): boolean {
  return stored === requested || branchNameFromRef(stored) === requested;
}

// Names both refs rather than labelling either one correct: a caller's ref can be stale, but the
// stored ref can equally be wrong, so the message states the two facts and leaves the diagnosis open.
function baseRefMismatchError(refs: { stored: string; requested: string }): Error {
  return new Error(`Base ref mismatch: stored ${refs.stored}, requested ${refs.requested}`);
}

function resolveOperationBaseRef(input: {
  storedBaseRef: string | null;
  resolvedBaseRef: string | null;
  requestedBaseRef?: string;
}): string | null {
  if (
    input.storedBaseRef &&
    input.requestedBaseRef &&
    !isSameBaseRef(input.storedBaseRef, input.requestedBaseRef)
  ) {
    throw baseRefMismatchError({
      stored: input.storedBaseRef,
      requested: input.requestedBaseRef,
    });
  }
  return input.storedBaseRef ?? input.requestedBaseRef ?? input.resolvedBaseRef;
}

async function isWorkingTreeDirty(cwd: string, context?: CheckoutContext): Promise<boolean> {
  const { stdout } = await runGitCommand(["status", "--porcelain"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
    logger: context?.logger,
  });
  return stdout.trim().length > 0;
}

export async function getOriginRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["config", "--get", "remote.origin.url"], {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
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

async function getGitConfigValue(
  cwd: string,
  key: string,
  context?: CheckoutContext,
): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["config", "--get", key], {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
      logger: context?.logger,
    });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function getGitRemotePushUrl(
  cwd: string,
  remoteName: string,
  context?: CheckoutContext,
): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["remote", "get-url", "--push", remoteName], {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
      logger: context?.logger,
    });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function parseBranchMergeHeadRef(mergeRef: string | null): string | null {
  const prefix = "refs/heads/";
  if (!mergeRef?.startsWith(prefix)) {
    return null;
  }
  const headRef = mergeRef.slice(prefix.length).trim();
  return headRef.length > 0 ? headRef : null;
}

async function resolvePullRequestStatusLookupTarget(
  cwd: string,
  currentBranch: string,
  context?: CheckoutContext,
): Promise<PullRequestStatusLookupTarget> {
  if (context?.facts?.isGit && context.facts.pullRequestLookupTarget) {
    return context.facts.pullRequestLookupTarget;
  }
  const branchRemoteName = await getGitConfigValue(cwd, `branch.${currentBranch}.remote`, context);
  let branchMergeRef: string | null = null;
  if (branchRemoteName) {
    branchMergeRef = await getGitConfigValue(cwd, `branch.${currentBranch}.merge`, context);
  }

  const localBranchTarget = buildPullRequestLookupTargetFromBranchConfig({
    currentBranch,
    branchRemoteName,
    branchMergeRef,
    branchRemoteUrl: null,
    originRemoteUrl: null,
    resolvedBaseRef: null,
  });
  if (localBranchTarget.headRef === currentBranch) {
    const pushTarget = await resolvePullRequestLookupTargetFromPushConfig(
      cwd,
      currentBranch,
      null,
      null,
      context,
    );
    return pushTarget ?? localBranchTarget;
  }

  const [branchRemoteUrl, originRemoteUrl, resolvedBaseRef] = await Promise.all([
    branchRemoteName ? getGitConfigValue(cwd, `remote.${branchRemoteName}.url`, context) : null,
    getGitConfigValue(cwd, "remote.origin.url", context),
    getResolvedBaseRefForCwd(cwd, context),
  ]);
  const branchTarget = buildPullRequestLookupTargetFromBranchConfig({
    currentBranch,
    branchRemoteName,
    branchMergeRef,
    branchRemoteUrl,
    originRemoteUrl,
    resolvedBaseRef,
  });
  if (branchTarget.headRef !== currentBranch || branchTarget.headRepositoryOwner) {
    return branchTarget;
  }
  const pushTarget = await resolvePullRequestLookupTargetFromPushConfig(
    cwd,
    currentBranch,
    originRemoteUrl,
    resolvedBaseRef,
    context,
  );
  return pushTarget ?? branchTarget;
}

export async function resolveAbsoluteGitDir(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["rev-parse", "--absolute-git-dir"], {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
    });
    const gitDir = stdout.trim();
    return gitDir.length > 0 ? gitDir : null;
  } catch {
    return null;
  }
}

async function resolveGitCommonDir(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["rev-parse", "--git-common-dir"], {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
    });
    return resolveGitRevParsePath(cwd, stdout);
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
        envOverlay: READ_ONLY_GIT_ENV,
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
          envOverlay: READ_ONLY_GIT_ENV,
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
    envOverlay: READ_ONLY_GIT_ENV,
  });
  const branches = new Set(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );

  if (branches.has("main")) {
    return "main";
  }
  if (branches.has("master")) {
    return "master";
  }

  return null;
}

async function resolveBaseRef(repoRoot: string): Promise<string | null> {
  return resolveRepositoryDefaultBranch(repoRoot);
}

interface ComparisonBaseRefName {
  localName: string;
  originRef: string;
}

function normalizeComparisonBaseRefName(input: string): ComparisonBaseRefName {
  const localName = branchNameFromRef(input);
  return { localName, originRef: `origin/${localName}` };
}

function resolveMergeTargetBranch(baseRef: string): string {
  const remotePrefix = "refs/remotes/";
  const originPrefix = `${remotePrefix}origin/`;
  if (baseRef.startsWith(remotePrefix) && !baseRef.startsWith(originPrefix)) {
    throw new Error(`No local merge target is recorded for base ref ${baseRef}`);
  }
  return branchNameFromRef(baseRef);
}

async function doesGitRefExist(
  cwd: string,
  fullRef: string,
  context?: CheckoutContext,
): Promise<boolean> {
  const result = await runGitCommand(["show-ref", "--verify", "--quiet", fullRef], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
    acceptExitCodes: [0, 1],
    logger: context?.logger,
  });
  return result.exitCode === 0;
}

function isQualifiedBranchRef(ref: string): boolean {
  return ref.startsWith("refs/heads/") || ref.startsWith("refs/remotes/");
}

async function resolveBestComparisonBaseRef(
  cwd: string,
  baseRef: string,
  context?: CheckoutContext,
): Promise<string> {
  // A fully qualified branch ref names the exact commit stream to compare against. Bare names
  // keep going through the local-vs-origin heuristic below for legacy worktree metadata.
  if (isQualifiedBranchRef(baseRef)) {
    if (await doesGitRefExist(cwd, baseRef, context)) {
      return baseRef;
    }
    throw new Error(`Base ref not found: ${baseRef}`);
  }
  const normalized = normalizeComparisonBaseRefName(baseRef);
  const [hasLocal, hasOrigin] = await Promise.all([
    doesGitRefExist(cwd, `refs/heads/${normalized.localName}`, context),
    doesGitRefExist(cwd, `refs/remotes/origin/${normalized.localName}`, context),
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

async function resolveMostAheadBaseRef(cwd: string, baseRef: string): Promise<string> {
  if (isQualifiedBranchRef(baseRef)) {
    if (await doesGitRefExist(cwd, baseRef)) {
      return baseRef;
    }
    throw new Error(`Base ref not found: ${baseRef}`);
  }
  const normalizedBaseRef = branchNameFromRef(baseRef);
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
    { cwd, envOverlay: READ_ONLY_GIT_ENV },
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
  context?: CheckoutContext,
): Promise<AheadBehind | null> {
  const normalizedBaseRef = branchNameFromRef(baseRef);
  if (!normalizedBaseRef || !currentBranch || normalizedBaseRef === currentBranch) {
    return null;
  }
  const comparisonBaseRef =
    context?.facts?.isGit && context.facts.resolvedBaseRef === baseRef
      ? context.facts.comparisonBaseRef
      : await resolveBestComparisonBaseRef(cwd, baseRef, context);
  if (!comparisonBaseRef) {
    return null;
  }
  return getAheadBehindForComparisonRef(cwd, comparisonBaseRef, currentBranch, context);
}

export interface UpstreamStatus {
  ref: string;
  aheadBehind: AheadBehind;
}

async function getAheadBehindForComparisonRef(
  cwd: string,
  comparisonRef: string,
  currentBranch: string,
  context?: CheckoutContext,
): Promise<AheadBehind | null> {
  const { stdout } = await runGitCommand(
    ["rev-list", "--left-right", "--count", `${comparisonRef}...${currentBranch}`],
    { cwd, envOverlay: READ_ONLY_GIT_ENV, logger: context?.logger },
  );
  const [behindRaw, aheadRaw] = stdout.trim().split(/\s+/);
  const behind = Number.parseInt(behindRaw ?? "0", 10);
  const ahead = Number.parseInt(aheadRaw ?? "0", 10);
  if (Number.isNaN(behind) || Number.isNaN(ahead)) {
    return null;
  }
  return { ahead, behind };
}

async function getUpstreamStatus(
  cwd: string,
  currentBranch: string,
  context?: CheckoutContext,
): Promise<UpstreamStatus | null> {
  try {
    const { stdout } = await runGitCommand(
      [
        "for-each-ref",
        "--format=%(upstream)%00%(upstream:track,nobracket)",
        `refs/heads/${currentBranch}`,
      ],
      { cwd, envOverlay: READ_ONLY_GIT_ENV, logger: context?.logger },
    );
    const [ref = "", track = ""] = stdout.trim().split("\0", 2);
    if (!ref || track === "gone") {
      return null;
    }
    const ahead = Number.parseInt(track.match(/ahead (\d+)/)?.[1] ?? "0", 10);
    const behind = Number.parseInt(track.match(/behind (\d+)/)?.[1] ?? "0", 10);
    return { ref, aheadBehind: { ahead, behind } };
  } catch {
    return null;
  }
}

interface CheckoutInspectionContext {
  worktreeRoot: string;
  currentBranch: string | null;
  remoteUrl: string | null;
  absoluteGitDir: string | null;
  gitCommonDir: string | null;
  paseoWorktree: PaseoWorktreeForCwd;
}

async function inspectCheckoutContext(
  cwd: string,
  context?: CheckoutContext,
): Promise<CheckoutInspectionContext | null> {
  const root = await getWorktreeRoot(cwd, context);
  if (!root) {
    return null;
  }

  const [currentBranch, remoteUrl, absoluteGitDir, gitCommonDir] = await Promise.all([
    getCurrentBranch(cwd),
    getOriginRemoteUrl(cwd),
    resolveAbsoluteGitDir(cwd),
    resolveGitCommonDir(cwd),
  ]);
  const paseoWorktree = await getPaseoWorktreeForCwd(cwd, {
    context,
    knownWorktreeRoot: root,
    knownGitCommonDir: gitCommonDir,
  });

  return {
    worktreeRoot: root,
    currentBranch,
    remoteUrl,
    absoluteGitDir,
    gitCommonDir,
    paseoWorktree,
  };
}

function buildPullRequestLookupTargetFromBranchConfig(
  input: PullRequestLookupTargetBranchConfig,
): PullRequestStatusLookupTarget {
  const trackedHeadRef = parseBranchMergeHeadRef(input.branchMergeRef);
  if (!input.branchRemoteName || !trackedHeadRef) {
    return { headRef: input.currentBranch };
  }

  const remoteRepo = parseRepositoryIdentityFromRemote(input.branchRemoteUrl);
  const originRepo = parseRepositoryIdentityFromRemote(input.originRemoteUrl);
  const isSameRepo = areSameGitHubRepository(remoteRepo, originRepo);
  const headRepositoryOwner = remoteRepo && !isSameRepo ? remoteRepo.split("/")[0] : null;
  const normalizedBaseRef = input.resolvedBaseRef ? branchNameFromRef(input.resolvedBaseRef) : null;
  if (
    trackedHeadRef === normalizedBaseRef &&
    !doesLocalBranchNameIdentifyTrackedHead(
      input.currentBranch,
      trackedHeadRef,
      headRepositoryOwner,
    )
  ) {
    return { headRef: input.currentBranch };
  }

  if (isSameRepo) {
    return { headRef: trackedHeadRef };
  }

  return {
    headRef: trackedHeadRef,
    ...(headRepositoryOwner ? { headRepositoryOwner } : {}),
  };
}

function parseRepositoryIdentityFromRemote(remoteUrl: string | null): string | null {
  if (!remoteUrl) {
    return null;
  }
  const location = parseGitRemoteLocation(remoteUrl);
  return location ? (parseGitHubRemoteIdentity(location.path)?.repo ?? null) : null;
}

function areSameGitHubRepository(left: string | null, right: string | null): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function doesLocalBranchNameIdentifyTrackedHead(
  currentBranch: string,
  trackedHeadRef: string,
  headRepositoryOwner: string | null,
): boolean {
  if (currentBranch === trackedHeadRef) {
    return true;
  }
  if (!headRepositoryOwner) {
    return false;
  }
  return [headRepositoryOwner, headRepositoryOwner.toLowerCase()].some(
    (owner) => currentBranch === `${owner}/${trackedHeadRef}`,
  );
}

function buildPullRequestLookupTargetFromPushConfig(
  input: PullRequestLookupTargetPushConfig,
): PullRequestStatusLookupTarget | null {
  const pushedHeadRef = parseHeadPushRefspec(input.pushRefspec);
  if (!input.pushRemoteName || !pushedHeadRef || pushedHeadRef === input.currentBranch) {
    return null;
  }

  const remoteRepo = input.pushRemoteUrl ? parseGitHubRepoFromRemote(input.pushRemoteUrl) : null;
  const originRepo = input.originRemoteUrl
    ? parseGitHubRepoFromRemote(input.originRemoteUrl)
    : null;
  const isSameRepo = areSameGitHubRepository(remoteRepo, originRepo);
  const headRepositoryOwner = remoteRepo && !isSameRepo ? remoteRepo.split("/")[0] : null;
  const normalizedBaseRef = input.resolvedBaseRef ? branchNameFromRef(input.resolvedBaseRef) : null;
  if (pushedHeadRef === normalizedBaseRef && !headRepositoryOwner) {
    return null;
  }

  return {
    headRef: pushedHeadRef,
    ...(headRepositoryOwner ? { headRepositoryOwner } : {}),
  };
}

function buildPullRequestLookupTargetFromMetadata(
  metadata: PaseoWorktreeMetadata | null,
  currentBranch: string,
): PullRequestStatusLookupTarget | null {
  const target = getPaseoWorktreeChangeRequestHintForBranch(metadata, currentBranch);
  if (!target) {
    return null;
  }
  return {
    headRef: target.headRef,
    ...(target.headRepositoryOwner ? { headRepositoryOwner: target.headRepositoryOwner } : {}),
  };
}

function buildInitialPullRequestLookupTarget(input: {
  currentBranch: string | null;
  metadata: PaseoWorktreeMetadata | null;
  branchRemoteName: string | null;
  branchMergeRef: string | null;
  branchRemoteUrl: string | null;
  originRemoteUrl: string | null;
  resolvedBaseRef: string | null;
}): PullRequestStatusLookupTarget | null {
  if (!input.currentBranch) {
    return null;
  }

  const hasConfiguredBranchTarget = Boolean(
    input.branchRemoteName && parseBranchMergeHeadRef(input.branchMergeRef),
  );
  if (hasConfiguredBranchTarget) {
    return buildPullRequestLookupTargetFromBranchConfig({
      currentBranch: input.currentBranch,
      branchRemoteName: input.branchRemoteName,
      branchMergeRef: input.branchMergeRef,
      branchRemoteUrl: input.branchRemoteUrl,
      originRemoteUrl: input.originRemoteUrl,
      resolvedBaseRef: input.resolvedBaseRef,
    });
  }

  return (
    buildPullRequestLookupTargetFromMetadata(input.metadata, input.currentBranch) ??
    buildPullRequestLookupTargetFromBranchConfig({
      currentBranch: input.currentBranch,
      branchRemoteName: input.branchRemoteName,
      branchMergeRef: input.branchMergeRef,
      branchRemoteUrl: input.branchRemoteUrl,
      originRemoteUrl: input.originRemoteUrl,
      resolvedBaseRef: input.resolvedBaseRef,
    })
  );
}

async function resolvePullRequestLookupTargetFromPushConfig(
  cwd: string,
  currentBranch: string,
  knownOriginRemoteUrl: string | null,
  knownResolvedBaseRef: string | null,
  context?: CheckoutContext,
): Promise<PullRequestStatusLookupTarget | null> {
  const pushRemoteName = await getGitConfigValue(
    cwd,
    `branch.${currentBranch}.pushRemote`,
    context,
  );
  if (!pushRemoteName) {
    return null;
  }

  const [pushRefspec, pushRemoteUrl, originRemoteUrl, resolvedBaseRef] = await Promise.all([
    getGitConfigValue(cwd, `remote.${pushRemoteName}.push`, context),
    getGitConfigValue(cwd, `remote.${pushRemoteName}.url`, context),
    knownOriginRemoteUrl === null ? getGitConfigValue(cwd, "remote.origin.url", context) : null,
    knownResolvedBaseRef === null ? getResolvedBaseRefForCwd(cwd, context) : null,
  ]);
  return buildPullRequestLookupTargetFromPushConfig({
    currentBranch,
    pushRemoteName,
    pushRefspec,
    pushRemoteUrl,
    originRemoteUrl: knownOriginRemoteUrl ?? originRemoteUrl,
    resolvedBaseRef: knownResolvedBaseRef ?? resolvedBaseRef,
  });
}

export async function getCheckoutSnapshotFacts(
  cwd: string,
  context?: CheckoutContext,
): Promise<CheckoutSnapshotFacts> {
  if (context?.facts) {
    return context.facts;
  }

  const inspected = await inspectCheckoutContext(cwd, context);
  if (!inspected) {
    return { isGit: false };
  }

  const paseoWorktreeMetadata = inspected.paseoWorktree.isPaseoOwnedWorktree
    ? readPaseoWorktreeMetadata(inspected.paseoWorktree.worktreeRoot)
    : null;
  const storedBaseRef = storedBaseRefFromMetadata(paseoWorktreeMetadata);
  const resolvedBaseRef = storedBaseRef ?? (await resolveBaseRef(cwd));
  const mainRepoRoot = await getMainRepoRootFromCommonDir(
    cwd,
    inspected.gitCommonDir,
    context,
  ).catch(() => null);
  let comparisonBaseRef: string | null = null;
  if (
    resolvedBaseRef &&
    inspected.currentBranch &&
    branchNameFromRef(resolvedBaseRef) !== inspected.currentBranch
  ) {
    comparisonBaseRef = await resolveBestComparisonBaseRef(cwd, resolvedBaseRef, context).catch(
      () => null,
    );
  }

  let branchRemoteName: string | null = null;
  let branchMergeRef: string | null = null;
  let branchRemoteUrl: string | null = null;
  const upstreamStatusPromise = inspected.currentBranch
    ? getUpstreamStatus(cwd, inspected.currentBranch, context)
    : Promise.resolve(null);
  if (inspected.currentBranch) {
    branchRemoteName = await getGitConfigValue(
      cwd,
      `branch.${inspected.currentBranch}.remote`,
      context,
    );
    if (branchRemoteName) {
      [branchMergeRef, branchRemoteUrl] = await Promise.all([
        getGitConfigValue(cwd, `branch.${inspected.currentBranch}.merge`, context),
        branchRemoteName === "origin"
          ? inspected.remoteUrl
          : getGitConfigValue(cwd, `remote.${branchRemoteName}.url`, context),
      ]);
    }
  }
  let pullRequestLookupTarget = buildInitialPullRequestLookupTarget({
    currentBranch: inspected.currentBranch,
    metadata: paseoWorktreeMetadata,
    branchRemoteName,
    branchMergeRef,
    branchRemoteUrl,
    originRemoteUrl: inspected.remoteUrl,
    resolvedBaseRef,
  });
  if (
    inspected.currentBranch &&
    pullRequestLookupTarget?.headRef === inspected.currentBranch &&
    !pullRequestLookupTarget.headRepositoryOwner
  ) {
    pullRequestLookupTarget =
      (await resolvePullRequestLookupTargetFromPushConfig(
        cwd,
        inspected.currentBranch,
        inspected.remoteUrl,
        resolvedBaseRef,
        context,
      )) ?? pullRequestLookupTarget;
  }
  pullRequestLookupTarget = await addHeadShaToPullRequestLookupTarget(
    cwd,
    pullRequestLookupTarget,
    context,
  );
  const upstreamStatus = await upstreamStatusPromise;

  return {
    isGit: true,
    worktreeRoot: inspected.worktreeRoot,
    currentBranch: inspected.currentBranch,
    remoteUrl: inspected.remoteUrl,
    absoluteGitDir: inspected.absoluteGitDir,
    gitCommonDir: inspected.gitCommonDir,
    paseoWorktree: inspected.paseoWorktree,
    storedBaseRef,
    resolvedBaseRef,
    mainRepoRoot,
    comparisonBaseRef,
    branchRemoteName,
    branchMergeRef,
    upstreamStatus,
    pullRequestLookupTarget,
  };
}

const PER_FILE_DIFF_MAX_BYTES = 1024 * 1024; // 1MB
const TOTAL_DIFF_MAX_BYTES = 2 * 1024 * 1024; // 2MB
const RELAY_MAX_FRAME_BYTES = 32 * 1024 * 1024;
const CHECKOUT_DIFF_FRAME_HEADROOM_BYTES = 1024 * 1024;
// Temporary until diffs load lazily per file. The Paseo relay's 32 MiB frame limit is
// binding: string frames are encrypted and base64-encoded. Reserve 1 MiB plaintext for
// the surrounding WebSocket JSON envelope after inverting that exact wire expansion.
export const CHECKOUT_DIFF_MAX_STRUCTURED_BYTES =
  maxBase64EncryptedPlaintextByteLength(RELAY_MAX_FRAME_BYTES) - CHECKOUT_DIFF_FRAME_HEADROOM_BYTES;

interface StructuredDiffAccumulator {
  files: ParsedDiffFile[];
  serializedBytes: number;
}

function createStructuredDiffAccumulator(): StructuredDiffAccumulator {
  return { files: [], serializedBytes: Buffer.byteLength("[]", "utf8") };
}

function appendStructuredFile(
  structured: StructuredDiffAccumulator,
  file: ParsedDiffFile,
): boolean {
  const separatorBytes = structured.files.length > 0 ? 1 : 0;
  const fileBytes = Buffer.byteLength(JSON.stringify(file), "utf8");
  const nextBytes = structured.serializedBytes + separatorBytes + fileBytes;
  if (nextBytes > CHECKOUT_DIFF_MAX_STRUCTURED_BYTES) {
    return false;
  }
  structured.files.push(file);
  structured.serializedBytes = nextBytes;
  return true;
}
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
      envOverlay: READ_ONLY_GIT_ENV,
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
  const facts = await getCheckoutSnapshotFacts(cwd, context);
  if (!facts.isGit) {
    return { isGit: false };
  }

  const worktreeRoot = facts.worktreeRoot;
  const currentBranch = facts.currentBranch;
  const remoteUrl = facts.remoteUrl;
  const paseoWorktree = facts.paseoWorktree;
  const isDirty = await isWorkingTreeDirty(cwd, context);
  const hasRemote = remoteUrl !== null;
  const baseRef = facts.resolvedBaseRef;
  const mainRepoRoot = facts.mainRepoRoot;
  const factsContext = { ...context, facts };
  const aheadBehind =
    baseRef && currentBranch
      ? await getAheadBehind(cwd, baseRef, currentBranch, factsContext)
      : null;
  const upstreamStatus = facts.upstreamStatus;
  // The wire carries the display name: clients label the base with it and send it back to
  // request diffs and merges. The exact ref stays in worktree.json and in facts, where the
  // comparisons and actions read it.
  const displayBaseRef = baseRef ? branchNameFromRef(baseRef) : null;
  const upstreamRef = upstreamStatus?.ref ?? null;
  const aheadOfOrigin = upstreamStatus?.aheadBehind.ahead ?? null;
  const behindOfOrigin = upstreamStatus?.aheadBehind.behind ?? null;

  if (paseoWorktree.isPaseoOwnedWorktree && baseRef) {
    return {
      isGit: true,
      repoRoot: worktreeRoot,
      mainRepoRoot: mainRepoRoot ?? worktreeRoot,
      currentBranch,
      isDirty,
      baseRef: displayBaseRef ?? baseRef,
      aheadBehind,
      upstreamRef,
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
    mainRepoRoot:
      mainRepoRoot && resolve(mainRepoRoot) !== resolve(worktreeRoot) ? mainRepoRoot : null,
    currentBranch,
    isDirty,
    baseRef: displayBaseRef,
    aheadBehind,
    upstreamRef,
    aheadOfOrigin,
    behindOfOrigin,
    hasRemote,
    remoteUrl,
    isPaseoOwnedWorktree: false,
  };
}

// Workspace history stays complete; base history is bounded context until the
// commits list supports paging older base commits.
const CHECKOUT_BASE_COMMIT_LIMIT = 10;
// Bytes git emits between fields/records. We split parsed output on these.
const COMMIT_FIELD_SEPARATOR = "\x00";
const COMMIT_RECORD_SEPARATOR = "\x1e";
// Record-separated, NUL-field-separated so arbitrary subject text stays parseable.
// `%x1e`/`%x00` are git placeholders (literal text in the arg, real bytes in the
// output) — passing actual NUL bytes as a process arg is rejected by Node.
const COMMIT_LOG_FORMAT = "%x1e%H%x00%h%x00%an%x00%aI%x00%s";

type CheckoutCommitFileStatus = NonNullable<CheckoutCommitFile["status"]>;

interface ParsedCheckoutCommit {
  sha: string;
  shortSha: string;
  authorName: string;
  authorDate: string;
  subject: string;
  files: CheckoutCommitFile[];
}

interface CheckoutCommitLogInput {
  cwd: string;
  revision: string;
  maxCount?: number;
}

function mapNameStatusLetter(letter: string): CheckoutCommitFileStatus | undefined {
  switch (letter) {
    case "A":
      return "added";
    case "C":
      return "added";
    case "M":
      return "modified";
    case "T":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return undefined;
  }
}

// A `--raw` line: `:<srcmode> <dstmode> <srcsha> <dstsha> <STATUS>\t<path>`
// (rename/copy add a second path: `R100\t<old>\t<new>`). The status token is the
// last space-separated field before the first tab. Keyed on the destination path.
function parseRawStatusLine(line: string, statuses: Map<string, CheckoutCommitFileStatus>): void {
  const tabParts = line.split("\t");
  const meta = tabParts[0] ?? "";
  const statusToken = meta.slice(meta.lastIndexOf(" ") + 1);
  const letter = statusToken.charAt(0);
  const status = mapNameStatusLetter(letter);
  if (!status) {
    return;
  }
  const path =
    letter === "R" || letter === "C" ? (tabParts[tabParts.length - 1] ?? "") : (tabParts[1] ?? "");
  if (!path) {
    return;
  }
  statuses.set(path, status);
}

// A `--numstat` line: `<adds>\t<dels>\t<path>` (renames use `old => new`, binary
// files report `-` for both counts). Keyed on the (normalized) destination path.
function parseNumstatLine(
  line: string,
  stats: Map<string, { additions: number; deletions: number }>,
): void {
  const parts = line.split("\t");
  if (parts.length < 3) {
    return;
  }
  const additionsField = parts[0] ?? "";
  const deletionsField = parts[1] ?? "";
  const path = normalizeNumstatPath(parts.slice(2).join("\t"));
  if (!path) {
    return;
  }
  if (additionsField === "-" || deletionsField === "-") {
    stats.set(path, { additions: 0, deletions: 0 });
    return;
  }
  const additions = Number.parseInt(additionsField, 10);
  const deletions = Number.parseInt(deletionsField, 10);
  if (Number.isNaN(additions) || Number.isNaN(deletions)) {
    return;
  }
  stats.set(path, { additions, deletions });
}

// Parses the single combined `git log ... --raw --numstat -M` stream. Each record
// (split on the record separator) starts with the NUL-field-separated header line,
// then a blank line, then the interleaved `--raw` (status) and `--numstat` (counts)
// blocks. We merge both by destination path so each file carries counts + status.
function parseCheckoutCommitRecords(stdout: string): ParsedCheckoutCommit[] {
  const records = stdout.split(COMMIT_RECORD_SEPARATOR).filter((record) => record.length > 0);
  const commits: ParsedCheckoutCommit[] = [];
  for (const record of records) {
    const lines = record.split("\n");
    const fields = (lines[0] ?? "").split(COMMIT_FIELD_SEPARATOR);
    if (fields.length < 5) {
      continue;
    }
    const sha = (fields[0] ?? "").trim();
    if (!sha) {
      continue;
    }

    const stats = new Map<string, { additions: number; deletions: number }>();
    const statuses = new Map<string, CheckoutCommitFileStatus>();
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!line) {
        continue;
      }
      if (line.startsWith(":")) {
        parseRawStatusLine(line, statuses);
      } else {
        parseNumstatLine(line, stats);
      }
    }

    const files: CheckoutCommitFile[] = [];
    for (const [path, stat] of stats) {
      const status = statuses.get(path);
      files.push({
        path,
        additions: stat.additions,
        deletions: stat.deletions,
        ...(status ? { status } : {}),
      });
    }

    commits.push({
      sha,
      shortSha: (fields[1] ?? "").trim(),
      authorName: fields[2] ?? "",
      authorDate: (fields[3] ?? "").trim(),
      subject: fields[4] ?? "",
      files,
    });
  }
  return commits;
}

// Returns commits reachable from HEAD that are not reachable from any remote ref.
async function getUnpushedCommitShas(cwd: string, context?: CheckoutContext): Promise<Set<string>> {
  const { stdout } = await runGitCommand(["rev-list", "HEAD", "--not", "--remotes"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
    logger: context?.logger,
  });
  return new Set(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

async function getCheckoutCommitRecords({
  cwd,
  revision,
  maxCount,
}: CheckoutCommitLogInput): Promise<ParsedCheckoutCommit[]> {
  const args = [
    "log",
    revision,
    "--diff-merges=first-parent",
    `--format=${COMMIT_LOG_FORMAT}`,
    "--raw",
    "--numstat",
    "-M",
  ];
  if (maxCount !== undefined) {
    args.splice(2, 0, `--max-count=${maxCount}`);
  }

  const result = await runGitCommand(args, { cwd, envOverlay: READ_ONLY_GIT_ENV });
  if (result.truncated) {
    throw new Error("Commit history exceeded the git output limit");
  }
  return parseCheckoutCommitRecords(result.stdout);
}

export interface CheckoutCommitsResult {
  baseRef: string | null;
  commits: CheckoutCommit[];
}

async function tryResolveCheckoutCommitsBaseRef(
  cwd: string,
  baseRef: string | null,
  currentBranch: string,
): Promise<string | null> {
  if (!baseRef) {
    return null;
  }
  const normalizedBaseRef = branchNameFromRef(baseRef);
  if (!normalizedBaseRef || normalizedBaseRef === currentBranch) {
    return null;
  }
  try {
    return await resolveMostAheadBaseRef(cwd, baseRef);
  } catch (error) {
    if (isQualifiedBranchRef(baseRef)) {
      throw error;
    }
    return null;
  }
}

export async function listCheckoutCommits({
  cwd,
  context,
}: {
  cwd: string;
  context?: CheckoutContext;
}): Promise<CheckoutCommitsResult> {
  const currentBranch = await getCurrentBranch(cwd);
  if (!currentBranch) {
    return { baseRef: null, commits: [] };
  }

  const { resolvedBaseRef } = await resolveBaseRefForCwd(cwd, context);
  const normalizedBaseRef = resolvedBaseRef ? branchNameFromRef(resolvedBaseRef) : null;
  let comparisonBaseRef = await tryResolveCheckoutCommitsBaseRef(
    cwd,
    resolvedBaseRef,
    currentBranch,
  );
  if (!comparisonBaseRef && normalizedBaseRef && normalizedBaseRef !== currentBranch) {
    // Saved worktree metadata can outlive a renamed or deleted base branch.
    comparisonBaseRef = await tryResolveCheckoutCommitsBaseRef(
      cwd,
      await resolveBaseRef(cwd),
      currentBranch,
    );
  }

  let workspaceRecords: ParsedCheckoutCommit[] = [];
  let baseRevision = "HEAD";
  if (comparisonBaseRef) {
    const [records, mergeBase] = await Promise.all([
      getCheckoutCommitRecords({ cwd, revision: `${comparisonBaseRef}..HEAD` }),
      tryResolveMergeBase(cwd, comparisonBaseRef),
    ]);
    workspaceRecords = records;
    baseRevision = mergeBase ?? "";
  }

  const baseRecords = baseRevision
    ? await getCheckoutCommitRecords({
        cwd,
        revision: baseRevision,
        maxCount: CHECKOUT_BASE_COMMIT_LIMIT,
      })
    : [];
  const records = [...workspaceRecords, ...baseRecords];
  if (records.length === 0) {
    return { baseRef: comparisonBaseRef, commits: [] };
  }

  const unpushedShas = await getUnpushedCommitShas(cwd);
  const workspaceShas = new Set(workspaceRecords.map((record) => record.sha));

  const commits = records.map((record) => ({
    sha: record.sha,
    shortSha: record.shortSha,
    subject: record.subject,
    authorName: record.authorName,
    authorDate: record.authorDate,
    isOnRemote: !unpushedShas.has(record.sha),
    isOnBase: !workspaceShas.has(record.sha),
    files: record.files,
  }));

  return { baseRef: comparisonBaseRef, commits };
}

/**
 * Fetches the unified diff of a single file as introduced by one commit and
 * parses it into the same {@link ParsedDiffFile} shape the diff subscription
 * emits (so the client can reuse its existing renderer).
 *
 * Compares merge commits to their first parent, matching the linear history shown
 * in the explorer. The text is parsed and highlighted by
 * {@link parseAndHighlightDiff} — the exact parser the diff subscription uses.
 * Returns `null` when the file is absent from the commit or the change is
 * binary-only (no textual hunks). Throws on git failure (e.g. an unknown sha),
 * which the caller maps to a typed checkout error.
 */
export async function getCommitFileDiff({
  cwd,
  sha,
  path,
}: {
  cwd: string;
  sha: string;
  path: string;
}): Promise<ParsedDiffFile | null> {
  const { stdout } = await runGitCommand(
    ["show", sha, "--format=", "--diff-merges=first-parent", "--", path],
    {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
    },
  );

  if (stdout.trim().length === 0) {
    return null;
  }

  const parsedFiles = await parseAndHighlightDiff(stdout, cwd, {
    getOldFileContent: (file) => readGitFileContentAtRef(cwd, `${sha}^`, file.path),
    getNewFileContent: (file) => readGitFileContentAtRef(cwd, sha, file.path),
  });

  // `--` scopes the diff to a single pathspec, so there is at most one real
  // entry. Pick by path to drop any stray header-only section the parser emits.
  const file = parsedFiles.find((candidate) => candidate.path === path) ?? null;
  if (!file) {
    return null;
  }

  // Binary changes carry a "Binary files ... differ" marker and no hunks; there
  // is nothing textual to render, so report them as absent.
  if (file.hunks.length === 0 && /^Binary files .* differ$/m.test(stdout)) {
    return null;
  }

  return file;
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
    additions = Number.parseInt(addMatch[1], 10);
  }
  const delMatch = trimmed.match(/(\d+)\s+deletion/);
  if (delMatch) {
    deletions = Number.parseInt(delMatch[1], 10);
  }

  if (additions === 0 && deletions === 0) {
    return null;
  }

  return { additions, deletions };
}

const UNTRACKED_SHORTSTAT_MAX_FILES = 500;

async function countUntrackedAdditions(cwd: string, throwOnGitError = false): Promise<number> {
  try {
    const { stdout } = await runGitCommand(["ls-files", "--others", "--exclude-standard"], {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
    });
    const files = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    let additions = 0;
    for (const file of files.slice(0, UNTRACKED_SHORTSTAT_MAX_FILES)) {
      const absolutePath = resolve(cwd, file);
      try {
        const metadata = await statFile(absolutePath);
        if (metadata.size > PER_FILE_DIFF_MAX_BYTES) continue;
        if (await isLikelyBinaryFile(absolutePath)) continue;
        const content = await readFile(absolutePath, "utf-8");
        if (content.length === 0) continue;
        const normalized = content.replace(/\r\n/g, "\n");
        const lineCount = normalized.split("\n").length;
        additions += normalized.endsWith("\n") ? lineCount - 1 : lineCount;
      } catch {
        // Skip unreadable files.
      }
    }
    return additions;
  } catch (error) {
    if (throwOnGitError) {
      throw error;
    }
    return 0;
  }
}

function handleShortstatGitError(error: unknown, throwOnGitError = false): null {
  if (throwOnGitError) {
    throw error;
  }
  return null;
}

async function getCheckoutShortstatUncached(
  cwd: string,
  context?: CheckoutContext,
  options?: { throwOnGitError?: boolean },
): Promise<CheckoutShortstat | null> {
  if (context?.facts?.isGit === false) {
    return null;
  }
  if (!context?.facts?.isGit) {
    try {
      await requireGitRepo(cwd);
    } catch {
      return null;
    }
  }

  const facts = context?.facts;
  const localBaseRef = facts?.isGit
    ? facts.resolvedBaseRef
    : await getResolvedBaseRefForCwd(cwd, context);
  const currentBranch = facts?.isGit ? facts.currentBranch : await getCurrentBranch(cwd);
  const comparisonRef = await resolveShortstatComparisonRef({
    cwd,
    currentBranch,
    localBaseRef,
    facts,
  });
  if (!comparisonRef) {
    return null;
  }

  try {
    const { stdout: mergeBaseOut } = await runGitCommand(["merge-base", "HEAD", comparisonRef], {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
    });
    const mergeBase = mergeBaseOut.trim();
    if (!mergeBase) {
      return null;
    }

    const [{ stdout }, untrackedAdditions] = await Promise.all([
      runGitCommand(["diff", "--shortstat", mergeBase], {
        cwd,
        envOverlay: READ_ONLY_GIT_ENV,
      }),
      countUntrackedAdditions(cwd, options?.throwOnGitError),
    ]);

    const tracked = parseCheckoutShortstat(stdout);

    if (tracked) {
      return { additions: tracked.additions + untrackedAdditions, deletions: tracked.deletions };
    }
    if (untrackedAdditions > 0) {
      return { additions: untrackedAdditions, deletions: 0 };
    }
    return null;
  } catch (error) {
    return handleShortstatGitError(error, options?.throwOnGitError);
  }
}

async function resolveShortstatComparisonRef(input: {
  cwd: string;
  currentBranch: string | null;
  localBaseRef: string | null;
  facts?: CheckoutSnapshotFacts | null;
}): Promise<string | null> {
  const { cwd, currentBranch, localBaseRef, facts } = input;
  if (!currentBranch) {
    return null;
  }

  if (localBaseRef && currentBranch !== localBaseRef) {
    try {
      return facts?.isGit && facts.resolvedBaseRef === localBaseRef && facts.comparisonBaseRef
        ? facts.comparisonBaseRef
        : await resolveBestComparisonBaseRef(cwd, localBaseRef);
    } catch {
      return null;
    }
  }

  const hasOrigin = await doesGitRefExist(cwd, `refs/remotes/origin/${currentBranch}`);
  return hasOrigin ? `origin/${currentBranch}` : null;
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

export interface CheckoutRefDerivedState {
  aheadBehind: AheadBehind | null;
  diffStat: CheckoutShortstat | null;
  upstreamStatus: UpstreamStatus | null;
}

function normalizeRemoteTrackingRef(ref: string): string {
  return ref.startsWith("refs/remotes/") ? ref.slice("refs/remotes/".length) : ref;
}

function checkoutFactsConfiguredRemoteRef(
  facts: Extract<CheckoutSnapshotFacts, { isGit: true }>,
): string | null {
  const trackedBranch = facts.branchMergeRef?.startsWith("refs/heads/")
    ? facts.branchMergeRef.slice("refs/heads/".length)
    : null;
  return facts.branchRemoteName && facts.branchRemoteName !== "." && trackedBranch
    ? `${facts.branchRemoteName}/${trackedBranch}`
    : null;
}

function getCheckoutRefMovement(
  facts: Extract<CheckoutSnapshotFacts, { isGit: true }>,
  movedRemoteRefs: ReadonlySet<string>,
): {
  baseMoved: boolean;
  comparisonRef: string | null;
  currentBranch: string | null;
  normalizedResolvedBase: string | null;
  upstreamMoved: boolean;
  upstreamRef: string | null;
} {
  const currentBranch = facts.currentBranch;
  const comparisonRef = facts.comparisonBaseRef;
  const normalizedMoves = new Set([...movedRemoteRefs].map(normalizeRemoteTrackingRef));
  const normalizedResolvedBase = facts.resolvedBaseRef
    ? branchNameFromRef(facts.resolvedBaseRef)
    : null;
  const shortstatRemoteRef =
    currentBranch && (!normalizedResolvedBase || normalizedResolvedBase === currentBranch)
      ? `origin/${currentBranch}`
      : null;
  const baseMoved = [facts.storedBaseRef, facts.resolvedBaseRef, comparisonRef, shortstatRemoteRef]
    .filter((ref): ref is string => Boolean(ref))
    .map(normalizeRemoteTrackingRef)
    .some((ref) => normalizedMoves.has(ref));
  const upstreamRef = facts.upstreamStatus?.ref ?? checkoutFactsConfiguredRemoteRef(facts);
  const upstreamMoved = upstreamRef
    ? normalizedMoves.has(normalizeRemoteTrackingRef(upstreamRef))
    : false;
  return {
    baseMoved,
    comparisonRef,
    currentBranch,
    normalizedResolvedBase,
    upstreamMoved,
    upstreamRef,
  };
}

export async function getCheckoutRefDerivedState(
  cwd: string,
  facts: Extract<CheckoutSnapshotFacts, { isGit: true }>,
  current: Pick<CheckoutRefDerivedState, "aheadBehind" | "diffStat">,
  movedRemoteRefs: ReadonlySet<string>,
  context?: CheckoutContext,
): Promise<CheckoutRefDerivedState> {
  const {
    baseMoved,
    comparisonRef,
    currentBranch,
    normalizedResolvedBase,
    upstreamMoved,
    upstreamRef,
  } = getCheckoutRefMovement(facts, movedRemoteRefs);

  let aheadBehind = current.aheadBehind;
  let diffStat = current.diffStat;
  if (baseMoved && currentBranch && facts.resolvedBaseRef) {
    aheadBehind = await getAheadBehind(cwd, facts.resolvedBaseRef, currentBranch, {
      ...context,
      facts,
    });
  }
  if (baseMoved || (upstreamMoved && currentBranch === normalizedResolvedBase)) {
    diffStat = await getCheckoutShortstatUncached(
      cwd,
      { ...context, facts },
      { throwOnGitError: true },
    );
  }

  let upstreamStatus = facts.upstreamStatus;
  if (upstreamMoved && currentBranch && upstreamRef) {
    const normalizedUpstream = normalizeRemoteTrackingRef(upstreamRef);
    const normalizedComparison = comparisonRef ? normalizeRemoteTrackingRef(comparisonRef) : null;
    const upstreamAheadBehind =
      baseMoved && normalizedComparison === normalizedUpstream
        ? aheadBehind
        : await getAheadBehindForComparisonRef(cwd, upstreamRef, currentBranch, context);
    upstreamStatus = upstreamAheadBehind
      ? {
          ref: facts.upstreamStatus?.ref ?? `refs/remotes/${normalizedUpstream}`,
          aheadBehind: upstreamAheadBehind,
        }
      : null;
  }

  return { aheadBehind, diffStat, upstreamStatus };
}

export interface CheckoutWorktreeState {
  isDirty: boolean;
  diffStat: CheckoutShortstat | null;
}

export async function getCheckoutWorktreeState(
  cwd: string,
  context: CheckoutContext,
): Promise<CheckoutWorktreeState> {
  const [isDirty, diffStat] = await Promise.all([
    isWorkingTreeDirty(cwd, context),
    getCheckoutShortstat(cwd, context, { force: true }),
  ]);
  return { isDirty, diffStat };
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
      return;
    })
    .catch(() => {
      // Non-critical: keep listing path resilient even if git commands fail.
    });
}

interface AppendStructuredTrackedDiffsInput {
  cwd: string;
  trackedChanges: CheckoutFileChange[];
  trackedNumstatByPath: Map<string, FileStat>;
  trackedPlaceholderByPath: Map<string, { status: "binary" | "too_large"; stat: FileStat }>;
  trackedDiffText: string;
  refsForDiff: CheckoutDiffRefs;
  ignoreWhitespace: boolean;
  structured: StructuredDiffAccumulator;
  appendTrackedPlaceholderComment: (
    change: CheckoutFileChange,
    status: "binary" | "too_large",
  ) => void;
}

async function buildHighlightedTrackedDiffFile(input: {
  cwd: string;
  change: CheckoutFileChange;
  parsedFile: ParsedDiffFile;
  refsForDiff: CheckoutDiffRefs;
}): Promise<ParsedDiffFile> {
  const { cwd, change, parsedFile, refsForDiff } = input;
  const refPath = change.oldPath ?? change.path;
  const [oldFileContent, newFileContent] = await Promise.all([
    change.isNew ? null : readGitFileContentAtRef(cwd, refsForDiff.baseRef, refPath),
    refsForDiff.targetRef ? readGitFileContentAtRef(cwd, refsForDiff.targetRef, change.path) : null,
  ]);
  const highlightedFile = await highlightDiffWithFileContent(parsedFile, cwd, {
    oldFileContent,
    newFileContent,
  });
  return {
    ...highlightedFile,
    path: change.path,
    isNew: change.isNew,
    isDeleted: change.isDeleted,
    status: "ok",
  };
}

function isWhitespaceOnlyTrackedChange(input: {
  change: CheckoutFileChange;
  stat: FileStat;
  ignoreWhitespace: boolean;
}): boolean {
  const { change, stat, ignoreWhitespace } = input;
  return (
    ignoreWhitespace &&
    change.status.startsWith("M") &&
    (!stat || (!stat.isBinary && stat.additions === 0 && stat.deletions === 0))
  );
}

async function appendStructuredTrackedDiffs(
  input: AppendStructuredTrackedDiffsInput,
): Promise<boolean> {
  const {
    cwd,
    trackedChanges,
    trackedNumstatByPath,
    trackedPlaceholderByPath,
    trackedDiffText,
    refsForDiff,
    ignoreWhitespace,
    structured,
    appendTrackedPlaceholderComment,
  } = input;

  const parsedTrackedFiles = trackedDiffText.length > 0 ? parseDiff(trackedDiffText) : [];
  const parsedTrackedByPath = new Map(parsedTrackedFiles.map((file) => [file.path, file]));

  for (const change of trackedChanges) {
    const placeholder = trackedPlaceholderByPath.get(change.path);
    if (placeholder) {
      const file = buildPlaceholderParsedDiffFile(change, {
        status: placeholder.status,
        stat: placeholder.stat,
      });
      if (!appendStructuredFile(structured, file)) {
        return false;
      }
      appendTrackedPlaceholderComment(change, placeholder.status);
      continue;
    }

    const stat = trackedNumstatByPath.get(change.path) ?? null;
    const parsedFile = parsedTrackedByPath.get(change.path);
    if (parsedFile) {
      const file = await buildHighlightedTrackedDiffFile({
        cwd,
        change,
        parsedFile,
        refsForDiff,
      });
      if (!appendStructuredFile(structured, file)) {
        return false;
      }
      continue;
    }

    // `git diff -w --name-status` can still report a modified path even when the
    // whitespace-filtered patch and numstat are both empty. Skip emitting a
    // structured placeholder in that case so whitespace-only edits truly disappear.
    if (isWhitespaceOnlyTrackedChange({ change, stat, ignoreWhitespace })) {
      continue;
    }

    const file = {
      path: change.path,
      isNew: change.isNew,
      isDeleted: change.isDeleted,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      hunks: [],
      status: "ok",
    } satisfies ParsedDiffFile;
    if (!appendStructuredFile(structured, file)) {
      return false;
    }
  }

  return true;
}

interface ProcessUntrackedChangeInput {
  cwd: string;
  change: CheckoutFileChange;
  ignoreWhitespace: boolean;
  includeStructured: boolean;
  structured: StructuredDiffAccumulator;
  appendDiff: (text: string) => void;
}

async function processUntrackedChange(input: ProcessUntrackedChangeInput): Promise<boolean> {
  const { cwd, change, ignoreWhitespace, includeStructured, structured, appendDiff } = input;
  const { text, truncated, stat } = await getUntrackedDiffText(cwd, change, ignoreWhitespace);

  if (!includeStructured) {
    if (stat?.isBinary) {
      appendDiff(`# ${change.path}: binary diff omitted\n`);
    } else if (truncated) {
      appendDiff(`# ${change.path}: diff too large omitted\n`);
    } else {
      appendDiff(text);
    }
    return true;
  }

  if (stat?.isBinary) {
    if (
      !appendStructuredFile(
        structured,
        buildPlaceholderParsedDiffFile(change, { status: "binary", stat }),
      )
    ) {
      return false;
    }
    appendDiff(`# ${change.path}: binary diff omitted\n`);
    return true;
  }

  if (truncated) {
    if (
      !appendStructuredFile(
        structured,
        buildPlaceholderParsedDiffFile(change, { status: "too_large", stat }),
      )
    ) {
      return false;
    }
    appendDiff(`# ${change.path}: diff too large omitted\n`);
    return true;
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

  const file = {
    ...parsedFile,
    path: change.path,
    isNew: change.isNew,
    isDeleted: change.isDeleted,
    status: "ok",
  } satisfies ParsedDiffFile;
  return appendStructuredFile(structured, file);
}

interface ProcessTrackedChangesInput {
  cwd: string;
  refsForDiff: CheckoutDiffRefs;
  trackedChanges: CheckoutFileChange[];
  ignoreWhitespace: boolean;
  appendDiff: (text: string) => void;
}

interface ProcessTrackedChangesResult {
  trackedNumstatByPath: Map<string, FileStat>;
  trackedPlaceholderByPath: Map<string, { status: "binary" | "too_large"; stat: FileStat }>;
  trackedDiffText: string;
}

async function processTrackedChanges(
  input: ProcessTrackedChangesInput,
): Promise<ProcessTrackedChangesResult> {
  const { cwd, refsForDiff, trackedChanges, ignoreWhitespace, appendDiff } = input;
  const trackedNumstatByPath =
    trackedChanges.length > 0
      ? await getTrackedNumstatByPath(cwd, refsForDiff, ignoreWhitespace)
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
    trackedDiffPaths.push(change.path);
  }

  let trackedDiffText = "";
  let trackedDiffBytes = 0;
  for (let start = 0; start < trackedDiffPaths.length; start += TRACKED_DIFF_BATCH_SIZE) {
    const paths = trackedDiffPaths.slice(start, start + TRACKED_DIFF_BATCH_SIZE);
    const trackedDiffs = await Promise.all(
      paths.map((path) =>
        getTrackedDiffTextForPath({
          cwd,
          refsForDiff,
          path,
          ignoreWhitespace,
        }),
      ),
    );

    for (const fileDiff of trackedDiffs) {
      if (fileDiff.truncated) {
        trackedPlaceholderByPath.set(fileDiff.path, {
          status: "too_large",
          stat: trackedNumstatByPath.get(fileDiff.path) ?? null,
        });
        continue;
      }
      const diffBytes = Buffer.byteLength(fileDiff.text, "utf8");
      if (trackedDiffBytes + diffBytes > TOTAL_DIFF_MAX_BYTES) {
        trackedPlaceholderByPath.set(fileDiff.path, {
          status: "too_large",
          stat: trackedNumstatByPath.get(fileDiff.path) ?? null,
        });
        continue;
      }
      trackedDiffBytes += diffBytes;
      trackedDiffText += fileDiff.text;
    }
  }
  appendDiff(trackedDiffText);

  return {
    trackedNumstatByPath,
    trackedPlaceholderByPath,
    trackedDiffText,
  };
}

async function resolveCheckoutDiffRefs(
  cwd: string,
  compare: CheckoutDiffCompare,
  context: CheckoutContext | undefined,
): Promise<CheckoutDiffRefs | null> {
  if (compare.mode === "uncommitted") {
    return { baseRef: "HEAD", includeUntracked: true };
  }
  const { storedBaseRef, resolvedBaseRef } = await resolveBaseRefForCwd(cwd, context);
  const baseRef = resolveOperationBaseRef({
    storedBaseRef,
    resolvedBaseRef,
    requestedBaseRef: compare.baseRef,
  });
  if (!baseRef) {
    return null;
  }
  const bestBaseRef = await resolveBestComparisonBaseRef(cwd, baseRef);
  return {
    baseRef: (await tryResolveMergeBase(cwd, bestBaseRef)) ?? bestBaseRef,
    targetRef: "HEAD",
    includeUntracked: false,
  };
}

export async function getCheckoutDiff(
  cwd: string,
  compare: CheckoutDiffCompare,
  context?: CheckoutContext,
): Promise<CheckoutDiffResult> {
  await requireGitRepo(cwd);

  const refsForDiff = await resolveCheckoutDiffRefs(cwd, compare, context);
  if (!refsForDiff) {
    return { diff: "" };
  }

  const ignoreWhitespace = compare.ignoreWhitespace === true;
  let effectiveRefsForDiff = refsForDiff;
  let changes: CheckoutFileChange[];
  try {
    changes = await listCheckoutFileChanges(cwd, effectiveRefsForDiff, ignoreWhitespace);
  } catch (error) {
    if (!isUnbornHeadDiffError(error)) {
      throw error;
    }
    effectiveRefsForDiff = { ...refsForDiff, baseRef: EMPTY_TREE_OBJECT_ID };
    changes = await listCheckoutFileChanges(cwd, effectiveRefsForDiff, ignoreWhitespace);
  }
  changes.sort((a, b) => {
    if (a.path === b.path) return 0;
    return a.path < b.path ? -1 : 1;
  });

  const structured = createStructuredDiffAccumulator();
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
  const trackedDiff = await processTrackedChanges({
    cwd,
    refsForDiff: effectiveRefsForDiff,
    trackedChanges,
    ignoreWhitespace,
    appendDiff,
  });

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
    const didAppendTrackedDiffs = await appendStructuredTrackedDiffs({
      cwd,
      trackedChanges,
      trackedNumstatByPath: trackedDiff.trackedNumstatByPath,
      trackedPlaceholderByPath: trackedDiff.trackedPlaceholderByPath,
      trackedDiffText: trackedDiff.trackedDiffText,
      refsForDiff: effectiveRefsForDiff,
      ignoreWhitespace,
      structured,
      appendTrackedPlaceholderComment,
    });
    if (!didAppendTrackedDiffs) {
      return { diff: "", structured: [], diffTooLarge: true };
    }
  } else {
    for (const change of trackedChanges) {
      const placeholder = trackedDiff.trackedPlaceholderByPath.get(change.path);
      if (placeholder) {
        appendTrackedPlaceholderComment(change, placeholder.status);
      }
    }
  }

  for (const change of untrackedChanges) {
    if (diffBytes >= TOTAL_DIFF_MAX_BYTES) {
      break;
    }
    const didAppendUntrackedDiff = await processUntrackedChange({
      cwd,
      change,
      ignoreWhitespace,
      includeStructured: compare.includeStructured === true,
      structured,
      appendDiff,
    });
    if (!didAppendUntrackedDiff) {
      return { diff: "", structured: [], diffTooLarge: true };
    }
  }

  if (compare.includeStructured) {
    return { diff: diffText, structured: structured.files };
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

interface HandleFailedMergeInput {
  cwd: string;
  error: unknown;
  baseRef: string;
  currentBranch: string;
  direction: "to-base" | "from-base";
  mode: "merge" | "squash";
}

interface MergeConflictDiagnostics {
  conflictFiles: string[];
  errors: unknown[];
}

async function collectMergeConflictDiagnostics(cwd: string): Promise<MergeConflictDiagnostics> {
  let unmergedOutput = "";
  let lsFilesOutput = "";
  let statusOutput = "";
  const errors: unknown[] = [];

  try {
    unmergedOutput = (await runGitCommand(["diff", "--name-only", "--diff-filter=U"], { cwd }))
      .stdout;
  } catch (error) {
    errors.push(error);
  }
  try {
    lsFilesOutput = (await runGitCommand(["ls-files", "-u"], { cwd })).stdout;
  } catch (error) {
    errors.push(error);
  }
  try {
    statusOutput = (await runGitCommand(["status", "--porcelain"], { cwd })).stdout;
  } catch (error) {
    errors.push(error);
  }

  const statusConflicts = statusOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /^(UU|AA|DD|AU|UA|UD|DU)\s/.test(line))
    .map((line) => line.slice(3).trim());
  const conflictFiles = [
    ...unmergedOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    ...lsFilesOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split("\t").at(-1) ?? ""),
    ...statusConflicts,
  ].filter(Boolean);

  return { conflictFiles: [...new Set(conflictFiles)], errors };
}

async function verifyMergeCleanup(cwd: string): Promise<unknown[]> {
  const errors: unknown[] = [];
  try {
    const mergeHead = await runGitCommand(["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
      cwd,
      acceptExitCodes: [0, 1],
      envOverlay: READ_ONLY_GIT_ENV,
    });
    if (mergeHead.exitCode === 0 || mergeHead.stdout.trim().length > 0) {
      errors.push(new Error("Merge cleanup invariant failed: MERGE_HEAD still exists"));
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    const unmerged = await runGitCommand(["ls-files", "-u"], {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
    });
    if (unmerged.stdout.trim().length > 0) {
      errors.push(new Error("Merge cleanup invariant failed: unmerged index entries remain"));
    }
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

async function cleanupFailedMerge(cwd: string, mode: "merge" | "squash"): Promise<unknown[]> {
  const errors: unknown[] = [];
  try {
    // A failed squash merge leaves conflicted index entries without MERGE_HEAD,
    // so `merge --abort` cannot clean it; `reset --merge` can.
    const cleanupArgs = mode === "squash" ? ["reset", "--merge", "HEAD"] : ["merge", "--abort"];
    await runGitCommand(cleanupArgs, { cwd, timeout: 120_000 });
  } catch (error) {
    errors.push(error);
  }
  errors.push(...(await verifyMergeCleanup(cwd)));
  return errors;
}

async function handleFailedMerge(input: HandleFailedMergeInput): Promise<never> {
  const { cwd, error, baseRef, currentBranch, direction, mode } = input;
  const errorDetails =
    error instanceof Error
      ? `${error.message}\n${getErrorStderr(error)}\n${getErrorStdout(error)}`
      : String(error);
  const diagnostics = await collectMergeConflictDiagnostics(cwd);
  const cleanupErrors = await cleanupFailedMerge(cwd, mode);

  const conflictDetected =
    diagnostics.conflictFiles.length > 0 || /CONFLICT|Automatic merge failed/i.test(errorDetails);
  if (cleanupErrors.length > 0) {
    throw new MergeCleanupError({
      baseRef,
      currentBranch,
      conflictFiles: diagnostics.conflictFiles,
      diagnosticErrors: diagnostics.errors,
      cleanupErrors,
      operationErrors: [error],
    });
  }
  if (conflictDetected) {
    if (direction === "to-base") {
      throw new MergeConflictError({
        baseRef,
        currentBranch,
        conflictFiles: diagnostics.conflictFiles,
      });
    }
    throw new MergeFromBaseConflictError({
      baseRef,
      currentBranch,
      conflictFiles: diagnostics.conflictFiles,
    });
  }

  const relatedErrors = diagnostics.errors;
  if (relatedErrors.length > 0) {
    throw new AggregateError(
      [error, ...relatedErrors],
      `Merge failed and ${relatedErrors.length} diagnostic or cleanup operation(s) also failed`,
      { cause: error },
    );
  }
  throw error;
}

interface AppendMergeCleanupErrorInput {
  primary: unknown;
  cleanupError: unknown;
  baseRef: string;
  currentBranch: string;
}

function appendMergeCleanupError(input: AppendMergeCleanupErrorInput): MergeCleanupError {
  const { primary, cleanupError } = input;
  if (primary instanceof MergeCleanupError) {
    return new MergeCleanupError({
      baseRef: primary.baseRef,
      currentBranch: primary.currentBranch,
      conflictFiles: primary.conflictFiles,
      diagnosticErrors: primary.diagnosticErrors,
      cleanupErrors: [...primary.cleanupErrors, cleanupError],
      operationErrors: primary.operationErrors,
    });
  }
  if (primary instanceof MergeConflictError || primary instanceof MergeFromBaseConflictError) {
    return new MergeCleanupError({
      baseRef: primary.baseRef,
      currentBranch: primary.currentBranch,
      conflictFiles: primary.conflictFiles,
      cleanupErrors: [cleanupError],
      operationErrors: [primary],
    });
  }
  return new MergeCleanupError({
    baseRef: input.baseRef,
    currentBranch: input.currentBranch,
    conflictFiles: [],
    cleanupErrors: [cleanupError],
    operationErrors: [primary],
  });
}

interface ExecuteMergeToBaseInput {
  operationCwd: string;
  baseRef: string;
  currentBranch: string;
  mode: "merge" | "squash";
  commitMessage?: string;
}

async function executeMergeToBase(input: ExecuteMergeToBaseInput): Promise<void> {
  const { operationCwd, baseRef, currentBranch, mode } = input;
  await runGitCommand(["checkout", baseRef], {
    cwd: operationCwd,
    timeout: 120_000,
  });
  try {
    const mergeArgs =
      mode === "squash" ? ["merge", "--squash", currentBranch] : ["merge", currentBranch];
    await runGitCommand(mergeArgs, { cwd: operationCwd, timeout: 120_000 });
  } catch (error) {
    await handleFailedMerge({
      cwd: operationCwd,
      error,
      baseRef,
      currentBranch,
      direction: "to-base",
      mode,
    });
  }
  if (mode !== "squash") return;

  const message = input.commitMessage ?? `Squash merge ${currentBranch} into ${baseRef}`;
  await runGitCommand(["-c", "commit.gpgsign=false", "commit", "-m", message], {
    cwd: operationCwd,
    timeout: 120_000,
  });
}

async function restoreBranchAfterMerge(cwd: string, originalBranch: string): Promise<void> {
  await runGitCommand(["checkout", originalBranch], {
    cwd,
    timeout: 120_000,
  });
  const restoredBranch = await getCurrentBranch(cwd);
  if (restoredBranch !== originalBranch) {
    throw new Error(
      `Failed to restore branch after merge: expected ${originalBranch}, found ${restoredBranch ?? "detached HEAD"}`,
    );
  }
}

async function requireCleanSquashTarget(cwd: string, mode: "merge" | "squash"): Promise<void> {
  if (mode !== "squash") return;

  const { stdout } = await runGitCommand(["status", "--porcelain"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  if (stdout.trim().length > 0) {
    throw new Error("Working directory has uncommitted changes.");
  }
}

export async function mergeToBase(
  cwd: string,
  options: MergeToBaseOptions = {},
  context?: CheckoutContext,
): Promise<string> {
  await requireGitRepo(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  const { storedBaseRef, resolvedBaseRef } = await resolveBaseRefForCwd(cwd, context);
  const baseRef = resolveOperationBaseRef({
    storedBaseRef,
    resolvedBaseRef,
    requestedBaseRef: options.baseRef,
  });
  if (!baseRef) {
    throw new Error("Unable to determine base branch for merge");
  }
  if (!currentBranch) {
    throw new Error("Unable to determine current branch for merge");
  }
  const normalizedBaseRef = resolveMergeTargetBranch(baseRef);
  const currentWorktreeRoot = (await getWorktreeRoot(cwd, context)) ?? cwd;
  if (normalizedBaseRef === currentBranch) {
    return currentWorktreeRoot;
  }

  const baseWorktree = await getWorktreePathForBranch(cwd, normalizedBaseRef);
  const operationCwd = baseWorktree ?? currentWorktreeRoot;
  const isSameCheckout = resolve(operationCwd) === resolve(currentWorktreeRoot);
  const originalBranch = await getCurrentBranch(operationCwd);
  const mode = options.mode ?? "merge";
  await requireCleanSquashTarget(operationCwd, mode);
  let operationError: unknown;
  let operationFailed = false;
  try {
    await executeMergeToBase({
      operationCwd,
      baseRef: normalizedBaseRef,
      currentBranch,
      mode,
      commitMessage: options.commitMessage,
    });
  } catch (error) {
    operationError = error;
    operationFailed = true;
  }
  if (isSameCheckout && originalBranch && originalBranch !== normalizedBaseRef) {
    try {
      await restoreBranchAfterMerge(operationCwd, originalBranch);
    } catch (restorationError) {
      if (!operationFailed) {
        throw new MergeCleanupError({
          baseRef: normalizedBaseRef,
          currentBranch,
          conflictFiles: [],
          cleanupErrors: [restorationError],
        });
      }
      operationError = appendMergeCleanupError({
        primary: operationError,
        cleanupError: restorationError,
        baseRef: normalizedBaseRef,
        currentBranch,
      });
    }
  }
  if (operationFailed) throw operationError;
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

  const { storedBaseRef, resolvedBaseRef } = await resolveBaseRefForCwd(cwd, context);
  const baseRef = resolveOperationBaseRef({
    storedBaseRef,
    resolvedBaseRef,
    requestedBaseRef: options.baseRef,
  });
  if (!baseRef) {
    throw new Error("Unable to determine base branch for merge");
  }

  const requireCleanTarget = options.requireCleanTarget ?? true;
  if (requireCleanTarget) {
    const { stdout } = await runGitCommand(["status", "--porcelain"], {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
    });
    if (stdout.trim().length > 0) {
      throw new Error("Working directory has uncommitted changes.");
    }
  }

  const bestBaseRef = await resolveMostAheadBaseRef(cwd, baseRef);
  if (bestBaseRef === currentBranch) {
    return;
  }

  try {
    await runGitCommand(["merge", bestBaseRef], { cwd, timeout: 120_000 });
  } catch (error) {
    await handleFailedMerge({
      cwd,
      error,
      baseRef: bestBaseRef,
      currentBranch,
      direction: "from-base",
      mode: "merge",
    });
  }
}

export async function pullCurrentBranch(cwd: string, forgeService?: ForgeService): Promise<void> {
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
    forgeService?.invalidate({ cwd });
  } catch (error) {
    await abortGitPullConflictState(cwd);
    throw error;
  }
}

export async function pushCurrentBranch(cwd: string, forgeService?: ForgeService): Promise<void> {
  await requireGitRepo(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  if (!currentBranch || currentBranch === "HEAD") {
    throw new Error("Unable to determine current branch for push");
  }
  const configuredPushTarget = await getCurrentBranchConfiguredPushTarget(cwd, currentBranch);
  if (configuredPushTarget) {
    await runGitCommand(
      ["push", configuredPushTarget.remoteName, `HEAD:refs/heads/${configuredPushTarget.headRef}`],
      { cwd, timeout: 120_000 },
    );
    await refreshCurrentBranchTrackedRefAfterPush(cwd, currentBranch, configuredPushTarget);
    forgeService?.invalidate({ cwd });
    return;
  }

  const upstreamTarget = await getCurrentBranchUpstreamPushTarget(cwd, currentBranch);
  if (upstreamTarget) {
    await runGitCommand(
      ["push", "-u", upstreamTarget.remoteName, `HEAD:refs/heads/${upstreamTarget.headRef}`],
      { cwd, timeout: 120_000 },
    );
    forgeService?.invalidate({ cwd });
    return;
  }

  const hasRemote = await hasOriginRemote(cwd);
  if (!hasRemote) {
    throw new Error("Remote 'origin' is not configured.");
  }
  await runGitCommand(["push", "-u", "origin", currentBranch], { cwd, timeout: 120_000 });
  forgeService?.invalidate({ cwd });
}

async function getCurrentBranchConfiguredPushTarget(
  cwd: string,
  currentBranch: string,
): Promise<{ remoteName: string; headRef: string } | null> {
  const remoteName = await getGitConfigValue(cwd, `branch.${currentBranch}.pushRemote`);
  const pushRefspec = remoteName ? await getGitConfigValue(cwd, `remote.${remoteName}.push`) : null;
  const headRef = parseHeadPushRefspec(pushRefspec);
  if (!remoteName || !headRef) {
    return null;
  }
  const remoteUrl = await getGitConfigValue(cwd, `remote.${remoteName}.url`);
  return remoteUrl ? { remoteName, headRef } : null;
}

async function refreshCurrentBranchTrackedRefAfterPush(
  cwd: string,
  currentBranch: string,
  pushedTarget: { remoteName: string; headRef: string },
): Promise<void> {
  const trackingRemoteName = await getGitConfigValue(cwd, `branch.${currentBranch}.remote`);
  const trackingMergeRef = await getGitConfigValue(cwd, `branch.${currentBranch}.merge`);
  const trackingHeadRef = parseBranchMergeHeadRef(trackingMergeRef);
  if (!trackingRemoteName && !trackingMergeRef) {
    const updated = await updateRemoteTrackingRef(
      cwd,
      pushedTarget.remoteName,
      pushedTarget.headRef,
    );
    if (!updated) {
      return;
    }
    await runGitCommand(["config", `branch.${currentBranch}.remote`, pushedTarget.remoteName], {
      cwd,
    });
    await runGitCommand(
      ["config", `branch.${currentBranch}.merge`, `refs/heads/${pushedTarget.headRef}`],
      {
        cwd,
      },
    );
    return;
  }
  if (!trackingRemoteName || trackingHeadRef !== pushedTarget.headRef) {
    return;
  }

  const [trackingRemotePushUrl, pushedRemotePushUrl] = await Promise.all([
    getGitRemotePushUrl(cwd, trackingRemoteName),
    getGitRemotePushUrl(cwd, pushedTarget.remoteName),
  ]);
  if (!trackingRemotePushUrl || trackingRemotePushUrl !== pushedRemotePushUrl) {
    return;
  }

  await updateRemoteTrackingRef(cwd, trackingRemoteName, trackingHeadRef);
}

async function updateRemoteTrackingRef(
  cwd: string,
  remoteName: string,
  headRef: string,
): Promise<boolean> {
  const trackingRef = `refs/remotes/${remoteName}/${headRef}`;
  const checkRef = await runGitCommand(["check-ref-format", trackingRef], {
    cwd,
    acceptExitCodes: [0, 1],
  });
  if (checkRef.exitCode !== 0) {
    return false;
  }
  await runGitCommand(["update-ref", trackingRef, "HEAD"], { cwd, timeout: 120_000 });
  return true;
}

async function getCurrentBranchUpstreamPushTarget(
  cwd: string,
  currentBranch: string,
): Promise<{ remoteName: string; headRef: string } | null> {
  const remoteName = await getGitConfigValue(cwd, `branch.${currentBranch}.remote`);
  const mergeRef = remoteName
    ? await getGitConfigValue(cwd, `branch.${currentBranch}.merge`)
    : null;
  const headRef = parseBranchMergeHeadRef(mergeRef);
  if (!remoteName || !headRef) {
    return null;
  }
  const remoteUrl = await getGitConfigValue(cwd, `remote.${remoteName}.url`);
  return remoteUrl ? { remoteName, headRef } : null;
}

function parseHeadPushRefspec(refspec: string | null): string | null {
  const prefix = "HEAD:refs/heads/";
  const normalized = refspec?.trim().replace(/^\+/, "");
  if (!normalized?.startsWith(prefix)) {
    return null;
  }
  const headRef = normalized.slice(prefix.length).trim();
  return headRef.length > 0 ? headRef : null;
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
  projectPath?: string;
  url: string;
  title: string;
  state: string;
  baseRefName: string;
  headRefName: string;
  isMerged: boolean;
  isDraft?: boolean;
  mergeable?: PullRequestMergeable;
  checks?: PullRequestCheck[];
  checksStatus?: ChecksStatus;
  reviewDecision?: ReviewDecision;
  forgeSpecific?: ForgeSpecificStatusFacts;
}

export interface PullRequestStatusResult {
  status: PullRequestStatus | null;
  /** Why forge features are (un)available — drives the onboarding callout. */
  authState: ForgeAuthState;
  /** Kept in sync with {@link authState} for back-compat; true iff authenticated. */
  githubFeaturesEnabled: boolean;
}

function buildPullRequestStatusResult(
  status: PullRequestStatus | null,
  authState: ForgeAuthState,
): PullRequestStatusResult {
  return { status, authState, githubFeaturesEnabled: authState === "authenticated" };
}

/** True for the CLI-missing / authentication errors of any supported forge. */
export function isForgeAuthError(error: unknown): boolean {
  return error instanceof ForgeCliMissingError || error instanceof ForgeAuthenticationError;
}

/**
 * Map a forge CLI failure to an auth state. A missing-CLI error means the user
 * must install the tool; anything else surfaced as an auth probe failure means
 * they must sign in.
 */
export function forgeAuthStateFromError(error: unknown): ForgeAuthState {
  if (error instanceof ForgeCliMissingError) {
    return "cli_missing";
  }
  return "unauthenticated";
}

export interface PullRequestCheck {
  name: string;
  status: "success" | "failure" | "pending" | "skipped" | "cancelled";
  url: string | null;
  workflow?: string;
  duration?: string;
}

export type ChecksStatus = "none" | "pending" | "success" | "failure";

export type ReviewDecision = "approved" | "changes_requested" | "pending" | null;

export async function createPullRequest(
  cwd: string,
  options: CreatePullRequestOptions,
  forgeService: ForgeService = createGitHubService(),
  context?: CheckoutContext,
): Promise<{ url: string; number: number }> {
  await requireGitRepo(cwd);

  const head = options.head ?? (await getCurrentBranch(cwd));
  const { storedBaseRef, resolvedBaseRef } = await resolveBaseRefForCwd(cwd, context);
  const base = resolveOperationBaseRef({
    storedBaseRef,
    resolvedBaseRef,
    requestedBaseRef: options.base,
  });
  if (!head) {
    throw new Error("Unable to determine head branch for PR");
  }
  if (!base) {
    throw new Error("Unable to determine base branch for PR");
  }
  const normalizedBase = branchNameFromRef(base);

  // The push deliberately happens before the adapter resolves the target
  // repository: slug resolution is adapter-internal (e.g. `gh repo view`, which
  // handles GHES and renamed repos), and the RPC path only reaches here after
  // the forge resolver has already matched the origin remote to a forge. If the
  // adapter still fails after the push, retrying is safe — the non-force push
  // of the head branch is idempotent.
  await runGitCommand(["push", "-u", "origin", head], { cwd, timeout: 120_000 });

  const result = await forgeService.createPullRequest({
    cwd,
    title: options.title,
    body: options.body,
    head,
    base: normalizedBase,
  });
  forgeService.invalidate({ cwd });
  return result;
}

export async function getPullRequestStatus(
  cwd: string,
  forgeService: ForgeService = createGitHubService(),
  options?: CheckoutReadCacheOptions,
  context?: CheckoutContext,
): Promise<PullRequestStatusResult> {
  const headSha = await getCurrentHeadSha(cwd, context);
  const cacheKey = getPullRequestStatusCacheKey(cwd, headSha);
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

  const lookup = getPullRequestStatusUncached(cwd, forgeService, options, context, headSha)
    .then((status) => {
      pullRequestStatusCache.set(cacheKey, status);
      rememberPullRequestStatus(cacheKey, status);
      return status;
    })
    .catch((error) => {
      if (!options?.force && error instanceof ForgeCommandError) {
        const stale = lastSuccessfulPullRequestStatus.get(cacheKey);
        if (stale) {
          return stale;
        }
      }
      throw error;
    })
    .finally(() => {
      pullRequestStatusInFlight.delete(cacheKey);
    });

  pullRequestStatusInFlight.set(cacheKey, lookup);
  return lookup;
}

async function getPullRequestStatusUncached(
  cwd: string,
  forgeService: ForgeService,
  options?: CheckoutReadCacheOptions,
  context?: CheckoutContext,
  headSha?: string | null,
): Promise<PullRequestStatusResult> {
  if (context?.facts?.isGit === false) {
    return buildPullRequestStatusResult(null, "no_remote");
  }
  if (!context?.facts?.isGit) {
    await requireGitRepo(cwd);
  }
  const head = context?.facts?.isGit ? context.facts.currentBranch : await getCurrentBranch(cwd);
  if (!head) {
    return buildPullRequestStatusResult(null, "no_remote");
  }
  try {
    const resolvedLookupTarget = await resolvePullRequestStatusLookupTarget(cwd, head, context);
    const lookupTarget =
      headSha && !resolvedLookupTarget.headSha
        ? { ...resolvedLookupTarget, headSha }
        : resolvedLookupTarget;
    let status: CurrentPullRequestStatus | null;
    if (options?.force) {
      const reason = options.reason;
      if (!reason) {
        throw new Error("Forced PR status read requires a reason");
      }
      status = await forgeService.getCurrentPullRequestStatus({
        cwd,
        ...lookupTarget,
        force: true,
        reason,
      });
    } else {
      status = await forgeService.getCurrentPullRequestStatus({
        cwd,
        ...lookupTarget,
        reason: options?.reason,
      });
    }
    return buildPullRequestStatusResult(status, "authenticated");
  } catch (error) {
    if (isForgeAuthError(error)) {
      return buildPullRequestStatusResult(null, forgeAuthStateFromError(error));
    }
    throw error;
  }
}
