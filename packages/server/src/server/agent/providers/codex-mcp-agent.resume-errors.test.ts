import { describe, expect, test } from "vitest";

import { __test__ } from "./codex-mcp-agent.js";

describe("codex resume error detection", () => {
  test("detects missing session errors for thread_id", () => {
    const error = new Error(
      "Session not found for thread_id: 019bda3e-ffe4-7bc1-ae0e-9b992d7c9360"
    );
    expect(__test__.isMissingConversationIdError(error)).toBe(true);
  });

  test("detects missing session responses for thread_id", () => {
    const response = {
      content: [{ type: "text", text: "Session not found for thread_id: abc" }],
    };
    expect(__test__.isMissingConversationIdResponse(response)).toBe(true);
  });
});
