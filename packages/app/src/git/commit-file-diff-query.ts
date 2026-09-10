import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { checkoutCommitFileDiffQueryKey, COMMIT_FILE_DIFF_STALE_TIME } from "./query-keys";
import { shareCommitFileDiff } from "./diff-sharing";

export function commitFileDiffQueryOptions(input: {
  serverId: string;
  cwd: string;
  sha: string;
  path: string;
  client: Pick<DaemonClient, "getCommitFileDiff"> | null;
  enabled: boolean;
}) {
  return {
    queryKey: checkoutCommitFileDiffQueryKey(input.serverId, input.cwd, input.sha, input.path),
    queryFn: () => {
      if (!input.client) throw new Error("Host disconnected");
      return input.client.getCommitFileDiff(input.cwd, input.sha, input.path);
    },
    enabled: input.enabled,
    gcTime: COMMIT_FILE_DIFF_STALE_TIME,
    // Only successful file bodies are immutable. Null/error results can recover.
    immutableWhen: (data: Awaited<ReturnType<DaemonClient["getCommitFileDiff"]>>) =>
      data.file !== null,
    dataShape: "value" as const,
    refetchOnWindowFocus: false,
    structuralSharing: shareCommitFileDiff,
  };
}
