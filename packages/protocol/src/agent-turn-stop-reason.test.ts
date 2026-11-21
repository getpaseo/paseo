import { describe, expect, test } from "vitest";

import { AgentTurnStopReasonSchema } from "./agent-types.js";
import { AgentStreamEventPayloadSchema } from "./messages.js";

describe("AgentTurnStopReasonSchema", () => {
  test("carries every reason a provider can end a turn with", () => {
    expect(AgentTurnStopReasonSchema.options).toEqual([
      "end_turn",
      "max_turn_requests",
      "max_tokens",
      "refusal",
    ]);
  });

  test("rejects a reason the schema does not know", () => {
    expect(AgentTurnStopReasonSchema.safeParse("gave_up").success).toBe(false);
  });

  test("the wire schema accepts the same reasons", () => {
    // The payload schema and the reason type have to stay one thing: a reason
    // the type allows but the wire schema rejects would turn a turn's stop
    // reason into a dropped event.
    for (const reason of AgentTurnStopReasonSchema.options) {
      const parsed = AgentStreamEventPayloadSchema.safeParse({
        type: "turn_completed",
        provider: "claude",
        stopReason: reason,
      });
      expect(parsed.success).toBe(true);
    }
  });
});
