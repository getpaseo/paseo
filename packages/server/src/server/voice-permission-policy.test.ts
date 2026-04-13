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
  test("allows direct speak tool names across provider conventions", () => {
    const result = isVoicePermissionAllowed(buildRequest({ name: "speak" }));
    expect(result).toBe(true);
    expect(isVoicePermissionAllowed(buildRequest({ name: "hubcode_voice.speak" }))).toBe(true);
    expect(isVoicePermissionAllowed(buildRequest({ name: "mcp__hubcode_voice__speak" }))).toBe(
      true,
    );
  });

  test("denies non-speak tool names", () => {
    expect(isVoicePermissionAllowed(buildRequest({ name: "mcp__hubcode__create_agent" }))).toBe(
      false,
    );
    expect(isVoicePermissionAllowed(buildRequest({ name: "hubcode_create_agent" }))).toBe(false);
  });

  test("denies non-tool permission kinds", () => {
    const result = isVoicePermissionAllowed(
      buildRequest({ kind: "mode", name: "mcp__hubcode__create_agent" }),
    );
    expect(result).toBe(false);
  });

  test("denies wrapper tools even when metadata references speak", () => {
    const denied = isVoicePermissionAllowed(
      buildRequest({
        name: "codextool",
        metadata: {
          questions: [
            { question: "Allow codextool to call hubcode_voice.speak for user feedback?" },
          ],
        },
      }),
    );
    expect(denied).toBe(false);
  });
});
