import { describe, expect, it } from "vitest";
import { supportsAgentProfiles } from "./capabilities";

describe("agent profile capabilities", () => {
  it("requires storage and live config application support", () => {
    expect(supportsAgentProfiles(undefined)).toBe(false);
    expect(supportsAgentProfiles({ agentProfiles: true })).toBe(false);
    expect(supportsAgentProfiles({ agentConfigApply: true })).toBe(false);
    expect(supportsAgentProfiles({ agentProfiles: true, agentConfigApply: true })).toBe(true);
  });
});
