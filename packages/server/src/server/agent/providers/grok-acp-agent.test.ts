import type { SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";

import type { AvailableACPModel } from "./acp-agent.js";
import { resolveGrokContextUsage } from "./grok-acp-agent.js";

function notification(totalTokens: unknown): SessionNotification {
  return {
    sessionId: "grok-session",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "pong" },
    },
    _meta: { totalTokens },
  };
}

function model(totalContextTokens: unknown): AvailableACPModel {
  return {
    modelId: "grok-4.7",
    name: "Grok 4.7",
    _meta: { totalContextTokens },
  };
}

describe("Grok context usage", () => {
  // Field names captured from Grok 1.0.50 ACP on 2026-10-10.
  test("maps notification occupancy and the selected model capacity", () => {
    expect(resolveGrokContextUsage(notification(19_172), model(256_000))).toEqual({
      used: 19_172,
      size: 256_000,
    });
  });

  test("uses the supplied model capacity without a hardcoded model default", () => {
    expect(resolveGrokContextUsage(notification(1_000), model(500_000))).toEqual({
      used: 1_000,
      size: 500_000,
    });
  });

  test("preserves zero occupancy", () => {
    expect(resolveGrokContextUsage(notification(0), model(256_000))).toEqual({
      used: 0,
      size: 256_000,
    });
  });

  test.each([undefined, null, "1000", -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "ignores invalid occupancy %s",
    (used) => {
      expect(resolveGrokContextUsage(notification(used), model(256_000))).toBeUndefined();
    },
  );

  test.each([undefined, null, "256000", 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "ignores invalid capacity %s",
    (size) => {
      expect(resolveGrokContextUsage(notification(1_000), model(size))).toBeUndefined();
    },
  );

  test("ignores a missing selected model", () => {
    expect(resolveGrokContextUsage(notification(1_000), null)).toBeUndefined();
  });
});
