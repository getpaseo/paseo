import { describe, expect, it } from "vitest";
import { shouldConfirmTerminalClose } from "./terminal-close-policy";

describe("shouldConfirmTerminalClose", () => {
  it("does not confirm an idle or unknown terminal", () => {
    expect(shouldConfirmTerminalClose(false, true)).toBe(false);
  });

  it("confirms a terminal with active work or pending input", () => {
    expect(shouldConfirmTerminalClose(true, true)).toBe(true);
  });

  it("confirms when command state is unavailable", () => {
    expect(shouldConfirmTerminalClose(undefined, true)).toBe(false);
    expect(shouldConfirmTerminalClose(undefined, false)).toBe(true);
  });
});
