import { describe, expect, it } from "vitest";
import { resolveCommitLogQueryResult, type CommitLogData } from "./use-commit-log-query";

const DATA: CommitLogData = {
  commits: [
    {
      sha: "1".repeat(40),
      shortSha: "1111111",
      subject: "Add feature",
      authorName: "Ada",
      authorDate: "2026-06-13T10:00:00.000Z",
      refs: [],
    },
  ],
  hasMore: true,
  pinnedTipsTruncated: false,
};

function resolve(overrides: Partial<Parameters<typeof resolveCommitLogQueryResult>[0]> = {}) {
  return resolveCommitLogQueryResult({
    capabilityPresent: true,
    canFetch: true,
    data: undefined,
    isFetchingNextPage: false,
    error: null,
    ...overrides,
  });
}

describe("resolveCommitLogQueryResult", () => {
  it("reports unsupported ahead of every other state", () => {
    expect(
      resolve({ capabilityPresent: false, canFetch: false, data: DATA, error: new Error("boom") }),
    ).toEqual({ status: "unsupported" });
  });

  it("reports connecting when the host is unreachable and nothing is cached", () => {
    expect(resolve({ canFetch: false })).toEqual({ status: "connecting" });
  });

  it("reports loading before the first page arrives", () => {
    expect(resolve()).toEqual({ status: "loading" });
  });

  it("reports an error when the cold load fails", () => {
    const error = new Error("boom");
    expect(resolve({ error })).toEqual({ status: "error", error });
  });

  it("reports loaded data and flags an in-flight next page", () => {
    expect(resolve({ data: DATA })).toEqual({
      status: "loaded",
      data: DATA,
      isLoadingMore: false,
    });
    expect(resolve({ data: DATA, isFetchingNextPage: true })).toEqual({
      status: "loaded",
      data: DATA,
      isLoadingMore: true,
    });
  });

  it("keeps showing loaded pages when a later fetch fails", () => {
    expect(resolve({ data: DATA, error: new Error("boom") })).toMatchObject({ status: "loaded" });
  });
});
