import { describe, expect, test } from "vitest";
import { getAgentProviderDefinition } from "../provider-manifest.js";

// Hubcode-side regression coverage for the OpenCode "full-access" synthetic
// mode. The mode does not exist server-side in OpenCode itself; Hubcode
// auto-approves tool permission prompts when this mode is selected. We verify
// here that the mode is wired into the provider manifest with the expected
// dangerous-tier visuals so the client renders the correct affordance.
describe("OpenCode full-access mode wiring", () => {
  test("provider manifest exposes full-access mode with dangerous tier", () => {
    const definition = getAgentProviderDefinition("opencode");
    const fullAccess = definition.modes.find((mode) => mode.id === "full-access");

    expect(fullAccess).toBeDefined();
    expect(fullAccess?.label).toBe("Full Access");
    expect(fullAccess?.icon).toBe("ShieldAlert");
    expect(fullAccess?.colorTier).toBe("dangerous");
  });

  test("provider manifest preserves build and plan modes", () => {
    const definition = getAgentProviderDefinition("opencode");
    const ids = definition.modes.map((mode) => mode.id);
    expect(ids).toEqual(expect.arrayContaining(["build", "plan", "full-access"]));
    expect(definition.defaultModeId).toBe("build");
  });
});
