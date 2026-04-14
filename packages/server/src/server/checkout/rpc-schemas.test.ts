import { describe, expect, test } from "vitest";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "../../shared/messages.js";
import { DiffFileMetadataSchema } from "./rpc-schemas.js";

describe("checkout lazy RPC schemas", () => {
  test("parses checkout/subscribe_diff inbound messages", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "checkout/subscribe_diff",
      requestId: "req-1",
      subscriptionId: "sub-1",
      cwd: "/tmp/repo",
      compare: { mode: "uncommitted" },
    });

    expect(parsed.type).toBe("checkout/subscribe_diff");
  });

  test("parses checkout/unsubscribe_diff inbound messages", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "checkout/unsubscribe_diff",
      subscriptionId: "sub-1",
    });

    expect(parsed.type).toBe("checkout/unsubscribe_diff");
  });

  test("parses checkout/get_file_hunks inbound messages", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "checkout/get_file_hunks",
      requestId: "req-2",
      cwd: "/tmp/repo",
      path: "src/index.ts",
      compare: { mode: "base", baseRef: "main", ignoreWhitespace: true },
    });

    expect(parsed.type).toBe("checkout/get_file_hunks");
  });

  test("parses checkout/diff_snapshot outbound messages", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "checkout/diff_snapshot",
      payload: {
        subscriptionId: "sub-1",
        requestId: "req-1",
        cwd: "/tmp/repo",
        files: [
          {
            path: "src/index.ts",
            isNew: false,
            isDeleted: false,
            additions: 3,
            deletions: 1,
            status: "ok",
            fingerprint: "fp-1",
          },
        ],
        error: null,
      },
    });

    expect(parsed.type).toBe("checkout/diff_snapshot");
  });

  test("parses checkout/file_hunks_response outbound messages", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "checkout/file_hunks_response",
      payload: {
        requestId: "req-3",
        path: "src/index.ts",
        hunks: [
          {
            oldStart: 1,
            oldCount: 1,
            newStart: 1,
            newCount: 2,
            lines: [
              { type: "header", content: "@@ -1,1 +1,2 @@" },
              { type: "context", content: "const a = 1;" },
              { type: "add", content: "const b = 2;" },
            ],
          },
        ],
        error: null,
      },
    });

    expect(parsed.type).toBe("checkout/file_hunks_response");
  });

  test("requires fingerprint on diff metadata", () => {
    const result = DiffFileMetadataSchema.safeParse({
      path: "src/index.ts",
      isNew: false,
      isDeleted: false,
      additions: 3,
      deletions: 1,
      status: "ok",
    });

    expect(result.success).toBe(false);
  });

  test("accepts lazyDiffRpcs in server info features", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-1",
      hostname: null,
      version: null,
      capabilities: {},
      features: {
        providersSnapshot: true,
        lazyDiffRpcs: true,
      },
    });

    expect(parsed.features?.lazyDiffRpcs).toBe(true);
  });
});
