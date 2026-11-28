import { describe, expect, it } from "vitest";
import { AGENT_SHEET_HOME, resolveAgentSheetEscape } from "./model-sheet-flow";

describe("agent settings sheet Escape", () => {
  it("clears a search before it leaves the page", () => {
    expect(resolveAgentSheetEscape({ page: { kind: "model" }, query: "opus" })).toBe("clearQuery");
  });

  it("returns from a page to home", () => {
    expect(resolveAgentSheetEscape({ page: { kind: "model" }, query: "" })).toBe("home");
    expect(
      resolveAgentSheetEscape({ page: { kind: "select", controlId: "feature-branch" }, query: "" }),
    ).toBe("home");
  });

  it("closes the sheet from home", () => {
    expect(resolveAgentSheetEscape({ page: AGENT_SHEET_HOME, query: "" })).toBe("close");
  });
});
