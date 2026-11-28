import { describe, expect, it } from "vitest";
import { isTimelineTurnTrigger } from "./timeline-turn.js";

describe("timeline turn triggers", () => {
  it.each([
    "heartbeat",
    "agent_message",
    "agent_finished",
    "agent_errored",
    "agent_needs_permission",
    "agent_closed",
    "agent_still_working",
  ])("a delivered %s prompt starts a turn", (name) => {
    expect(isTimelineTurnTrigger({ type: "tool_call", name })).toBe(true);
  });

  it("an ordinary tool call stays inside its turn", () => {
    expect(isTimelineTurnTrigger({ type: "tool_call", name: "Bash" })).toBe(false);
    expect(isTimelineTurnTrigger({ type: "user_message" })).toBe(true);
  });
});
