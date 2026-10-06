import { describe, expect, it } from "vitest";
import type { AgentFeature, AgentMode } from "@getpaseo/protocol/agent-types";
import {
  findPlanModeToggle,
  isPlanningAgentMode,
  resolveAccessModeOptions,
  resolveNonPlanningModeId,
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

describe("findPlanModeToggle", () => {
  it("returns the plan_mode toggle and ignores everything else", () => {
    const plan = {
      type: "toggle",
      id: "plan_mode",
      label: "Plan",
      value: true,
    } satisfies AgentFeature;
    const fast = {
      type: "toggle",
      id: "fast_mode",
      label: "Fast",
      value: false,
    } satisfies AgentFeature;

    expect(findPlanModeToggle([fast, plan])).toBe(plan);
    expect(findPlanModeToggle([fast])).toBeNull();
    expect(findPlanModeToggle(undefined)).toBeNull();
  });
});

describe("resolveAccessModeOptions", () => {
  const claudeModes = [
    { id: "plan", label: "Plan Mode", colorTier: "planning" },
    { id: "default", label: "Always Ask", colorTier: "safe" },
    { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
  ] satisfies AgentMode[];

  it("leaves the planning mode out of the access choices when Plan is a toggle", () => {
    expect(resolveAccessModeOptions(claudeModes, true, "bypassPermissions")).toEqual([
      claudeModes[1],
      claudeModes[2],
    ]);
  });

  it("keeps a planning mode that is still the selection, such as a saved draft", () => {
    expect(resolveAccessModeOptions(claudeModes, true, "plan")).toEqual(claudeModes);
  });

  it("keeps every mode for providers whose Plan is a mode", () => {
    expect(resolveAccessModeOptions(claudeModes, false, "bypassPermissions")).toEqual(claudeModes);
  });
});
