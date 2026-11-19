import { describe, expect, it } from "vitest";
import { getThinkingOptionsForModel, resolveModelAndEffort, supportsEffort } from "./catalog.js";

describe("supportsEffort", () => {
  it.each([
    "gemini-3.8-flash-high",
    "gemini-4-argon-low",
    "gemini-4-hydrogen-xhigh",
    "gemini-4-argon",
    "gemini-4-carbon",
    "gemini-4-hydrogen",
    "gemini-3.8-flash",
  ])("accepts effort for %s", (id) => expect(supportsEffort(id)).toBe(true));
  it.each([
    "gemini-pro-orchestrator",
    "gemini-pro-orchestrator-argon",
    "gemini-3.1-pro-preview",
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
    "gpt-oss-120b-medium",
  ])("rejects effort for %s", (id) => expect(supportsEffort(id)).toBe(false));
});

describe("getThinkingOptionsForModel", () => {
  it("returns empty options for orchestrator and non-effort models", () => {
    expect(getThinkingOptionsForModel("gemini-pro-orchestrator")).toEqual([]);
    expect(getThinkingOptionsForModel("gemini-pro-orchestrator-argon")).toEqual([]);
    expect(getThinkingOptionsForModel("claude-opus-4-6-thinking")).toEqual([]);
  });

  it("includes xhigh for gemini-4-hydrogen models", () => {
    expect(getThinkingOptionsForModel("gemini-4-hydrogen-high").map((o) => o.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
});

describe("resolveModelAndEffort", () => {
  it("drops effort for the orchestrator models", () => {
    expect(resolveModelAndEffort("gemini-pro-orchestrator", "high")).toEqual({
      model: "gemini-pro-orchestrator",
    });
    expect(resolveModelAndEffort("gemini-pro-orchestrator-argon", "medium")).toEqual({
      model: "gemini-pro-orchestrator-argon",
    });
  });

  it("strips suffix and forwards effort for supported gemini models including xhigh", () => {
    expect(resolveModelAndEffort("gemini-4-hydrogen-xhigh", "high")).toEqual({
      model: "gemini-4-hydrogen",
      effort: "high",
    });
    expect(resolveModelAndEffort("gemini-4-hydrogen-high", "xhigh")).toEqual({
      model: "gemini-4-hydrogen",
      effort: "xhigh",
    });
  });
});
