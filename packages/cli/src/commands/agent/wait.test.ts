import { describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { buildWaitResult } from "./wait.js";

const agentId = "11111111-1111-4111-8111-111111111111";

describe("buildWaitResult", () => {
  it("reports an identifier the daemon could not resolve as a missing agent", () => {
    expect(() =>
      buildWaitResult({
        state: {
          status: "error",
          final: null,
          error: "Agent not found: does-not-exist",
          lastMessage: null,
        },
        resolvedAgentId: "does-not-exist",
        recentActivity: null,
        timeoutLabel: null,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "AGENT_NOT_FOUND",
        message: "Agent not found: does-not-exist",
        details: "Use `paseo ls` to list available agents",
      }),
    );
  });

  it("still reports an agent that finished in error as a result", () => {
    const result = buildWaitResult({
      state: {
        status: "error",
        final: { id: agentId, lastError: "The provider returned 500" } as AgentSnapshotPayload,
        error: "The provider returned 500",
        lastMessage: null,
      },
      resolvedAgentId: agentId,
      recentActivity: null,
      timeoutLabel: null,
    });

    expect(result).toEqual({
      agentId,
      status: "error",
      message: "The provider returned 500",
    });
  });
});
