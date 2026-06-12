import { describe, expect, it } from "vitest";
import type { PullRequestReviewThreadsResponse } from "@getpaseo/protocol/messages";
import {
  groupReviewThreadsByFile,
  type PullRequestReviewThread,
  selectActionableReviewThreads,
  selectReviewThreadsState,
  shouldFetchReviewThreadsFrom,
} from "./use-pr-review-threads-query";

type PullRequestReviewThreadsPayload = PullRequestReviewThreadsResponse["payload"];

function thread(overrides: Partial<PullRequestReviewThread> = {}): PullRequestReviewThread {
  return {
    id: "PRT_1",
    path: "src/index.ts",
    line: 12,
    startLine: 10,
    diffHunk: "@@ -8,4 +8,5 @@",
    isResolved: false,
    isOutdated: false,
    comments: [
      {
        id: "PRC_1",
        author: "octocat",
        body: "Please rename this",
        url: "https://github.com/getpaseo/paseo/pull/42#discussion_r1",
        createdAt: 1710000000000,
      },
    ],
    ...overrides,
  };
}

function payload(
  overrides: Partial<PullRequestReviewThreadsPayload> = {},
): PullRequestReviewThreadsPayload {
  return {
    cwd: "/repo",
    prNumber: 42,
    threads: [],
    truncated: false,
    error: null,
    requestId: "threads-1",
    githubFeaturesEnabled: true,
    ...overrides,
  };
}

const baseGate = {
  hasClient: true,
  isConnected: true,
  enabled: true,
  capabilitySupported: true,
  cwd: "/repo",
  identity: { prNumber: 42, repoOwner: "getpaseo", repoName: "paseo" },
};

describe("selectActionableReviewThreads", () => {
  it("keeps unresolved, current threads", () => {
    const threads = [thread({ id: "a" }), thread({ id: "b" })];
    expect(selectActionableReviewThreads(threads).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("drops resolved and outdated threads", () => {
    const threads = [
      thread({ id: "keep" }),
      thread({ id: "resolved", isResolved: true }),
      thread({ id: "outdated", isOutdated: true }),
    ];
    expect(selectActionableReviewThreads(threads).map((t) => t.id)).toEqual(["keep"]);
  });
});

describe("groupReviewThreadsByFile", () => {
  it("groups threads by file path preserving first-seen order", () => {
    const threads = [
      thread({ id: "a", path: "src/a.ts" }),
      thread({ id: "b", path: "src/b.ts" }),
      thread({ id: "a2", path: "src/a.ts" }),
    ];
    const groups = groupReviewThreadsByFile(threads);
    expect(groups.map((g) => g.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(groups[0].threads.map((t) => t.id)).toEqual(["a", "a2"]);
    expect(groups[1].threads.map((t) => t.id)).toEqual(["b"]);
  });

  it("returns an empty list when there are no threads", () => {
    expect(groupReviewThreadsByFile([])).toEqual([]);
  });
});

describe("shouldFetchReviewThreadsFrom", () => {
  it("fetches when every gate is open", () => {
    expect(shouldFetchReviewThreadsFrom(baseGate)).toBe(true);
  });

  it.each([
    { name: "no client", overrides: { hasClient: false } },
    { name: "disconnected", overrides: { isConnected: false } },
    { name: "disabled", overrides: { enabled: false } },
    { name: "capability unsupported", overrides: { capabilitySupported: false } },
    { name: "no cwd", overrides: { cwd: "" } },
    {
      name: "no PR number",
      overrides: { identity: { prNumber: null, repoOwner: "getpaseo", repoName: "paseo" } },
    },
    {
      name: "no repo owner",
      overrides: { identity: { prNumber: 42, repoOwner: null, repoName: "paseo" } },
    },
  ])("does not fetch when $name", ({ overrides }) => {
    expect(shouldFetchReviewThreadsFrom({ ...baseGate, ...overrides })).toBe(false);
  });
});

describe("selectReviewThreadsState", () => {
  const baseInput = {
    capabilitySupported: true,
    prNumber: 42,
    shouldFetch: true,
    payload: undefined as PullRequestReviewThreadsPayload | undefined,
    queryError: null as Error | null,
    isLoading: false,
    isFetching: false,
  };

  it("reports loading before the first payload arrives", () => {
    const state = selectReviewThreadsState({ ...baseInput, isLoading: true });
    expect(state.isLoading).toBe(true);
    expect(state.threads).toEqual([]);
    expect(state.groups).toEqual([]);
  });

  it("filters and groups actionable threads from the payload", () => {
    const state = selectReviewThreadsState({
      ...baseInput,
      payload: payload({
        threads: [
          thread({ id: "keep", path: "src/a.ts" }),
          thread({ id: "resolved", path: "src/a.ts", isResolved: true }),
          thread({ id: "other", path: "src/b.ts" }),
        ],
      }),
    });
    expect(state.threads.map((t) => t.id)).toEqual(["keep", "other"]);
    expect(state.groups.map((g) => g.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(state.isLoading).toBe(false);
  });

  it("surfaces the payload error kind for UI mapping", () => {
    const state = selectReviewThreadsState({
      ...baseInput,
      payload: payload({
        threads: [],
        githubFeaturesEnabled: false,
        error: { kind: "missing_cli", message: "no gh" },
      }),
    });
    expect(state.payloadError).toEqual({ kind: "missing_cli", message: "no gh" });
    expect(state.githubFeaturesEnabled).toBe(false);
  });

  it("marks refreshing when refetching over existing data", () => {
    const state = selectReviewThreadsState({
      ...baseInput,
      payload: payload(),
      isFetching: true,
      isLoading: false,
    });
    expect(state.isRefreshing).toBe(true);
  });
});
