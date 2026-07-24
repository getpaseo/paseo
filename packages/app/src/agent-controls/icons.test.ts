import { describe, expect, it, vi } from "vitest";
import {
  Bot,
  Brain,
  ListTodo,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldOff,
  ShieldPlus,
  ShieldQuestionMark,
  Zap,
} from "lucide-react-native";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import { getAgentFeatureIcon, getAgentModeIcon, PlanModeIcon, ThinkingIcon } from "./icons";

vi.mock("lucide-react-native", () => ({
  Bot: function MockBot() {
    return null;
  },
  Brain: function MockBrain() {
    return null;
  },
  ListTodo: function MockListTodo() {
    return null;
  },
  Settings2: function MockSettings2() {
    return null;
  },
  Shield: function MockShield() {
    return null;
  },
  ShieldAlert: function MockShieldAlert() {
    return null;
  },
  ShieldCheck: function MockShieldCheck() {
    return null;
  },
  ShieldEllipsis: function MockShieldEllipsis() {
    return null;
  },
  ShieldOff: function MockShieldOff() {
    return null;
  },
  ShieldPlus: function MockShieldPlus() {
    return null;
  },
  ShieldQuestionMark: function MockShieldQuestionMark() {
    return null;
  },
  Zap: function MockZap() {
    return null;
  },
}));

const MODE_ICONS = {
  Bot,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldOff,
  ShieldPlus,
  ShieldQuestionMark,
} as const;

const PROVIDER_DEFINITIONS: AgentProviderDefinition[] = [
  {
    id: "test",
    label: "Test",
    description: "",
    defaultModeId: "Bot",
    modes: [
      ...Object.keys(MODE_ICONS).map((icon) => ({
        id: icon,
        label: icon,
        description: "",
        icon,
        colorTier: "safe" as const,
      })),
      {
        id: "custom",
        label: "Custom",
        description: "",
        icon: "FutureIcon",
        colorTier: "moderate",
      },
    ],
  },
];

describe("agent-control icons", () => {
  it("defines semantic control icons in one place", () => {
    expect(ThinkingIcon).toBe(Brain);
    expect(PlanModeIcon).toBe(ListTodo);
  });

  it("maps known mode and feature icons", () => {
    for (const [name, icon] of Object.entries(MODE_ICONS)) {
      expect(getAgentModeIcon("test", name, PROVIDER_DEFINITIONS)).toBe(icon);
    }
    expect(getAgentFeatureIcon("list-todo")).toBe(ListTodo);
    expect(getAgentFeatureIcon("shield-check")).toBe(ShieldCheck);
    expect(getAgentFeatureIcon("zap")).toBe(Zap);
  });

  it("uses stable fallbacks for unknown mode and feature icons", () => {
    expect(getAgentModeIcon("test", "custom", PROVIDER_DEFINITIONS)).toBe(Bot);
    expect(getAgentModeIcon("test", "missing", PROVIDER_DEFINITIONS)).toBe(Bot);
    expect(getAgentFeatureIcon("future-icon")).toBe(Settings2);
    expect(getAgentFeatureIcon()).toBe(Settings2);
  });
});
