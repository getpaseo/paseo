import { createElement, useMemo, type ComponentType } from "react";
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
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
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
  // Accept PascalCase export names ("Bell") and kebab-case ("bell",
  // "shield-check"): try the name as given, then its PascalCase form.
  const candidates = [...new Set([name, toPascalCase(name)])];
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

const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface ThemedAgentControlIconProps {
  icon: AgentControlIcon;
  size: number;
  active: boolean;
}

/** Theme-colored icon for places that render an icon directly (not via a trigger). */
export function ThemedAgentControlIcon({ icon: Icon, size, active }: ThemedAgentControlIconProps) {
  const ThemedIcon = useMemo(() => withUnistyles(Icon), [Icon]);
  return createElement(ThemedIcon, {
    size,
    uniProps: active ? foregroundIconMapping : mutedIconMapping,
  });
}

/**
 * Wrap an icon so its color comes from the theme through `withUnistyles`
 * instead of a `useUnistyles()` read in the parent. The wrapper ignores the
 * `color` prop callers pass; `active` picks foreground over muted.
 * Memoize the result at the call site so the component identity is stable.
 */
export function themedAgentControlIcon(Icon: AgentControlIcon, active: boolean): AgentControlIcon {
  const ThemedIcon = withUnistyles(Icon);
  return function WrappedAgentControlIcon({ size }: AgentControlIconProps) {
    return createElement(ThemedIcon, {
      size,
      uniProps: active ? foregroundIconMapping : mutedIconMapping,
    });
  };
}
