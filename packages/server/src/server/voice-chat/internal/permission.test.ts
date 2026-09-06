import { describe, expect, test } from "vitest";

import type { AgentPermissionRequest } from "../../agent/agent-sdk-types.js";
import { isManualVoicePermissionAllowed } from "../providers/manual/permission.js";

function buildRequest(partial: Partial<AgentPermissionRequest>): AgentPermissionRequest {
  return {
    id: "req-1",
    provider: "codex",
    name: "unknown",
    kind: "tool",
    ...partial,
  };
}

describe("isManualVoicePermissionAllowed", () => {
  test("allows direct speak tool names across provider conventions", () => {
    const result = isManualVoicePermissionAllowed(buildRequest({ name: "speak" }));
    expect(result).toBe(true);
    expect(isManualVoicePermissionAllowed(buildRequest({ name: "paseo_voice.speak" }))).toBe(true);
    expect(isManualVoicePermissionAllowed(buildRequest({ name: "mcp__paseo_voice__speak" }))).toBe(
      true,
    );
  });

  test("denies non-speak tool names", () => {
    expect(isManualVoicePermissionAllowed(buildRequest({ name: "mcp__paseo__create_agent" }))).toBe(
      false,
    );
    expect(isManualVoicePermissionAllowed(buildRequest({ name: "paseo_create_agent" }))).toBe(
      false,
    );
  });

  test("denies non-tool permission kinds", () => {
    const result = isManualVoicePermissionAllowed(
      buildRequest({ kind: "mode", name: "mcp__paseo__create_agent" }),
    );
    expect(result).toBe(false);
  });

  test("denies wrapper tools even when metadata references speak", () => {
    const denied = isManualVoicePermissionAllowed(
      buildRequest({
        name: "codextool",
        metadata: {
          questions: [{ question: "Allow codextool to call paseo_voice.speak for user feedback?" }],
        },
      }),
    );
    expect(denied).toBe(false);
  });
});
