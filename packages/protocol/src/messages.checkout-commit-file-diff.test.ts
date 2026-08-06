import { describe, expect, test } from "vitest";

import {
  CheckoutCommitFileDiffRequestSchema,
  CheckoutCommitFileDiffResponseSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("checkout.commits.file_diff schemas", () => {
  test("parses a valid request", () => {
    expect(
      CheckoutCommitFileDiffRequestSchema.parse({
        type: "checkout.commits.file_diff.request",
        cwd: "/tmp/repo",
        sha: "1111111111111111111111111111111111111111",
        path: "src/a.ts",
        requestId: "request-file-diff",
      }),
    ).toEqual({
      type: "checkout.commits.file_diff.request",
      cwd: "/tmp/repo",
      sha: "1111111111111111111111111111111111111111",
      path: "src/a.ts",
      requestId: "request-file-diff",
    });
  });

  test("parses a valid response with a populated ParsedDiffFile", () => {
    const payload = {
      cwd: "/tmp/repo",
      sha: "1111111111111111111111111111111111111111",
      path: "src/a.ts",
      file: {
        path: "src/a.ts",
        isNew: false,
        isDeleted: false,
        additions: 2,
        deletions: 1,
        hunks: [
          {
            oldStart: 1,
            oldCount: 2,
            newStart: 1,
            newCount: 3,
            lines: [
              { type: "header" as const, content: "@@ -1,2 +1,3 @@" },
              { type: "context" as const, content: "first" },
              { type: "remove" as const, content: "old" },
              { type: "add" as const, content: "new1" },
              { type: "add" as const, content: "new2" },
            ],
          },
        ],
        status: "ok" as const,
      },
      error: null,
      requestId: "request-file-diff",
    };

    const parsed = CheckoutCommitFileDiffResponseSchema.parse({
      type: "checkout.commits.file_diff.response",
      payload,
    });

    expect(parsed.payload).toEqual(payload);
    expect(parsed.payload.file?.hunks[0]?.lines).toHaveLength(5);
  });

  test("parses a valid response with a null file", () => {
    const payload = {
      cwd: "/tmp/repo",
      sha: "1111111111111111111111111111111111111111",
      path: "src/missing.ts",
      file: null,
      error: null,
      requestId: "request-file-diff",
    };

    expect(
      CheckoutCommitFileDiffResponseSchema.parse({
        type: "checkout.commits.file_diff.response",
        payload,
      }).payload,
    ).toEqual(payload);
  });

  test("accepts a null file with an error payload", () => {
    const payload = {
      cwd: "/tmp/repo",
      sha: "1111111111111111111111111111111111111111",
      path: "src/a.ts",
      file: null,
      error: { code: "UNKNOWN" as const, message: "boom" },
      requestId: "request-file-diff",
    };

    expect(
      CheckoutCommitFileDiffResponseSchema.parse({
        type: "checkout.commits.file_diff.response",
        payload,
      }).payload,
    ).toEqual(payload);
  });

  test("parses the request through the inbound message union", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "checkout.commits.file_diff.request",
        cwd: "/tmp/repo",
        sha: "1111111111111111111111111111111111111111",
        path: "src/a.ts",
        requestId: "request-file-diff",
      }),
    ).toMatchObject({ type: "checkout.commits.file_diff.request" });
  });

  test("parses the response through the outbound message union", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "checkout.commits.file_diff.response",
        payload: {
          cwd: "/tmp/repo",
          sha: "1111111111111111111111111111111111111111",
          path: "src/a.ts",
          file: null,
          error: null,
          requestId: "request-file-diff",
        },
      }),
    ).toMatchObject({ type: "checkout.commits.file_diff.response" });
  });
});
