import { describe, expect, it } from "vitest";
import type { AgentMode } from "@getpaseo/protocol/agent-types";
import {
  isPlanModeActive,
  isPlanningAgentMode,
  resolveNonPlanningModeId,
  resolvePlanModeTarget,
} from "./policy";

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

describe("isPlanModeActive", () => {
  const modes = [{ id: "plan", label: "Plan", colorTier: "planning" }] satisfies AgentMode[];

  it("prefers the plan toggle when the provider exposes it", () => {
    expect(
      isPlanModeActive({
        features: [{ id: "plan_mode", label: "Plan", type: "toggle", value: false }],
        modes,
        selectedModeId: "plan",
      }),
    ).toBe(false);
  });

  it("falls back to the selected planning mode", () => {
    expect(isPlanModeActive({ modes, selectedModeId: "plan" })).toBe(true);
    expect(isPlanModeActive({ modes, selectedModeId: "missing" })).toBe(false);
  });
});

describe("resolvePlanModeTarget", () => {
  it("returns to Full access when leaving Plan without an explicit target", () => {
    expect(
      resolvePlanModeTarget(
        [
          { id: "ask", label: "Ask" },
          { id: "plan", label: "Plan" },
          { id: "full", label: "Full", isUnattended: true },
        ],
        "plan",
      ),
    ).toBe("full");
  });

  const modes = [
    { id: "default", label: "Default", colorTier: "safe" },
    { id: "plan", label: "Plan", colorTier: "planning" },
  ] satisfies AgentMode[];

  it("switches only between the planning mode and a non-planning mode", () => {
    expect(resolvePlanModeTarget(modes, "default")).toBe("plan");
    expect(resolvePlanModeTarget(modes, "plan")).toBe("default");
  });
});
