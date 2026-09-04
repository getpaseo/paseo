import { expect, test } from "vitest";

import { AgentRunState } from "./agent-run-state.js";

test("createPendingRun refuses to replace an existing run", () => {
  const state = new AgentRunState();
  const first = state.createPendingRun("agent-1");

  expect(() => state.createPendingRun("agent-1")).toThrow(
    "Agent agent-1 already has an active run",
  );
  expect(state.getPendingRun("agent-1")).toBe(first);
});
