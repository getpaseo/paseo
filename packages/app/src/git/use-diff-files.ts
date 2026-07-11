import { useMemo } from "react";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { useFetchQueries } from "@/data/query";
import type { DiffTarget } from "@/git/diff-target";
import { checkoutCommitFileDiffQueryKey } from "@/git/query-keys";
import { useCheckoutCommitsQuery } from "@/git/use-commits-query";
import { useCheckoutDiffQuery } from "@/git/use-diff-query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

// A commit's file diff is immutable for a given sha+path, so it can stay cached
// for the lifetime of the view without refetching. Matches use-commit-file-diff.
const COMMIT_FILE_DIFF_STALE_TIME = 5 * 60_000;

/**
 * Context every diff target needs to resolve against a host: which daemon
 * (`serverId`), which workspace tab (`workspaceId`), and which checkout (`cwd`).
 * `enabled` lets the consumer pause all fetching (e.g. an inactive tab).
 */
export interface DiffFilesContext {
  serverId: string;
  workspaceId: string;
  cwd: string;
  enabled?: boolean;
}

/**
 * Unified, target-agnostic diff result. A `DiffPanel` consumes this and renders
 * identically whether the source is the working tree or a single commit.
 *
 * - `capabilityMissing` is only meaningful for `commit` targets (the commits
 *   list / per-file diff RPCs are capability-gated); it stays `undefined` for
 *   `working` targets, which have no capability gate.
 */
export interface DiffFilesResult {
  files: ParsedDiffFile[];
  isLoading: boolean;
  error: Error | null;
  capabilityMissing?: boolean;
}

/**
 * Resolve any {@link DiffTarget} to a unified set of parsed diff files.
 *
 * Both branches' hooks run on every render — only the branch matching
 * `target.kind` is enabled — so React's hook order is constant regardless of
 * which target is active. Switching `target.kind` never throws "rendered
 * more/fewer hooks".
 */
export function useDiffFiles(target: DiffTarget, ctx: DiffFilesContext): DiffFilesResult {
  const { serverId, cwd, enabled = true } = ctx;
  const isWorking = target.kind === "working";
  const isCommit = target.kind === "commit";

  // --- Working target ---------------------------------------------------
  const workingMode = isWorking ? target.mode : "uncommitted";
  const workingBaseRef = isWorking ? (target.baseRef ?? undefined) : undefined;
  const workingIgnoreWhitespace = isWorking ? target.ignoreWhitespace : undefined;
  const workingQuery = useCheckoutDiffQuery({
    serverId,
    cwd,
    mode: workingMode,
    baseRef: workingBaseRef ?? undefined,
    ignoreWhitespace: workingIgnoreWhitespace,
    enabled: isWorking && enabled,
  });

  // --- Commit target ----------------------------------------------------
  const commitSha = isCommit ? target.sha : "";
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const commitsQuery = useCheckoutCommitsQuery({ serverId, cwd, enabled: isCommit && enabled });
  const commitFiles = useMemo(() => {
    if (!isCommit) {
      return [];
    }
    return commitsQuery.commits.find((commit) => commit.sha === commitSha)?.files ?? [];
  }, [isCommit, commitsQuery.commits, commitSha]);

  // Fan out one immutable per-file query in commit order. useQueries lets us
  // call a variable number of queries from a single hook call (hook-rules safe),
  // and reuses the shared query-key factory so the cache is shared with any
  // single-file usage (useCommitFileDiff).
  const fileDiffsEnabled =
    isCommit &&
    enabled &&
    !commitsQuery.capabilityMissing &&
    Boolean(cwd) &&
    Boolean(commitSha) &&
    Boolean(client) &&
    isConnected;
  const fileDiffResults = useFetchQueries(
    commitFiles.map((file) => ({
      queryKey: checkoutCommitFileDiffQueryKey(serverId, cwd, commitSha, file.path),
      queryFn: async (): Promise<{ file: ParsedDiffFile | null }> => {
        if (!client) {
          throw new Error("Host disconnected");
        }
        return client.getCommitFileDiff(cwd, commitSha, file.path);
      },
      enabled: fileDiffsEnabled,
      staleTimeMs: COMMIT_FILE_DIFF_STALE_TIME,
      dataShape: "value" as const,
    })),
  );

  const commitResult = useMemo<DiffFilesResult>(() => {
    const files: ParsedDiffFile[] = [];
    for (const fileResult of fileDiffResults) {
      const file = fileResult.data?.file;
      if (file) {
        files.push(file);
      }
    }
    const firstFileError = fileDiffResults.find((r) => r.error)?.error ?? null;
    return {
      files,
      isLoading: commitsQuery.isLoading || fileDiffResults.some((r) => r.isLoading),
      error: commitsQuery.error ?? firstFileError,
      capabilityMissing: commitsQuery.capabilityMissing,
    };
  }, [fileDiffResults, commitsQuery.isLoading, commitsQuery.error, commitsQuery.capabilityMissing]);

  if (isCommit) {
    return commitResult;
  }
  // useCheckoutDiffQuery surfaces transport failures via `error` and structured
  // diff failures via `payloadError` ({ code, message }); normalize both into
  // a single `Error | null` so the unified shape stays consistent across targets.
  const workingPayloadError = workingQuery.payloadError
    ? new Error(workingQuery.payloadError.message)
    : null;
  return {
    files: workingQuery.files,
    isLoading: workingQuery.isLoading,
    error: workingQuery.error ?? workingPayloadError,
  };
}
