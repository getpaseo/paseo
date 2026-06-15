import { describe, expect, it } from "vitest";
import {
  TERMINAL_ACTIVITY_ATTENTION_REASONS,
  TERMINAL_ACTIVITY_STATES,
  TerminalActivitySchema,
  deriveTerminalActivityStatusBucket,
} from "./terminal-activity.js";

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

  it("parses known attention reasons", () => {
    for (const attentionReason of TERMINAL_ACTIVITY_ATTENTION_REASONS) {
      expect(
        TerminalActivitySchema.parse({ state: "attention", attentionReason, changedAt: 1 })
          .attentionReason,
      ).toBe(attentionReason);
    }
  });

  it("maps terminal activity to workspace status buckets", () => {
    expect(deriveTerminalActivityStatusBucket({ state: "working", changedAt: 1 })).toBe("running");
    expect(
      deriveTerminalActivityStatusBucket({
        state: "idle",
        attentionReason: "finished",
        changedAt: 1,
      }),
    ).toBe("attention");
    expect(
      deriveTerminalActivityStatusBucket({
        state: "idle",
        attentionReason: "needs_input",
        changedAt: 1,
      }),
    ).toBe("needs_input");
    expect(deriveTerminalActivityStatusBucket({ state: "idle", changedAt: 1 })).toBeNull();
  });
});
