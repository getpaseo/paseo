import { describe, expect, test } from "vitest";

import {
  CheckoutGithubSetAutoMergeRequestSchema,
  CheckoutGithubSetAutoMergeResponseSchema,
  CheckoutPrMergeRequestSchema,
  CheckoutPrStatusSchema,
  PullRequestReviewThreadsRequestSchema,
  PullRequestReviewThreadsResponseSchema,
  ServerInfoStatusPayloadSchema,
} from "./messages.js";

describe("checkout PR schemas", () => {
  test("parses PR status payloads without mergeability", () => {
    expect(
      CheckoutPrStatusSchema.parse({
        number: 42,
        url: "https://github.com/getpaseo/paseo/pull/42",
        title: "Ship it",
        state: "open",
        baseRefName: "main",
        headRefName: "feature/ship-it",
        isMerged: false,
      }),
    ).toMatchObject({
      number: 42,
      mergeable: "UNKNOWN",
    });
  });

  test("keeps missing provider-specific GitHub PR facts absent for old daemons", () => {
    const parsed = CheckoutPrStatusSchema.parse({
      number: 42,
      url: "https://github.com/getpaseo/paseo/pull/42",
      title: "Ship it",
      state: "open",
      baseRefName: "main",
      headRefName: "feature/ship-it",
      isMerged: false,
      mergeable: "MERGEABLE",
    });

    expect(parsed.github).toBeUndefined();
  });

  test("parses provider-specific GitHub PR status facts", () => {
    expect(
      CheckoutPrStatusSchema.parse({
        number: 993,
        url: "https://github.com/getpaseo/paseo/pull/993",
        title: "Block direct merge while checks run",
        state: "open",
        baseRefName: "main",
        headRefName: "phase-2",
        isMerged: false,
        mergeable: "MERGEABLE",
        checks: [{ name: "server tests", status: "pending", url: null }],
        checksStatus: "pending",
        github: {
          mergeStateStatus: "BLOCKED",
          autoMergeRequest: null,
          viewerCanEnableAutoMerge: true,
          viewerCanDisableAutoMerge: false,
          viewerCanMergeAsAdmin: false,
          viewerCanUpdateBranch: true,
          repository: {
            autoMergeAllowed: true,
            mergeCommitAllowed: false,
            squashMergeAllowed: true,
            rebaseMergeAllowed: false,
            viewerDefaultMergeMethod: "SQUASH",
          },
          isMergeQueueEnabled: false,
          isInMergeQueue: false,
        },
      }),
    ).toMatchObject({
      mergeable: "MERGEABLE",
      checksStatus: "pending",
      github: {
        mergeStateStatus: "BLOCKED",
        viewerCanEnableAutoMerge: true,
        repository: {
          autoMergeAllowed: true,
          squashMergeAllowed: true,
          viewerDefaultMergeMethod: "SQUASH",
        },
      },
    });
  });

  test.each(["merge", "squash", "rebase"] as const)(
    "accepts %s as a PR merge method",
    (mergeMethod) => {
      expect(
        CheckoutPrMergeRequestSchema.parse({
          type: "checkout_pr_merge_request",
          cwd: "/tmp/repo",
          mergeMethod,
          requestId: "request-merge-pr",
        }),
      ).toMatchObject({ mergeMethod });
    },
  );

  test("rejects unknown PR merge methods", () => {
    expect(() =>
      CheckoutPrMergeRequestSchema.parse({
        type: "checkout_pr_merge_request",
        cwd: "/tmp/repo",
        mergeMethod: "auto",
        requestId: "request-merge-pr",
      }),
    ).toThrow();
  });

  test.each(["merge", "squash", "rebase"] as const)(
    "accepts %s as a GitHub set-auto-merge enable method",
    (mergeMethod) => {
      expect(
        CheckoutGithubSetAutoMergeRequestSchema.parse({
          type: "checkout.github.set_auto_merge.request",
          cwd: "/tmp/repo",
          enabled: true,
          mergeMethod,
          requestId: "request-enable-auto-merge",
        }),
      ).toMatchObject({ enabled: true, mergeMethod });
    },
  );

  test("rejects unknown GitHub set-auto-merge enable methods", () => {
    expect(() =>
      CheckoutGithubSetAutoMergeRequestSchema.parse({
        type: "checkout.github.set_auto_merge.request",
        cwd: "/tmp/repo",
        enabled: true,
        mergeMethod: "auto",
        requestId: "request-enable-auto-merge",
      }),
    ).toThrow();
  });

  test("accepts GitHub set-auto-merge disable requests", () => {
    expect(
      CheckoutGithubSetAutoMergeRequestSchema.parse({
        type: "checkout.github.set_auto_merge.request",
        cwd: "/tmp/repo",
        enabled: false,
        requestId: "request-disable-auto-merge",
      }),
    ).toMatchObject({
      cwd: "/tmp/repo",
      enabled: false,
      requestId: "request-disable-auto-merge",
    });
  });

  test("accepts GitHub set-auto-merge responses", () => {
    const payload = {
      cwd: "/tmp/repo",
      enabled: true,
      success: true,
      error: null,
      requestId: "request-auto-merge",
    };

    expect(
      CheckoutGithubSetAutoMergeResponseSchema.parse({
        type: "checkout.github.set_auto_merge.response",
        payload,
      }).payload,
    ).toEqual(payload);
  });

  test("accepts the GitHub auto-merge server_info feature flag", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_test",
        features: {
          providersSnapshot: true,
          checkoutGithubSetAutoMerge: true,
        },
      }).features,
    ).toEqual({
      providersSnapshot: true,
      checkoutGithubSetAutoMerge: true,
    });
  });

  test("accepts the prReviewThreads server_info feature flag", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_test",
        features: {
          prReviewThreads: true,
        },
      }).features,
    ).toEqual({
      prReviewThreads: true,
    });
  });

  test("parses a review threads request", () => {
    expect(
      PullRequestReviewThreadsRequestSchema.parse({
        type: "pr.github.get_review_threads.request",
        cwd: "/tmp/repo",
        prNumber: 42,
        repoOwner: "getpaseo",
        repoName: "paseo",
        requestId: "req-threads",
      }),
    ).toMatchObject({
      cwd: "/tmp/repo",
      prNumber: 42,
      repoOwner: "getpaseo",
      repoName: "paseo",
      requestId: "req-threads",
    });
  });

  test("parses a review threads response with threads and comments", () => {
    const parsed = PullRequestReviewThreadsResponseSchema.parse({
      type: "pr.github.get_review_threads.response",
      payload: {
        cwd: "/tmp/repo",
        prNumber: 42,
        threads: [
          {
            id: "PRT_1",
            path: "src/index.ts",
            line: 12,
            startLine: 10,
            diffHunk: "@@ -1,3 +1,4 @@",
            isResolved: false,
            isOutdated: false,
            comments: [
              {
                id: "PRC_1",
                author: "octocat",
                body: "Please rename this",
                url: "https://github.com/getpaseo/paseo/pull/42#discussion_r1",
                createdAt: 1700000000000,
              },
            ],
          },
        ],
        requestId: "req-threads",
        githubFeaturesEnabled: true,
      },
    });

    expect(parsed.payload).toMatchObject({
      cwd: "/tmp/repo",
      prNumber: 42,
      githubFeaturesEnabled: true,
    });
    expect(parsed.payload.threads).toHaveLength(1);
    expect(parsed.payload.threads[0]).toMatchObject({
      id: "PRT_1",
      path: "src/index.ts",
      line: 12,
      startLine: 10,
      isResolved: false,
    });
    expect(parsed.payload.threads[0].comments[0]).toMatchObject({
      author: "octocat",
      body: "Please rename this",
    });
  });

  test("fills review threads response defaults for a minimal payload", () => {
    const parsed = PullRequestReviewThreadsResponseSchema.parse({
      type: "pr.github.get_review_threads.response",
    });

    expect(parsed.payload).toEqual({
      cwd: "",
      prNumber: 0,
      threads: [],
      truncated: false,
      error: null,
      requestId: "",
      githubFeaturesEnabled: true,
    });
  });

  test("coerces unknown review threads error kinds to unknown", () => {
    const parsed = PullRequestReviewThreadsResponseSchema.parse({
      type: "pr.github.get_review_threads.response",
      payload: {
        error: { kind: "teapot", message: "I'm a teapot" },
      },
    });

    expect(parsed.payload.error).toEqual({ kind: "unknown", message: "I'm a teapot" });
  });

  test.each([
    "missing_cli",
    "auth_required",
    "forbidden",
    "not_found",
    "invalid_identity",
    "unknown",
  ] as const)("preserves the %s review threads error kind", (kind) => {
    const parsed = PullRequestReviewThreadsResponseSchema.parse({
      type: "pr.github.get_review_threads.response",
      payload: {
        error: { kind, message: "boom" },
      },
    });

    expect(parsed.payload.error).toEqual({ kind, message: "boom" });
  });
});
