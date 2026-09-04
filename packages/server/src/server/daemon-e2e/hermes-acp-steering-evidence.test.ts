import { describe, expect, test } from "vitest";

import { createEvidenceRedactor } from "./hermes-acp-steering-evidence.js";

describe("Hermes ACP steering evidence redaction", () => {
  test("preserves seeded identity and assigns distinct stable aliases to later turns", () => {
    const redact = createEvidenceRedactor(
      ["/private/tmp/workspace"],
      new Map([["turn-a", "<turn-1>"]]),
    );

    expect(
      redact({
        first: { turnId: "turn-a", workspaceId: "workspace-a" },
        correction: { turnId: "turn-a", workspaceId: "workspace-a" },
        next: { turnId: "turn-b", workspaceId: "workspace-a" },
        nativeHandle: "session-a",
        providerMessageId: "message-a",
        requestId: "request-a",
        epoch: "epoch-a",
        opaqueMessageId: {
          messageId: "9e7dc2c5-9f14-4592-ad41-bab9e9252b5a",
        },
        semanticMessageId: { messageId: "hermes-steer-correction" },
        semantic: { id: "full-access" },
        path: "/private/tmp/workspace/file.txt",
      }),
    ).toEqual({
      first: { turnId: "<turn-1>", workspaceId: "<workspace-1>" },
      correction: { turnId: "<turn-1>", workspaceId: "<workspace-1>" },
      next: { turnId: "<turn-2>", workspaceId: "<workspace-1>" },
      nativeHandle: "<session-1>",
      providerMessageId: "<message-1>",
      requestId: "<request-1>",
      epoch: "<epoch-1>",
      opaqueMessageId: { messageId: "<message-2>" },
      semanticMessageId: { messageId: "hermes-steer-correction" },
      semantic: { id: "full-access" },
      path: "<temp-path>/file.txt",
    });
  });
});
