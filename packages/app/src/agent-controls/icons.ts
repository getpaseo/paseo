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
import * as LucideIcons from "lucide-react-native";
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

// Module-level values that are not icon components. Rendering one of these
// as an icon would crash, so name resolution excludes them explicitly.
const NON_ICON_EXPORTS = new Set([
  "Icon",
  "createLucideIcon",
  "LucideProvider",
  "useLucideContext",
]);

function toPascalCase(name: string): string {
  return name
    .split("-")
    .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
    .join("");
}

function findLucideIcon(name: string): AgentControlIcon | undefined {
  if (NON_ICON_EXPORTS.has(name)) return undefined;
  // Accept PascalCase export names ("Bell") and kebab-case ("bell").
  const candidates = name.includes("-") ? [name, toPascalCase(name)] : [name];
  for (const candidate of candidates) {
    if (NON_ICON_EXPORTS.has(candidate)) continue;
    const resolved: unknown = Reflect.get(LucideIcons, candidate);
    const isComponent =
      typeof resolved === "function" ||
      (typeof resolved === "object" && resolved !== null && "$$typeof" in resolved);
    if (isComponent) return resolved as AgentControlIcon;
  }
  return undefined;
}

export function getAgentFeatureIcon(icon?: string): AgentControlIcon {
  if (icon) {
    const known = FEATURE_ICONS[icon];
    if (known) return known;
    // Provider plugins may name any icon in the app's lucide-react-native
    // set; fall back to the default only when the name resolves to nothing.
    const resolved = findLucideIcon(icon);
    if (resolved) return resolved;
  }
  return Settings2;
}
