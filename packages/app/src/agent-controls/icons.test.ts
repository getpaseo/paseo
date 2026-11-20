import { describe, expect, it, vi } from "vitest";

vi.mock("lucide-react-native", () => ({
  Bot: () => null,
  Brain: () => null,
  ListTodo: () => null,
  Settings2: () => null,
  Shield: () => null,
  ShieldAlert: () => null,
  ShieldCheck: () => null,
  ShieldEllipsis: () => null,
  ShieldOff: () => null,
  ShieldPlus: () => null,
  ShieldQuestionMark: () => null,
  Zap: () => null,
}));

vi.mock("@/plugins/icons", () => ({
  isLucideIconName: () => false,
  pluginIconComponent: () => () => null,
}));

const { Bot, Shield } = await import("lucide-react-native");
const { getAgentModeOptionIcon } = await import("./icons");

describe("getAgentModeOptionIcon", () => {
  it("falls back to the trigger's default instead of leaving the row empty", () => {
    expect(getAgentModeOptionIcon("opencode", "navigator", [])).toBe(Bot);
  });

  it("uses the definition's icon when the provider names one", () => {
    const definitions = [
      {
        id: "opencode",
        modes: [{ id: "build", icon: "Shield" }],
      },
    ] as never;

    expect(getAgentModeOptionIcon("opencode", "build", definitions)).toBe(Shield);
  });
});
