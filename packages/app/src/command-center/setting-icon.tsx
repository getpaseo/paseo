import type { ComponentType } from "react";
import { withUnistyles } from "react-native-unistyles";
import {
  Bot,
  Brain,
  ListTodo,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldOff,
  ShieldPlus,
  ShieldQuestionMark,
  Zap,
} from "lucide-react-native";
import { getModeVisuals, type AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type { CommandCenterIcon, CommandCenterIconProps } from "./contributions";

type LucideComponent = ComponentType<{ size?: number; color?: string }>;

// Mirrors MODE_ICONS in composer/agent-controls/mode-control.tsx so mode rows in
// the Command Center use the same iconography as the composer's mode chip.
const LUCIDE_BY_NAME: Record<string, LucideComponent> = {
  Bot,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldOff,
  ShieldPlus,
  ShieldQuestionMark,
};

const iconCache = new Map<LucideComponent, CommandCenterIcon>();

/**
 * Wraps a lucide component into a muted {@link CommandCenterIcon}, mirroring
 * `getCommandCenterProviderIcon` in `provider-icon.tsx`. Cached by component so a
 * given icon resolves to a stable element type across renders.
 */
export function getCommandCenterLucideIcon(Component: LucideComponent): CommandCenterIcon {
  const cached = iconCache.get(Component);
  if (cached) return cached;

  const ThemedIcon = withUnistyles(Component, (theme) => ({
    color: theme.colors.foregroundMuted,
  }));
  function CommandCenterLucideIcon({ size }: CommandCenterIconProps) {
    return <ThemedIcon size={size} />;
  }
  iconCache.set(Component, CommandCenterLucideIcon);
  return CommandCenterLucideIcon;
}

export const CommandCenterThinkingIcon = getCommandCenterLucideIcon(Brain);
export const CommandCenterPlanModeIcon = getCommandCenterLucideIcon(ListTodo);
export const CommandCenterFastModeIcon = getCommandCenterLucideIcon(Zap);

/** Resolves the per-mode Shield* icon via the provider manifest, falling back to Bot. */
export function getCommandCenterModeIcon(
  provider: string,
  modeId: string,
  providerDefinitions: AgentProviderDefinition[],
): CommandCenterIcon {
  const visuals = getModeVisuals(provider, modeId, providerDefinitions);
  const Component = (visuals?.icon ? LUCIDE_BY_NAME[visuals.icon] : undefined) ?? Bot;
  return getCommandCenterLucideIcon(Component);
}
