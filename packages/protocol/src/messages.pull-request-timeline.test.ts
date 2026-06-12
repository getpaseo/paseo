import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  CheckoutPrStatusResponseSchema,
  PullRequestTimelineRequestSchema,
  PullRequestTimelineResponseSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("pull request timeline message schemas", () => {
  test("requires request identity fields", () => {
    expect(() =>
      PullRequestTimelineRequestSchema.parse({
        type: "pull_request_timeline_request",
      }),
    ).toThrow();
  });

  test("parses request fields", () => {
    const parsed = PullRequestTimelineRequestSchema.parse({
      type: "pull_request_timeline_request",
      cwd: "/tmp/repo",
      prNumber: 42,
      repoOwner: "getpaseo",
      repoName: "paseo",
      requestId: "request-1",
    });

    expect(parsed).toEqual({
      type: "pull_request_timeline_request",
      cwd: "/tmp/repo",
      prNumber: 42,
      repoOwner: "getpaseo",
      repoName: "paseo",
      requestId: "request-1",
    });
  });

  test("parses request through the inbound message union", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "pull_request_timeline_request",
      cwd: "/tmp/repo",
      prNumber: 42,
      repoOwner: "getpaseo",
      repoName: "paseo",
      requestId: "request-1",
    });

    expect(parsed).toEqual({
      type: "pull_request_timeline_request",
      cwd: "/tmp/repo",
      prNumber: 42,
      repoOwner: "getpaseo",
      repoName: "paseo",
      requestId: "request-1",
    });
  });

  test("defaults optional response payload and malformed timeline item fields", () => {
    const parsed = PullRequestTimelineResponseSchema.parse({
      type: "pull_request_timeline_response",
      payload: {
        items: [{}, { kind: "review" }],
      },
    });

    expect(parsed).toEqual({
      type: "pull_request_timeline_response",
      payload: {
        cwd: "",
        prNumber: null,
        items: [
          {
            id: "",
            kind: "comment",
            author: "unknown",
            body: "",
            createdAt: 0,
            url: "",
          },
          {
            id: "",
            kind: "review",
            author: "unknown",
            body: "",
            createdAt: 0,
            url: "",
            reviewState: "commented",
          },
        ],
        truncated: false,
        error: null,
        requestId: "",
        githubFeaturesEnabled: true,
      },
    });
  });

  test("normalizes unknown timeline item kinds to comments", () => {
    const parsed = PullRequestTimelineResponseSchema.parse({
      type: "pull_request_timeline_response",
      payload: {
        items: [
          {
            id: "future-1",
            kind: "unknown_future_kind",
            author: "octocat",
            body: "Future daemon item",
            createdAt: 1710000000000,
            url: "https://github.com/getpaseo/paseo/pull/42#future-1",
          },
        ],
      },
    });

    expect(parsed.payload.items).toEqual([
      {
        id: "future-1",
        kind: "comment",
        author: "octocat",
        body: "Future daemon item",
        createdAt: 1710000000000,
        url: "https://github.com/getpaseo/paseo/pull/42#future-1",
      },
    ]);
  });

  test("parses optional author avatar, author URL, and inline comment location fields", () => {
    const parsed = PullRequestTimelineResponseSchema.parse({
      type: "pull_request_timeline_response",
      payload: {
        items: [
          {
            id: "review-1",
            kind: "review",
            author: "octocat",
            authorUrl: "https://github.com/octocat",
            avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
            body: "Looks good",
            createdAt: 1710000000000,
            url: "https://github.com/getpaseo/paseo/pull/42#pullrequestreview-1",
            reviewState: "approved",
          },
          {
            id: "thread-comment-1",
            kind: "comment",
            author: "hubot",
            authorUrl: "https://github.com/hubot",
            avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4",
            body: "Inline note",
            createdAt: 1710000001000,
            url: "https://github.com/getpaseo/paseo/pull/42#discussion_r1",
            location: {
              path: "packages/app/src/git/pull-request-panel/data.ts",
              line: 24,
              startLine: 20,
              threadId: "PRRT_1",
              isResolved: true,
              isOutdated: false,
            },
          },
        ],
      },
    });

    expect(parsed.payload.items).toEqual([
      {
        id: "review-1",
        kind: "review",
        author: "octocat",
        authorUrl: "https://github.com/octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        body: "Looks good",
        createdAt: 1710000000000,
        url: "https://github.com/getpaseo/paseo/pull/42#pullrequestreview-1",
        reviewState: "approved",
      },
      {
        id: "thread-comment-1",
        kind: "comment",
        author: "hubot",
        authorUrl: "https://github.com/hubot",
        avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4",
        body: "Inline note",
        createdAt: 1710000001000,
        url: "https://github.com/getpaseo/paseo/pull/42#discussion_r1",
        location: {
          path: "packages/app/src/git/pull-request-panel/data.ts",
          line: 24,
          startLine: 20,
          threadId: "PRRT_1",
          isResolved: true,
          isOutdated: false,
        },
      },
    ]);
  });

  test("parses response through the outbound message union", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "pull_request_timeline_response",
      payload: {
        cwd: "/tmp/repo",
        prNumber: 42,
        items: [
          {
            id: "review-1",
            kind: "review",
            author: "octocat",
            body: "Looks good",
            createdAt: 1710000000000,
            url: "https://github.com/getpaseo/paseo/pull/42#pullrequestreview-1",
            reviewState: "approved",
          },
          {
            id: "comment-1",
            kind: "comment",
            author: "hubot",
            body: "Left a note",
            createdAt: 1710000001000,
            url: "https://github.com/getpaseo/paseo/pull/42#issuecomment-1",
          },
        ],
        truncated: true,
        error: { kind: "unknown", message: "rate limited" },
        requestId: "request-1",
        githubFeaturesEnabled: true,
      },
    });

    expect(parsed.type).toBe("pull_request_timeline_response");
  });

  test("an old client timeline schema parses new daemon avatar and inline location fields", () => {
    const oldClientPullRequestTimelineResponseSchema = z.object({
      type: z.literal("pull_request_timeline_response"),
      payload: z.object({
        cwd: z.string(),
        prNumber: z.number().nullable(),
        items: z.array(
          z.discriminatedUnion("kind", [
            z.object({
              id: z.string(),
              kind: z.literal("review"),
              author: z.string(),
              body: z.string(),
              createdAt: z.number(),
              url: z.string(),
              reviewState: z.enum(["approved", "changes_requested", "commented"]),
            }),
            z.object({
              id: z.string(),
              kind: z.literal("comment"),
              author: z.string(),
              body: z.string(),
              createdAt: z.number(),
              url: z.string(),
            }),
          ]),
        ),
        truncated: z.boolean(),
        error: z.unknown().nullable(),
        requestId: z.string(),
        githubFeaturesEnabled: z.boolean(),
      }),
    });
    const newDaemonPayload = PullRequestTimelineResponseSchema.parse({
      type: "pull_request_timeline_response",
      payload: {
        cwd: "/tmp/repo",
        prNumber: 42,
        items: [
          {
            id: "comment-1",
            kind: "comment",
            author: "octocat",
            authorUrl: "https://github.com/octocat",
            avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
            body: "Inline note",
            createdAt: 1710000000000,
            url: "https://github.com/getpaseo/paseo/pull/42#discussion_r1",
            location: {
              path: "src/file.ts",
              line: 12,
              threadId: "PRRT_1",
            },
          },
        ],
        truncated: false,
        error: null,
        requestId: "request-compat",
        githubFeaturesEnabled: true,
      },
    });

    expect(oldClientPullRequestTimelineResponseSchema.parse(newDaemonPayload)).toEqual({
      type: "pull_request_timeline_response",
      payload: {
        cwd: "/tmp/repo",
        prNumber: 42,
        items: [
          {
            id: "comment-1",
            kind: "comment",
            author: "octocat",
            body: "Inline note",
            createdAt: 1710000000000,
            url: "https://github.com/getpaseo/paseo/pull/42#discussion_r1",
          },
        ],
        truncated: false,
        error: null,
        requestId: "request-compat",
        githubFeaturesEnabled: true,
      },
    });
  });

  test("normalizes future error kinds to unknown", () => {
    const parsed = PullRequestTimelineResponseSchema.parse({
      type: "pull_request_timeline_response",
      payload: {
        error: { kind: "future_kind", message: "x" },
      },
    });

    expect(parsed.payload.error).toEqual({ kind: "unknown", message: "x" });
  });

  test.each(["rate_limited", "", undefined])(
    "normalizes malformed error kind %j to unknown",
    (kind) => {
      const parsed = PullRequestTimelineResponseSchema.parse({
        type: "pull_request_timeline_response",
        payload: {
          error: { kind },
        },
      });

      expect(parsed.payload.error).toEqual({ kind: "unknown", message: "" });
    },
  );
});

describe("checkout PR status compatibility", () => {
  test("an old client schema parses a new daemon checkout PR status response", () => {
    const oldClientCheckoutPrStatusResponseSchema = z.object({
      type: z.literal("checkout_pr_status_response"),
      payload: z.object({
        cwd: z.string(),
        status: z
          .object({
            url: z.string(),
            title: z.string(),
            state: z.string(),
            baseRefName: z.string(),
            headRefName: z.string(),
            isMerged: z.boolean(),
            checks: z
              .array(
                z.object({
                  name: z.string(),
                  status: z.string(),
                  url: z.string().nullable(),
                }),
              )
              .optional()
              .default([]),
            checksStatus: z.string().optional(),
            reviewDecision: z.string().nullable().optional(),
          })
          .nullable(),
        githubFeaturesEnabled: z.boolean(),
        error: z.unknown().nullable(),
        requestId: z.string(),
      }),
    });
    const newDaemonPayload = CheckoutPrStatusResponseSchema.parse({
      type: "checkout_pr_status_response",
      payload: {
        cwd: "/tmp/repo",
        status: {
          number: 42,
          url: "https://github.com/getpaseo/paseo/pull/42",
          title: "Wire real PR pane data",
          state: "OPEN",
          baseRefName: "main",
          headRefName: "feature/pr-pane",
          isMerged: false,
          isDraft: true,
          checks: [
            {
              name: "server-tests",
              status: "success",
              url: "https://github.com/getpaseo/paseo/actions/runs/123",
              workflow: "Server CI",
              duration: "2m 14s",
            },
          ],
          checksStatus: "success",
          reviewDecision: "APPROVED",
        },
        githubFeaturesEnabled: true,
        error: null,
        requestId: "request-compat",
      },
    });

    expect(oldClientCheckoutPrStatusResponseSchema.parse(newDaemonPayload)).toEqual({
      type: "checkout_pr_status_response",
      payload: {
        cwd: "/tmp/repo",
        status: {
          url: "https://github.com/getpaseo/paseo/pull/42",
          title: "Wire real PR pane data",
          state: "OPEN",
          baseRefName: "main",
          headRefName: "feature/pr-pane",
          isMerged: false,
          checks: [
            {
              name: "server-tests",
              status: "success",
              url: "https://github.com/getpaseo/paseo/actions/runs/123",
            },
          ],
          checksStatus: "success",
          reviewDecision: "APPROVED",
        },
        githubFeaturesEnabled: true,
        error: null,
        requestId: "request-compat",
      },
    });
  });
});
