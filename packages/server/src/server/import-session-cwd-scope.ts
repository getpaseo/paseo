import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import pLimit from "p-limit";
import {
  createRealpathAwarePathMatcher,
  getRealpathAwareRelativePath,
  normalizePathForIdentity,
} from "../utils/path.js";
import type { WorkspaceGitReadOptions, WorkspaceGitService } from "./workspace-git-service.js";

const IMPORT_SESSION_SCOPE_GIT_CONCURRENCY = 4;

export class ImportSessionCwdScopeError extends Error {
  constructor(
    readonly code: "unavailable_source_cwd",
    sourceCwd: string,
  ) {
    super(`Import source directory is unavailable: ${sourceCwd}`);
    this.name = "ImportSessionCwdScopeError";
  }
}

export interface ImportSessionCwdScope {
  sourceCwd: string;
  exactCwds: readonly string[];
  matchesCwd(candidate: string): Promise<boolean>;
}

export interface ResolveImportSessionCwdScopeOptions {
  force?: boolean;
  reason?: string;
}

export interface ImportSessionCwdScopeResolver {
  resolve(
    sourceCwd: string,
    options?: ResolveImportSessionCwdScopeOptions,
  ): Promise<ImportSessionCwdScope>;
}

export function createImportSessionCwdScopeResolver(deps: {
  workspaceGitService: Pick<WorkspaceGitService, "getGitCheckoutIdentity" | "listLinkedWorktrees">;
}): ImportSessionCwdScopeResolver {
  return {
    async resolve(sourceCwd, options = {}) {
      const sourceRoot = resolve(sourceCwd);
      const sourceStats = await stat(sourceRoot).catch(() => null);
      if (!sourceStats?.isDirectory()) throw unavailableSourceCwd(sourceRoot);

      const readOptions = toGitReadOptions(options);
      const selectedIdentity = await deps.workspaceGitService.getGitCheckoutIdentity(
        sourceRoot,
        readOptions,
      );
      if (!selectedIdentity) return buildScope(sourceRoot, [sourceRoot]);

      const relativeSourceCwd = getRealpathAwareRelativePath(
        selectedIdentity.worktreeRoot,
        sourceRoot,
      );
      if (relativeSourceCwd === null) throw unavailableSourceCwd(sourceRoot);

      const linkedWorktrees = await deps.workspaceGitService.listLinkedWorktrees(
        sourceRoot,
        readOptions,
      );
      const selectedIsLinked = linkedWorktrees.some(
        (worktree) =>
          createRealpathAwarePathMatcher(selectedIdentity.worktreeRoot)(worktree.worktreeRoot) &&
          createRealpathAwarePathMatcher(selectedIdentity.commonDir)(worktree.commonDir),
      );
      if (!selectedIsLinked) throw unavailableSourceCwd(sourceRoot);

      const limit = pLimit({ concurrency: IMPORT_SESSION_SCOPE_GIT_CONCURRENCY });
      const mappedCwds = await Promise.all(
        linkedWorktrees.map((worktree) =>
          limit(async () => {
            const mappedCwd = resolve(worktree.worktreeRoot, relativeSourceCwd);
            const mappedStats = await stat(mappedCwd).catch(() => null);
            if (!mappedStats?.isDirectory()) return null;

            // The mapped directory can itself be a nested repository or a symlink to an
            // independent clone. Re-read its lightweight Git identity before trusting it.
            const mappedIdentity = await deps.workspaceGitService.getGitCheckoutIdentity(
              mappedCwd,
              readOptions,
            );
            if (!mappedIdentity) return null;
            if (
              !createRealpathAwarePathMatcher(worktree.worktreeRoot)(mappedIdentity.worktreeRoot)
            ) {
              return null;
            }
            if (
              !createRealpathAwarePathMatcher(selectedIdentity.commonDir)(mappedIdentity.commonDir)
            ) {
              return null;
            }
            return mappedCwd;
          }),
        ),
      );

      const exactCwds = mappedCwds.filter((cwd): cwd is string => cwd !== null);
      if (!exactCwds.some(createRealpathAwarePathMatcher(sourceRoot))) {
        throw unavailableSourceCwd(sourceRoot);
      }
      return buildScope(sourceRoot, exactCwds);
    },
  };
}

function buildScope(sourceCwd: string, cwds: readonly string[]): ImportSessionCwdScope {
  const exactCwds = Array.from(
    new Map(cwds.map((cwd) => [normalizePathForIdentity(cwd), resolve(cwd)])).values(),
  ).sort((left, right) => left.localeCompare(right));
  const matchers = exactCwds.map((cwd) => createRealpathAwarePathMatcher(cwd));
  return {
    sourceCwd,
    exactCwds,
    matchesCwd: async (candidate) => matchers.some((matches) => matches(candidate)),
  };
}

function toGitReadOptions(options: ResolveImportSessionCwdScopeOptions): WorkspaceGitReadOptions {
  if (options.force) {
    return {
      force: true,
      reason: options.reason ?? "import-session-cwd-scope",
    };
  }
  return { reason: options.reason ?? "import-session-cwd-scope" };
}

function unavailableSourceCwd(sourceCwd: string): ImportSessionCwdScopeError {
  return new ImportSessionCwdScopeError("unavailable_source_cwd", sourceCwd);
}
