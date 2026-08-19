import { describe, expect, test } from "vitest";

import {
  CheckoutCommitRequestSchema,
  CheckoutIndexUpdateRequestSchema,
  CheckoutIndexUpdateResponseSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("checkout commit schemas", () => {
  test("accepts optional selected files without changing legacy requests", () => {
    expect(
      CheckoutCommitRequestSchema.parse({
        type: "checkout_commit_request",
        cwd: "/tmp/repo",
        message: "Selected files",
        files: ["src/new.ts", "src/old.ts"],
        requestId: "commit-1",
      }),
    ).toEqual({
      type: "checkout_commit_request",
      cwd: "/tmp/repo",
      message: "Selected files",
      files: ["src/new.ts", "src/old.ts"],
      requestId: "commit-1",
    });

    expect(
      CheckoutCommitRequestSchema.parse({
        type: "checkout_commit_request",
        cwd: "/tmp/repo",
        addAll: true,
        requestId: "legacy-commit",
      }),
    ).toEqual({
      type: "checkout_commit_request",
      cwd: "/tmp/repo",
      addAll: true,
      requestId: "legacy-commit",
    });
  });

  test("keeps an empty selected-file list distinct from an omitted list", () => {
    expect(
      CheckoutCommitRequestSchema.parse({
        type: "checkout_commit_request",
        cwd: "/tmp/repo",
        files: [],
        requestId: "commit-empty",
      }).files,
    ).toEqual([]);
  });

  test("accepts selective commit and git index feature flags", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_test",
        features: {
          checkoutSelectiveCommit: true,
          checkoutGitIndex: true,
        },
      }).features,
    ).toEqual({
      checkoutSelectiveCommit: true,
      checkoutGitIndex: true,
    });
  });

  test("parses staged-index updates through the session unions", () => {
    const request = {
      type: "checkout.index.update.request" as const,
      cwd: "/tmp/repo",
      operation: "stage" as const,
      paths: ["src/changed.ts"],
      requestId: "index-1",
    };
    const response = {
      type: "checkout.index.update.response" as const,
      payload: {
        cwd: "/tmp/repo",
        operation: "stage" as const,
        success: true,
        error: null,
        requestId: "index-1",
      },
    };
    const allRequest = {
      type: "checkout.index.update.request" as const,
      cwd: "/tmp/repo",
      operation: "stage" as const,
      all: true,
      requestId: "index-all-1",
    };

    expect(CheckoutIndexUpdateRequestSchema.parse(request)).toEqual(request);
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    expect(CheckoutIndexUpdateRequestSchema.parse(allRequest)).toEqual(allRequest);
    expect(SessionInboundMessageSchema.parse(allRequest)).toEqual(allRequest);
    expect(CheckoutIndexUpdateResponseSchema.parse(response)).toEqual(response);
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  });
});
