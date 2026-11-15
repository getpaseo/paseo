import { describe, expect, it } from "vitest";
import { resolveModelAndEffort, supportsEffort } from "./catalog.js";

describe("supportsEffort", () => {
  it.each(["gemini-3.8-flash-high", "gemini-4-argon-low", "gemini-4-argon", "gemini-3.8-flash"])(
    "accepts effort for %s",
    (id) => expect(supportsEffort(id)).toBe(true),
  );
  it.each([
    "gemini-pro-orchestrator",
    "gemini-pro-orchestrator-argon",
    "gemini-4-hydrogen-xhigh",
    "gemini-3.1-pro-preview",
    "claude-opus-4-6-thinking",
  ])("rejects effort for %s", (id) => expect(supportsEffort(id)).toBe(false));
});

describe("resolveModelAndEffort", () => {
  it("drops effort for the orchestrator", () => {
    expect(resolveModelAndEffort("gemini-pro-orchestrator", "high")).toEqual({
      model: "gemini-pro-orchestrator",
    });
  });
});
