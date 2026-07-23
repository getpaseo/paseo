import { describe, expect, it, vi } from "vitest";
import { Bot, Settings2, Shield, Zap } from "lucide-react-native";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import { getCommandCenterIcon } from "@/command-center/icon";
import { getAgentFeatureIcon, getAgentModeIcon } from "./icons";

vi.mock("lucide-react-native", () => ({
  Bot: function MockBot() {
    return null;
  },
  ListTodo: function ListTodo() {
    return null;
  },
  Settings2: function MockSettings2() {
    return null;
  },
  Shield: function MockShield() {
    return null;
  },
  ShieldAlert: function ShieldAlert() {
    return null;
  },
  ShieldCheck: function ShieldCheck() {
    return null;
  },
  ShieldEllipsis: function ShieldEllipsis() {
    return null;
  },
  ShieldOff: function ShieldOff() {
    return null;
  },
  ShieldPlus: function ShieldPlus() {
    return null;
  },
  ShieldQuestionMark: function ShieldQuestionMark() {
    return null;
  },
  Zap: function MockZap() {
    return null;
  },
}));

const PROVIDER_DEFINITIONS: AgentProviderDefinition[] = [
  {
    id: "test",
    label: "Test",
    description: "",
    defaultModeId: "known",
    modes: [
      {
        id: "known",
        label: "Known",
        description: "",
        icon: "Shield",
        colorTier: "safe",
      },
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
  it("shares known mode and feature icons", () => {
    expect(getAgentModeIcon("test", "known", PROVIDER_DEFINITIONS)).toBe(Shield);
    expect(getAgentFeatureIcon("zap")).toBe(Zap);
  });

  it("uses stable fallbacks for unknown mode and feature icons", () => {
    expect(getAgentModeIcon("test", "custom", PROVIDER_DEFINITIONS)).toBe(Bot);
    expect(getAgentModeIcon("test", "missing", PROVIDER_DEFINITIONS)).toBe(Bot);
    expect(getAgentFeatureIcon("future-icon")).toBe(Settings2);
    expect(getAgentFeatureIcon()).toBe(Settings2);
  });

  it("caches the muted Command Center adapter by raw icon component", () => {
    expect(getCommandCenterIcon(Bot)).toBe(getCommandCenterIcon(Bot));
    expect(getCommandCenterIcon(Bot)).not.toBe(getCommandCenterIcon(Shield));
  });
});
