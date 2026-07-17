import { describe, expect, test } from "vitest";

import {
  CheckoutGithubGetCheckDetailsRequestSchema,
  CheckoutGithubGetCheckDetailsResponseSchema,
  CheckoutGithubSetAutoMergeRequestSchema,
  CheckoutGithubSetAutoMergeResponseSchema,
  CheckoutPrMergeRequestSchema,
  CheckoutPrStatusSchema,
  ForgeSearchResponseSchema,
  GitHubSearchResponseSchema,
  ServerInfoStatusPayloadSchema,
} from "./messages.js";

describe("checkout PR schemas", () => {
  test("defaults missing forge identity for old daemon payloads", () => {
    const parsed = CheckoutPrStatusSchema.parse({
      url: "https://github.com/getpaseo/paseo/pull/42",
      title: "Ship it",
      state: "open",
      baseRefName: "main",
      headRefName: "feature/ship-it",
      isMerged: false,
    });

    expect(parsed.forge).toBe("github");
  });

  test("round-trips forge and neutral project identity", () => {
    const payload = {
      forge: "github",
      projectPath: "getpaseo/paseo",
      url: "https://github.com/getpaseo/paseo/pull/42",
      title: "Ship it",
      state: "open",
      baseRefName: "main",
      headRefName: "feature/ship-it",
      isMerged: false,
      isDraft: false,
      mergeable: "UNKNOWN" as const,
      checks: [],
    };

    expect(CheckoutPrStatusSchema.parse(payload)).toEqual(payload);
  });

  test("accepts unknown future forge identities", () => {
    const parsed = CheckoutPrStatusSchema.parse({
      forge: "someforge",
      url: "https://someforge.example/getpaseo/paseo/pulls/42",
      title: "Ship it",
      state: "open",
      baseRefName: "main",
      headRefName: "feature/ship-it",
      isMerged: false,
    });

    expect(parsed.forge).toBe("someforge");
  });

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

  test("keeps forgeSpecific absent for old daemons that only send github facts", () => {
    const parsed = CheckoutPrStatusSchema.parse({
      number: 42,
      url: "https://github.com/getpaseo/paseo/pull/42",
      title: "Ship it",
      state: "open",
      baseRefName: "main",
      headRefName: "feature/ship-it",
      isMerged: false,
      github: {
        mergeStateStatus: "CLEAN",
        autoMergeRequest: null,
        repository: {
          autoMergeAllowed: false,
          mergeCommitAllowed: true,
          squashMergeAllowed: true,
          rebaseMergeAllowed: false,
          viewerDefaultMergeMethod: "MERGE",
        },
      },
    });
    expect(parsed.github?.mergeStateStatus).toBe("CLEAN");
    expect(parsed.forgeSpecific).toBeUndefined();
  });

  test("preserves a github forgeSpecific envelope", () => {
    const parsed = CheckoutPrStatusSchema.parse({
      number: 7,
      url: "https://github.com/getpaseo/paseo/pull/7",
      title: "Ship it",
      state: "open",
      baseRefName: "main",
      headRefName: "feature/ship-it",
      isMerged: false,
      github: {
        mergeStateStatus: "CLEAN",
        autoMergeRequest: null,
        repository: {
          autoMergeAllowed: false,
          mergeCommitAllowed: true,
          squashMergeAllowed: true,
          rebaseMergeAllowed: false,
          viewerDefaultMergeMethod: "MERGE",
        },
      },
      forgeSpecific: {
        forge: "github",
        mergeStateStatus: "CLEAN",
        autoMergeRequest: null,
        repository: {
          autoMergeAllowed: false,
          mergeCommitAllowed: true,
          squashMergeAllowed: true,
          rebaseMergeAllowed: false,
          viewerDefaultMergeMethod: "MERGE",
        },
      },
    });
    expect(parsed.forgeSpecific).toMatchObject({ forge: "github", mergeStateStatus: "CLEAN" });
  });

  test("preserves a gitlab forgeSpecific envelope without protocol-side defaults", () => {
    const parsed = CheckoutPrStatusSchema.parse({
      number: 1,
      url: "https://gitlab.com/group/subgroup/repo/-/merge_requests/1",
      title: "Add sample change",
      state: "open",
      baseRefName: "main",
      headRefName: "feat/sample-change",
      isMerged: false,
      projectPath: "group/subgroup/repo",
      forgeSpecific: {
        forge: "gitlab",
        detailedMergeStatus: "mergeable",
        hasConflicts: false,
        blockingDiscussionsResolved: true,
        approvalsRequired: 1,
        approvalsGiven: 1,
        pipelineStatus: "success",
        mergeWhenPipelineSucceeds: false,
      },
    });
    expect(parsed.forgeSpecific).toEqual({
      forge: "gitlab",
      detailedMergeStatus: "mergeable",
      hasConflicts: false,
      blockingDiscussionsResolved: true,
      approvalsRequired: 1,
      approvalsGiven: 1,
      pipelineStatus: "success",
      mergeWhenPipelineSucceeds: false,
    });
    expect(parsed.github).toBeUndefined();
  });

  test("preserves a gitea forgeSpecific envelope", () => {
    const parsed = CheckoutPrStatusSchema.parse({
      number: 5,
      url: "https://codeberg.org/example/repo/pulls/5",
      title: "Add sample change",
      state: "open",
      baseRefName: "main",
      headRefName: "feat/sample-change",
      isMerged: false,
      forgeSpecific: {
        forge: "gitea",
        mergeable: true,
        hasMerged: false,
        ciStatus: "success",
      },
    });
    expect(parsed.forgeSpecific).toEqual({
      forge: "gitea",
      mergeable: true,
      hasMerged: false,
      ciStatus: "success",
    });
  });

  test("preserves an unknown forgeSpecific envelope without failing the parse", () => {
    const parsed = CheckoutPrStatusSchema.parse({
      number: 9,
      url: "https://example.com/forge/9",
      title: "Future forge",
      state: "open",
      baseRefName: "main",
      headRefName: "feature/future",
      isMerged: false,
      forgeSpecific: { forge: "bitbucket", somethingNew: true },
    });
    expect(parsed.forgeSpecific).toEqual({ forge: "bitbucket", somethingNew: true });
  });

  test("preserves forgejo-specific facts as runtime-owned facts", () => {
    const parsed = CheckoutPrStatusSchema.parse({
      number: 10,
      url: "https://codeberg.org/example/repo/pulls/10",
      title: "Future Forgejo facts",
      state: "open",
      baseRefName: "main",
      headRefName: "feature/forgejo",
      isMerged: false,
      forgeSpecific: { forge: "forgejo", approvalsRequired: 2 },
    });
    expect(parsed.forgeSpecific).toEqual({ forge: "forgejo", approvalsRequired: 2 });
  });

  test("preserves malformed known-family facts for runtime validation", () => {
    const parsed = CheckoutPrStatusSchema.parse({
      number: 11,
      url: "https://gitlab.com/group/repo/-/merge_requests/11",
      title: "Runtime facts",
      state: "open",
      baseRefName: "main",
      headRefName: "feature/runtime-facts",
      isMerged: false,
      forgeSpecific: {
        forge: "gitlab",
        pipelineId: "not-a-number",
        approvalsRequired: "also-runtime-owned",
      },
    });
    expect(parsed.forgeSpecific).toEqual({
      forge: "gitlab",
      pipelineId: "not-a-number",
      approvalsRequired: "also-runtime-owned",
    });
  });

  test("keeps forge-specific facts structural for feature-owned interpretation", () => {
    const parsed = CheckoutPrStatusSchema.parse({
      number: 12,
      url: "https://example.com/forge/12",
      title: "Missing facts tag",
      state: "open",
      baseRefName: "main",
      headRefName: "feature/missing-tag",
      isMerged: false,
      forgeSpecific: { approvalsRequired: 2 },
    });

    expect(parsed.forgeSpecific).toEqual({ approvalsRequired: 2 });
  });

  test("keeps forge search responses structural", () => {
    expect(
      ForgeSearchResponseSchema.parse({
        type: "forge.search.response",
        payload: {
          items: [
            {
              kind: "change_request",
              number: 17,
              title: "Fix search",
              url: "https://gitlab.com/acme/repo/-/merge_requests/17",
              state: "open",
              body: null,
              labels: [],
            },
            { kind: "future_kind", futureField: true },
          ],
          authState: "future_auth_state",
          error: null,
          requestId: "search-2",
        },
      }).payload,
    ).toEqual({
      items: [
        {
          kind: "change_request",
          number: 17,
          title: "Fix search",
          url: "https://gitlab.com/acme/repo/-/merge_requests/17",
          state: "open",
          body: null,
          labels: [],
        },
        { kind: "future_kind", futureField: true },
      ],
      authState: "future_auth_state",
      error: null,
      requestId: "search-2",
    });

    expect(
      GitHubSearchResponseSchema.parse({
        type: "github_search_response",
        payload: {
          items: [],
          githubFeaturesEnabled: false,
          error: null,
          requestId: "search-legacy",
        },
      }).payload,
    ).toEqual({
      items: [],
      githubFeaturesEnabled: false,
      error: null,
      requestId: "search-legacy",
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

  test("accepts a GitLab pipeline through the existing check-details response", () => {
    expect(
      CheckoutGithubGetCheckDetailsRequestSchema.parse({
        type: "checkout.github.get_check_details.request",
        cwd: "/tmp/repo",
        checkRunId: 306,
        requestId: "request-pipeline",
      }),
    ).toEqual({
      type: "checkout.github.get_check_details.request",
      cwd: "/tmp/repo",
      checkRunId: 306,
      requestId: "request-pipeline",
    });

    const details = CheckoutGithubGetCheckDetailsResponseSchema.parse({
      type: "checkout.github.get_check_details.response",
      payload: {
        cwd: "/tmp/repo",
        success: true,
        details: {
          checkRunId: 306,
          name: "Pipeline (feat/x)",
          annotations: [],
          failedJobs: [],
          truncated: false,
          pipeline: {
            id: 306,
            status: "future_pipeline_status",
            rawStatus: "future_pipeline_status",
            stages: [
              {
                name: "test",
                status: "future_stage_status",
                jobs: [
                  {
                    id: 929,
                    name: "unit",
                    stage: "test",
                    status: "future_job_status",
                    rawStatus: "future_job_status",
                  },
                ],
              },
            ],
          },
        },
        error: null,
        requestId: "request-pipeline",
      },
    }).payload.details;

    expect(details?.pipeline).toMatchObject({
      id: 306,
      status: "future_pipeline_status",
      stages: [{ jobs: [{ status: "future_job_status", allowFailure: false }] }],
    });
  });

  test("keeps pipeline absent for legacy and GitHub check-details responses", () => {
    const details = CheckoutGithubGetCheckDetailsResponseSchema.parse({
      type: "checkout.github.get_check_details.response",
      payload: {
        cwd: "/tmp/repo",
        success: true,
        details: {
          checkRunId: 12345,
          name: "server tests",
        },
        error: null,
        requestId: "legacy-check-details",
      },
    }).payload.details;

    expect(details).not.toHaveProperty("pipeline");
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

  test("accepts the forgeProviders server_info feature flag", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_test",
        features: {
          forgeProviders: true,
        },
      }).features,
    ).toEqual({
      forgeProviders: true,
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

  test("accepts the provider removal server_info feature flag", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_test",
        features: {
          providerRemoval: true,
        },
      }).features,
    ).toEqual({
      providerRemoval: true,
    });
  });
});
