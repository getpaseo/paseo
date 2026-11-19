import { Settings2 } from "lucide-react-native";
import { describe, expect, it } from "vitest";
import { getAgentFeatureIcon } from "./icons";

describe("getAgentFeatureIcon", () => {
  it("draws the Lucide icon a plugin provider names", () => {
    const icon = getAgentFeatureIcon("Mic");
    expect(icon).not.toBe(Settings2);
    expect(getAgentFeatureIcon("Mic")).toBe(icon);
  });

  it("falls back to the generic icon for a missing or unknown name", () => {
    expect(getAgentFeatureIcon()).toBe(Settings2);
    expect(getAgentFeatureIcon("not-an-icon")).toBe(Settings2);
  });
});
