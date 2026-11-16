import { describe, expect, it } from "vitest";
import { shouldConfirmTerminalClose } from "./terminal-close-policy";

describe("shouldConfirmTerminalClose", () => {
  it("does not confirm an idle or unknown terminal", () => {
    expect(shouldConfirmTerminalClose(null)).toBe(false);
    expect(shouldConfirmTerminalClose({ state: "idle", changedAt: 1 })).toBe(false);
  });

  it("confirms a terminal with active work or pending input", () => {
    expect(shouldConfirmTerminalClose({ state: "working", changedAt: 1 })).toBe(true);
    expect(
      shouldConfirmTerminalClose({ state: "idle", attentionReason: "needs_input", changedAt: 1 }),
    ).toBe(true);
  });

  it("does not confirm finished attention", () => {
    expect(
      shouldConfirmTerminalClose({ state: "idle", attentionReason: "finished", changedAt: 1 }),
    ).toBe(false);
  });
});
