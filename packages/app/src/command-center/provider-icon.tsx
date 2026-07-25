import { withUnistyles } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { getProviderIcon } from "@/components/provider-icons";
import type { CommandCenterIcon, CommandCenterIconProps } from "./contributions";

const commandCenterProviderIcons = new Map<AgentProvider, CommandCenterIcon>();

export function getCommandCenterProviderIcon(provider: AgentProvider): CommandCenterIcon {
  const cached = commandCenterProviderIcons.get(provider);
  if (cached) return cached;

  const ProviderIcon = withUnistyles(getProviderIcon(provider), (theme) => ({
    color: theme.colors.foregroundMuted,
  }));
  function CommandCenterProviderIcon({ size }: CommandCenterIconProps) {
    return <ProviderIcon size={size} />;
  }
  commandCenterProviderIcons.set(provider, CommandCenterProviderIcon);
  return CommandCenterProviderIcon;
}
