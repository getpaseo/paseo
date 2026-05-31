import { describe, expect, test } from "vitest";

import {
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
          firstClassPlans: true,
        },
      }).features,
    ).toEqual({
      providersSnapshot: true,
      checkoutGithubSetAutoMerge: true,
      firstClassPlans: true,
    });
  });
});
