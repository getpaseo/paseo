import { describe, expect, test } from "vitest";

import type { AgentPermissionRequest } from "./agent/agent-sdk-types.js";
import { isVoicePermissionAllowed } from "./voice-permission-policy.js";

function buildRequest(partial: Partial<AgentPermissionRequest>): AgentPermissionRequest {
  return {
    id: "req-1",
    provider: "codex",
    name: "unknown",
    kind: "tool",
    ...partial,
  };
}

describe("isVoicePermissionAllowed", () => {
  test("allows speak tool", () => {
    const result = isVoicePermissionAllowed(
      buildRequest({ name: "speak" })
    );
    expect(result).toBe(true);
  });

  test("denies explicit MCP/paseo tool names", () => {
    expect(
      isVoicePermissionAllowed(buildRequest({ name: "mcp__paseo__create_agent" }))
    ).toBe(false);
    expect(
      isVoicePermissionAllowed(buildRequest({ name: "paseo_create_agent" }))
    ).toBe(false);
  });

  test("denies non-tool permission kinds", () => {
    const result = isVoicePermissionAllowed(
      buildRequest({ kind: "mode", name: "mcp__paseo__create_agent" })
    );
    expect(result).toBe(false);
  });

  test("allows codextool only when metadata references speak", () => {
    const allowed = isVoicePermissionAllowed(
      buildRequest({
        name: "codextool",
        metadata: {
          questions: [{ question: "Allow codextool to call speak for user feedback?" }],
        },
      })
    );
    expect(allowed).toBe(true);
  });

  test("denies codextool when metadata includes shell-like operations", () => {
    const denied = isVoicePermissionAllowed(
      buildRequest({
        name: "codextool",
        metadata: {
          questions: [{ question: "Allow codextool to execute shell command?" }],
        },
      })
    );
    expect(denied).toBe(false);
  });
});
