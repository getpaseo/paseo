import { describe, expect, test } from "vitest";

import {
  CheckoutCommitsListRequestSchema,
  CheckoutCommitsListResponseSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("checkout.commits.list schemas", () => {
  test("parses a valid request", () => {
    expect(
      CheckoutCommitsListRequestSchema.parse({
        type: "checkout.commits.list.request",
        cwd: "/tmp/repo",
        requestId: "request-commits",
      }),
    ).toEqual({
      type: "checkout.commits.list.request",
      cwd: "/tmp/repo",
      requestId: "request-commits",
    });
  });

  test("parses a valid response with local-only and remote commits", () => {
    const payload = {
      cwd: "/tmp/repo",
      baseRef: "main",
      commits: [
        {
          sha: "1111111111111111111111111111111111111111",
          shortSha: "1111111",
          subject: "Add feature",
          authorName: "Ada",
          authorDate: "2026-06-13T10:00:00.000Z",
          isOnRemote: true,
          isOnBase: false,
          files: [
            { path: "src/a.ts", additions: 10, deletions: 2, status: "modified" },
            { path: "src/b.ts", additions: 5, deletions: 0, status: "added" },
          ],
        },
        {
          sha: "2222222222222222222222222222222222222222",
          shortSha: "2222222",
          subject: "Local only work",
          authorName: "Ada",
          authorDate: "2026-06-13T11:00:00.000Z",
          isOnRemote: false,
          isOnBase: true,
          files: [{ path: "src/c.ts", additions: 1, deletions: 1 }],
        },
      ],
      error: null,
      requestId: "request-commits",
    };

    const parsed = CheckoutCommitsListResponseSchema.parse({
      type: "checkout.commits.list.response",
      payload,
    });

    expect(parsed.payload).toEqual(payload);
    expect(parsed.payload.commits[0]?.isOnRemote).toBe(true);
    expect(parsed.payload.commits[0]?.isOnBase).toBe(false);
    expect(parsed.payload.commits[1]?.isOnRemote).toBe(false);
    expect(parsed.payload.commits[1]?.isOnBase).toBe(true);
    expect(parsed.payload.commits[1]?.files[0]?.status).toBeUndefined();
  });

  test("still parses commits from hosts without base classification", () => {
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

  test("accepts a null baseRef and an error payload", () => {
    const payload = {
      cwd: "/tmp/repo",
      baseRef: null,
      commits: [],
      error: { code: "NOT_GIT_REPO" as const, message: "not a repo" },
      requestId: "request-commits",
    };

    expect(
      CheckoutCommitsListResponseSchema.parse({
        type: "checkout.commits.list.response",
        payload,
      }).payload,
    ).toEqual(payload);
  });

  test("parses the request through the inbound message union", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "checkout.commits.list.request",
        cwd: "/tmp/repo",
        requestId: "request-commits",
      }),
    ).toMatchObject({ type: "checkout.commits.list.request" });
  });

  test("parses the response through the outbound message union", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "checkout.commits.list.response",
        payload: {
          cwd: "/tmp/repo",
          baseRef: "main",
          commits: [],
          error: null,
          requestId: "request-commits",
        },
      }),
    ).toMatchObject({ type: "checkout.commits.list.response" });
  });

  test("accepts the commit history server_info feature flags", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_test",
        features: {
          commitsList: true,
          commitBaseClassification: true,
        },
      }).features,
    ).toEqual({ commitsList: true, commitBaseClassification: true });
  });

  test("still parses server_info without the commitsList feature flag", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_test",
        features: {
          providersSnapshot: true,
        },
      }).features,
    ).toEqual({ providersSnapshot: true });
  });
});
