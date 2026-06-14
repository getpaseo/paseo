import { describe, expect, it } from "vitest";
import { TERMINAL_ACTIVITY_STATES, TerminalActivitySchema } from "./terminal-activity.js";

describe("TerminalActivitySchema", () => {
  it("parses the known activity states", () => {
    for (const state of TERMINAL_ACTIVITY_STATES) {
      expect(TerminalActivitySchema.parse({ state, changedAt: 1 }).state).toBe(state);
    }
  });

  // Protocol forward-compat: a newer daemon may report a state this client predates.
  // The old client must still parse the payload (degrading to idle) rather than
  // rejecting the whole message on a strict enum.
  it("degrades an unknown future state to idle while keeping the rest of the payload", () => {
    const parsed = TerminalActivitySchema.parse({ state: "compacting", changedAt: 1718000000000 });
    expect(parsed.state).toBe("idle");
    expect(parsed.changedAt).toBe(1718000000000);
  });
});
