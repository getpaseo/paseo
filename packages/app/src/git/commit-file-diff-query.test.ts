import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { fetchQueryOptions } from "@/data/query";
import { commitFileDiffQueryOptions } from "./commit-file-diff-query";

const file = { path: "a.ts", isNew: true, isDeleted: false, additions: 0, deletions: 0, hunks: [] };

describe("commit file diff fetching", () => {
  it("reuses a cached commit body on remount and fetches on explicit refresh", async () => {
    const queryClient = new QueryClient();
    let calls = 0;
    const options = fetchQueryOptions(
      commitFileDiffQueryOptions({
        serverId: "host",
        cwd: "/repo",
        sha: "abc",
        path: "a.ts",
        enabled: true,
        client: {
          async getCommitFileDiff() {
            calls++;
            return { file };
          },
        },
      }),
    );
    queryClient.setQueryData(
      options.queryKey,
      { file },
      { updatedAt: Date.now() - 24 * 60 * 60 * 1000 },
    );
    const observer = new QueryObserver(queryClient, options);
    const detach = observer.subscribe(() => {});
    try {
      await Promise.resolve();
      expect(calls).toBe(0);
      expect(observer.getCurrentResult().data?.file).toBe(file);
      await observer.refetch();
      expect(calls).toBe(1);
    } finally {
      detach();
      queryClient.clear();
    }
  });

  it("retries a cached null result when reopened", async () => {
    const queryClient = new QueryClient();
    const options = fetchQueryOptions(
      commitFileDiffQueryOptions({
        serverId: "host",
        cwd: "/repo",
        sha: "abc",
        path: "a.ts",
        enabled: true,
        client: {
          async getCommitFileDiff() {
            return { file };
          },
        },
      }),
    );
    queryClient.setQueryData(options.queryKey, { file: null });
    const observer = new QueryObserver(queryClient, options);
    const settled = Promise.withResolvers<void>();
    const detach = observer.subscribe((result) => {
      if (result.fetchStatus === "idle") settled.resolve();
    });
    try {
      await settled.promise;
      expect(observer.getCurrentResult().data?.file).toEqual(file);
    } finally {
      detach();
      queryClient.clear();
    }
  });
});
