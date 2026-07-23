import { withUnistyles } from "react-native-unistyles";
import type { AgentControlIcon } from "@/composer/agent-controls/icons";
import type { CommandCenterIcon, CommandCenterIconProps } from "./contributions";

const commandCenterIcons = new Map<AgentControlIcon, CommandCenterIcon>();

export function getCommandCenterIcon(Component: AgentControlIcon): CommandCenterIcon {
  const cached = commandCenterIcons.get(Component);
  if (cached) return cached;

  const ThemedIcon = withUnistyles(Component, (theme) => ({
    color: theme.colors.foregroundMuted,
  }));
  function CommandCenterIconAdapter({ size }: CommandCenterIconProps) {
    return <ThemedIcon size={size} />;
  }
  commandCenterIcons.set(Component, CommandCenterIconAdapter);
  return CommandCenterIconAdapter;
}
