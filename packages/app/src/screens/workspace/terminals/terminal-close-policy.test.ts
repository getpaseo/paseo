import { describe, expect, it } from "vitest";
import { shouldConfirmTerminalClose } from "./terminal-close-policy";

describe("shouldConfirmTerminalClose", () => {
  it("does not confirm an idle or unknown terminal", () => {
    expect(shouldConfirmTerminalClose(false)).toBe(false);
  });

  it("confirms a terminal with active work or pending input", () => {
    expect(shouldConfirmTerminalClose(true)).toBe(true);
  });

  it("does not confirm when command state is unavailable", () => {
    expect(shouldConfirmTerminalClose(undefined)).toBe(false);
  });
});
