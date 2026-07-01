import { describe, expect, test } from "vitest";

import {
  CheckoutGithubGetCheckDetailsRequestSchema,
  CheckoutGithubGetCheckDetailsResponseSchema,
  CheckoutGithubSetAutoMergeRequestSchema,
  CheckoutGithubSetAutoMergeResponseSchema,
  CheckoutPrMergeRequestSchema,
  CheckoutPrStatusSchema,
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

  test("parses optional GitHub check identifiers on PR checks", () => {
    expect(
      CheckoutPrStatusSchema.parse({
        number: 993,
        url: "https://github.com/getpaseo/paseo/pull/993",
        title: "Expose failed check logs",
        state: "open",
        baseRefName: "main",
        headRefName: "phase-6",
        isMerged: false,
        checks: [
          {
            name: "server tests",
            status: "failure",
            url: "https://github.com/getpaseo/paseo/actions/runs/456/job/789",
            checkRunId: 12345,
            workflowRunId: 456,
          },
          {
            name: "legacy context",
            status: "success",
            url: "https://example.com/context",
          },
        ],
      }).checks,
    ).toEqual([
      {
        name: "server tests",
        status: "failure",
        url: "https://github.com/getpaseo/paseo/actions/runs/456/job/789",
        checkRunId: 12345,
        workflowRunId: 456,
      },
      {
        name: "legacy context",
        status: "success",
        url: "https://example.com/context",
      },
    ]);
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

  test("accepts GitHub check details requests and responses", () => {
    expect(
      CheckoutGithubGetCheckDetailsRequestSchema.parse({
        type: "checkout.github.get_check_details.request",
        cwd: "/tmp/repo",
        repoOwner: "getpaseo",
        repoName: "paseo",
        checkRunId: 12345,
        workflowRunId: 456,
        requestId: "request-check-details",
      }),
    ).toEqual({
      type: "checkout.github.get_check_details.request",
      cwd: "/tmp/repo",
      repoOwner: "getpaseo",
      repoName: "paseo",
      checkRunId: 12345,
      workflowRunId: 456,
      requestId: "request-check-details",
    });

    expect(
      CheckoutGithubGetCheckDetailsResponseSchema.parse({
        type: "checkout.github.get_check_details.response",
        payload: {
          cwd: "/tmp/repo",
          success: true,
          details: {
            checkRunId: 12345,
            workflowRunId: 456,
            name: "server tests",
            status: "completed",
            conclusion: "failure",
            url: "https://github.com/getpaseo/paseo/actions/runs/456/job/789",
            output: {
              title: "Tests failed",
              summary: "1 failure",
              text: "Assertion failed",
            },
            annotations: [
              {
                path: "packages/server/src/index.ts",
                startLine: 10,
                endLine: 12,
                annotationLevel: "failure",
                message: "Expected true",
              },
            ],
            failedJobs: [
              {
                jobId: 789,
                name: "test",
                status: "completed",
                conclusion: "failure",
                url: "https://github.com/getpaseo/paseo/actions/runs/456/job/789",
                logTail: "last line",
                logTruncated: false,
              },
            ],
            truncated: true,
          },
          error: null,
          requestId: "request-check-details",
        },
      }).payload.details,
    ).toMatchObject({
      checkRunId: 12345,
      workflowRunId: 456,
      failedJobs: [{ jobId: 789, logTail: "last line" }],
      truncated: true,
    });
  });

  test("rejects invalid GitHub check details request identities", () => {
    const request = {
      type: "checkout.github.get_check_details.request",
      cwd: "/tmp/repo",
      repoOwner: "getpaseo",
      repoName: "paseo",
      checkRunId: 12345,
      requestId: "request-check-details",
    };

    expect(() =>
      CheckoutGithubGetCheckDetailsRequestSchema.parse({ ...request, repoOwner: "../owner" }),
    ).toThrow();
    expect(() =>
      CheckoutGithubGetCheckDetailsRequestSchema.parse({ ...request, repoName: "" }),
    ).toThrow();
    expect(() =>
      CheckoutGithubGetCheckDetailsRequestSchema.parse({ ...request, checkRunId: 0 }),
    ).toThrow();
    expect(() =>
      CheckoutGithubGetCheckDetailsRequestSchema.parse({ ...request, workflowRunId: 1.5 }),
    ).toThrow();
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

  test("accepts the GitHub check details server_info feature flag", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_test",
        features: {
          githubCheckDetails: true,
        },
      }).features,
    ).toEqual({
      githubCheckDetails: true,
    });
  });

  test("accepts the project removal server_info feature flag", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_test",
        features: {
          projectRemove: true,
        },
      }).features,
    ).toEqual({
      projectRemove: true,
    });
  });

  test("accepts the project add server_info feature flag", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_test",
        features: {
          projectAdd: true,
        },
      }).features,
    ).toEqual({
      projectAdd: true,
    });
  });
});
