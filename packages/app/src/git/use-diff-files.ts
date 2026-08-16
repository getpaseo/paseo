import { useMemo } from "react";
import type { CheckoutCommitFile, ParsedDiffFile } from "@getpaseo/protocol/messages";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFetchQueries } from "@/data/query";
import { checkoutCommitFileDiffQueryKey, COMMIT_FILE_DIFF_STALE_TIME } from "@/git/query-keys";
import { useCheckoutCommitsQuery } from "@/git/use-commits-query";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useRequiredWorkspaceGit } from "@/git/workspace-git";

/**
 * Context needed to resolve a commit diff against a host: which daemon
 * (`serverId`), which checkout (`cwd`), and which commit (`sha`). `enabled`
 * lets the consumer pause all fetching (e.g. an inactive tab).
 */
export interface CommitDiffFilesContext {
  serverId: string;
  sha: string;
  enabled?: boolean;
}

export interface CommitDiffFilesResult {
  files: ParsedDiffFile[];
  isLoading: boolean;
  error: Error | null;
  capabilityMissing: boolean;
}

export function resolveCommitDiffFile(
  file: CheckoutCommitFile,
  resolved: ParsedDiffFile | null | undefined,
): ParsedDiffFile | null {
  if (resolved !== undefined && resolved !== null) {
    return resolved;
  }
  if (resolved === undefined) {
    return null;
  }
  return {
    path: file.path,
    isNew: file.status === "added",
    isDeleted: file.status === "deleted",
    additions: file.additions,
    deletions: file.deletions,
    hunks: [],
    status: "binary",
  };
}

export function resolveCommitDiffFiles(
  files: CheckoutCommitFile[],
  resolvedByPath: ReadonlyMap<string, ParsedDiffFile | null | undefined>,
): ParsedDiffFile[] {
  return files.flatMap((file) => {
    const resolved = resolveCommitDiffFile(file, resolvedByPath.get(file.path));
    return resolved ? [resolved] : [];
  });
}

export function useCommitDiffFiles(ctx: CommitDiffFilesContext): CommitDiffFilesResult {
  const { serverId, sha, enabled = true } = ctx;
  const workspaceGit = useRequiredWorkspaceGit();
  const retainedPanelActive = useRetainedPanelActive();
  const queryEnabled = enabled && retainedPanelActive;
  const isConnected = useHostRuntimeIsConnected(serverId);
  const commitsQuery = useCheckoutCommitsQuery({ serverId, enabled: queryEnabled });
  const commitsData = commitsQuery.status === "loaded" ? commitsQuery.data : null;
  const commitFiles = useMemo(() => {
    if (!sha || !commitsData) {
      return [];
    }
    return commitsData.commits.find((commit) => commit.sha === sha)?.files ?? [];
  }, [commitsData, sha]);

  const fileDiffsEnabled =
    queryEnabled &&
    commitsQuery.status === "loaded" &&
    Boolean(workspaceGit) &&
    Boolean(sha) &&
    isConnected;
  const fileDiffResults = useFetchQueries(
    commitFiles.map((file) => ({
      queryKey: checkoutCommitFileDiffQueryKey(serverId, workspaceGit, sha, file.path),
      queryFn: async (): Promise<{ file: ParsedDiffFile | null }> => {
        if (!workspaceGit) {
          throw new Error("Host disconnected");
        }
        return workspaceGit.getCommitFileDiff(sha, file.path);
      },
      enabled: fileDiffsEnabled,
      staleTimeMs: COMMIT_FILE_DIFF_STALE_TIME,
      dataShape: "value" as const,
    })),
  );
  const commitsLoading = commitsQuery.status === "connecting" || commitsQuery.status === "loading";
  const commitsError = commitsQuery.status === "error" ? commitsQuery.error : null;
  const capabilityMissing = commitsQuery.status === "unsupported";

  return useMemo<CommitDiffFilesResult>(() => {
    const resolvedByPath = new Map<string, ParsedDiffFile | null | undefined>();
    commitFiles.forEach((file, index) => {
      const fileResult = fileDiffResults[index];
      resolvedByPath.set(file.path, fileResult?.data ? fileResult.data.file : undefined);
    });
    const files = resolveCommitDiffFiles(commitFiles, resolvedByPath);
    let firstFileError: Error | null = null;
    for (const fileResult of fileDiffResults) {
      if (fileResult.error) {
        firstFileError = fileResult.error;
        break;
      }
    }
    return {
      files,
      isLoading: commitsLoading || fileDiffResults.some((r) => r.isLoading),
      error: commitsError ?? firstFileError,
      capabilityMissing,
    };
  }, [capabilityMissing, commitFiles, commitsError, commitsLoading, fileDiffResults]);
}
