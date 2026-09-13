import { describe, expect, test } from "vitest";

import { AgentRunState } from "./agent-run-state.js";

describe("AgentRunState", () => {
  test("does not settle an identified autonomous run from an unbound terminal", () => {
    const state = new AgentRunState();
    state.trackAutonomousRun("agent-1", "turn-1");

    state.settleTerminalRun("agent-1", undefined);

    expect(state.hasRun("agent-1")).toBe(true);

    state.settleTerminalRun("agent-1", "turn-1");

    expect(state.hasRun("agent-1")).toBe(false);
  });
});
