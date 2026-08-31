import { describe, expect, test } from "vitest";

import {
  CheckoutCommitsListHistoryRequestSchema,
  CheckoutCommitsListHistoryResponseSchema,
  CheckoutCommitsListResponseSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

const COMMIT = {
  sha: "1111111111111111111111111111111111111111",
  shortSha: "1111111",
  subject: "Add feature",
  authorName: "Ada",
  authorDate: "2026-06-13T10:00:00.000Z",
  refs: [] as { kind: "head" | "local_branch" | "remote_branch" | "tag"; name: string }[],
};

function historyPayload(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp/repo",
    scope: "head" as const,
    commits: [COMMIT],
    pageInfo: { nextCursor: "cursor-2", hasMore: true },
    cursorExpired: false,
    pinnedTipCount: 1,
    pinnedTipsTruncated: false,
    error: null,
    requestId: "request-history",
    ...overrides,
  };
}

describe("checkout.commits.list_history schemas", () => {
  test("parses a minimal request without scope or page", () => {
    const parsed = CheckoutCommitsListHistoryRequestSchema.parse({
      type: "checkout.commits.list_history.request",
      cwd: "/tmp/repo",
      requestId: "request-history",
    });

    expect(parsed.scope).toBeUndefined();
    expect(parsed.page).toBeUndefined();
  });

  test("parses a full request with scope and a paged cursor", () => {
    const request = {
      type: "checkout.commits.list_history.request" as const,
      cwd: "/tmp/repo",
      scope: "all" as const,
      page: { limit: 50, cursor: "opaque-cursor" },
      requestId: "request-history",
    };

    expect(CheckoutCommitsListHistoryRequestSchema.parse(request)).toEqual(request);
  });

  test("rejects out-of-range page limits", () => {
    for (const limit of [0, 201]) {
      expect(
        CheckoutCommitsListHistoryRequestSchema.safeParse({
          type: "checkout.commits.list_history.request",
          cwd: "/tmp/repo",
          page: { limit },
          requestId: "request-history",
        }).success,
      ).toBe(false);
    }
  });

  test("parses a response carrying every ref kind", () => {
    const payload = historyPayload({
      scope: "all",
      commits: [
        {
          ...COMMIT,
          refs: [
            { kind: "head", name: "HEAD" },
            { kind: "local_branch", name: "main" },
            { kind: "remote_branch", name: "origin/main" },
            { kind: "tag", name: "v0.7.0-beta.3" },
          ],
        },
        { ...COMMIT, sha: "2".repeat(40), shortSha: "2222222", refs: [] },
      ],
      pinnedTipCount: 12,
      pinnedTipsTruncated: true,
    });

    const parsed = CheckoutCommitsListHistoryResponseSchema.parse({
      type: "checkout.commits.list_history.response",
      payload,
    });

    expect(parsed.payload).toEqual(payload);
    expect(parsed.payload.commits[0]?.refs).toHaveLength(4);
    expect(parsed.payload.commits[1]?.refs).toEqual([]);
  });

  test("parses an expired-cursor response", () => {
    const payload = historyPayload({
      commits: [],
      pageInfo: { nextCursor: null, hasMore: false },
      cursorExpired: true,
      pinnedTipCount: 0,
    });

    expect(
      CheckoutCommitsListHistoryResponseSchema.parse({
        type: "checkout.commits.list_history.response",
        payload,
      }).payload,
    ).toEqual(payload);
  });

  test("parses an error response", () => {
    const payload = historyPayload({
      commits: [],
      pageInfo: { nextCursor: null, hasMore: false },
      pinnedTipCount: 0,
      error: { code: "NOT_GIT_REPO" as const, message: "not a repo" },
    });

    expect(
      CheckoutCommitsListHistoryResponseSchema.parse({
        type: "checkout.commits.list_history.response",
        payload,
      }).payload.error,
    ).toEqual({ code: "NOT_GIT_REPO", message: "not a repo" });
  });

  test("parses the request through the inbound message union", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "checkout.commits.list_history.request",
        cwd: "/tmp/repo",
        scope: "all",
        page: { limit: 50 },
        requestId: "request-history",
      }),
    ).toMatchObject({ type: "checkout.commits.list_history.request" });
  });

  test("parses the response through the outbound message union", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "checkout.commits.list_history.response",
        payload: historyPayload(),
      }),
    ).toMatchObject({ type: "checkout.commits.list_history.response" });
  });

  test("accepts the commitHistoryLog server_info feature flag", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_test",
        features: { commitHistoryLog: true },
      }).features,
    ).toEqual({ commitHistoryLog: true });
  });

  test("still parses server_info without the commitHistoryLog flag", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_test",
        features: { commitsList: true },
      }).features,
    ).toEqual({ commitsList: true });
  });

  test("leaves the existing commits list response untouched", () => {
    // Regression guard: adding the history RPC must not have widened or narrowed
    // CheckoutCommitSchema, which older apps still parse.
    const parsed = CheckoutCommitsListResponseSchema.parse({
      type: "checkout.commits.list.response",
      payload: {
        cwd: "/tmp/repo",
        baseRef: "main",
        commits: [
          {
            sha: "1111111111111111111111111111111111111111",
            shortSha: "1111111",
            subject: "Legacy commit",
            authorName: "Ada",
            authorDate: "2026-06-13T10:00:00.000Z",
            isOnRemote: true,
            files: [],
          },
        ],
        error: null,
        requestId: "request-commits",
      },
    });

    expect(parsed.payload.commits[0]?.isOnBase).toBeUndefined();
  });
});
