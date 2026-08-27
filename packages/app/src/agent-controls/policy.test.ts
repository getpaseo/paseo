import { describe, expect, it } from "vitest";
import type { AgentMode } from "@getpaseo/protocol/agent-types";
import { isPlanningAgentMode, resolveNonPlanningModeId } from "./policy";

describe("isPlanningAgentMode", () => {
  it("prefers planning metadata and recognizes existing provider ids", () => {
    expect(isPlanningAgentMode({ id: "research", colorTier: "planning" })).toBe(true);
    expect(isPlanningAgentMode({ id: "plan" })).toBe(true);
    expect(
      isPlanningAgentMode({
        id: "https://agentclientprotocol.com/protocol/session-modes#plan",
      }),
    ).toBe(true);
    expect(isPlanningAgentMode({ id: "default", colorTier: "safe" })).toBe(false);
  });
});

describe("resolveNonPlanningModeId", () => {
  const modes = [
    { id: "plan", label: "Plan", colorTier: "planning" },
    { id: "default", label: "Default", colorTier: "safe" },
    { id: "full", label: "Full", colorTier: "dangerous" },
  ] satisfies AgentMode[];

  it("uses a non-planning provider default", () => {
    expect(resolveNonPlanningModeId(modes, "full")).toBe("full");
  });

  it("does not use a planning or stale provider default", () => {
    expect(resolveNonPlanningModeId(modes, "plan")).toBe("default");
    expect(resolveNonPlanningModeId(modes, "deleted")).toBe("default");
  });

  it("returns null when no non-planning mode exists", () => {
    expect(resolveNonPlanningModeId([modes[0]], "plan")).toBeNull();
  });
});
