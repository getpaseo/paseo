import { describe, expect, it } from "vitest";
import { Settings2, Zap, Bell, ListTodo, ShieldCheck } from "lucide-react-native";
import { getAgentFeatureIcon } from "./icons";

describe("getAgentFeatureIcon", () => {
  it("resolves the legacy feature icon names", () => {
    expect(getAgentFeatureIcon("zap")).toBe(Zap);
    expect(getAgentFeatureIcon("list-todo")).toBe(ListTodo);
    expect(getAgentFeatureIcon("shield-check")).toBe(ShieldCheck);
  });

  it("resolves PascalCase and kebab-case Lucide names", () => {
    expect(getAgentFeatureIcon("Bell")).toBe(Bell);
    expect(getAgentFeatureIcon("bell")).toBe(Bell);
  });

  it("falls back to Settings2 for unknown names and non-icon exports", () => {
    expect(getAgentFeatureIcon(undefined)).toBe(Settings2);
    expect(getAgentFeatureIcon("not-a-real-icon")).toBe(Settings2);
    expect(getAgentFeatureIcon("Icon")).toBe(Settings2);
    expect(getAgentFeatureIcon("createLucideIcon")).toBe(Settings2);
    expect(getAgentFeatureIcon("LucideProvider")).toBe(Settings2);
    expect(getAgentFeatureIcon("useLucideContext")).toBe(Settings2);
  });
});
