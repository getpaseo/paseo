import type { ComponentType } from "react";
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
import { isLucideIconName, pluginIconComponent } from "@/plugins/icons";
import { getModeVisuals, type AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";

export interface AgentControlIconProps {
  size: number;
  color: string;
}

export type AgentControlIcon = ComponentType<AgentControlIconProps>;

export const ThinkingIcon = Brain;
export const PlanModeIcon = ListTodo;

const MODE_ICONS: Record<string, AgentControlIcon> = {
  Bot,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldOff,
  ShieldPlus,
  ShieldQuestionMark,
};

const FEATURE_ICONS: Record<string, AgentControlIcon> = {
  "list-todo": ListTodo,
  "shield-check": ShieldCheck,
  zap: Zap,
};

export function getAgentModeIcon(
  provider: string,
  modeId: string,
  providerDefinitions: AgentProviderDefinition[],
): AgentControlIcon {
  const icon = getModeVisuals(provider, modeId, providerDefinitions)?.icon;
  return (icon ? MODE_ICONS[icon] : undefined) ?? Bot;
}

export function getAgentModeOptionIcon(
  provider: string,
  modeId: string,
  providerDefinitions: AgentProviderDefinition[],
): AgentControlIcon | undefined {
  const icon = getModeVisuals(provider, modeId, providerDefinitions)?.icon;
  return icon ? MODE_ICONS[icon] : undefined;
}

/** A built-in control names its icon in kebab case; a plugin provider names a Lucide icon. */
export function getAgentFeatureIcon(icon?: string): AgentControlIcon {
  if (!icon) return Settings2;
  if (FEATURE_ICONS[icon]) return FEATURE_ICONS[icon];
  return isLucideIconName(icon) ? pluginIconComponent(icon) : Settings2;
}
