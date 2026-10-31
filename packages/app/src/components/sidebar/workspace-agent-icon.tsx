import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useProviderIcon } from "@/components/provider-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { formatWorkspaceAgentLabel } from "./workspace-agent-label";
import type { Theme } from "@/styles/theme";

const AGENT_ICON_SIZE = 14;

const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// The icon component depends on the provider, so the theme color goes in through a wrapper
// rather than a Themed* constant — same shape as terminal-profile-icon.tsx.
function ProviderIcon({
  provider,
  serverId,
  size,
  color = "",
}: {
  provider: string;
  serverId: string;
  size: number;
  color?: string;
}) {
  const Icon = useProviderIcon(provider, serverId);
  return <Icon size={size} color={color} />;
}

const ThemedProviderIcon = withUnistyles(ProviderIcon);

// Mounted only while the tooltip is open, so rows don't each subscribe to the providers snapshot.
function WorkspaceAgentLabel({
  provider,
  model,
  serverId,
}: {
  provider: string;
  model: string | null;
  serverId: string;
}) {
  const { entries } = useProvidersSnapshot(serverId);
  return (
    <Text style={styles.tooltipText}>{formatWorkspaceAgentLabel(provider, model, entries)}</Text>
  );
}

/**
 * The provider of the agent behind the row's status dot, as the same mark its tab carries.
 *
 * It sits on the title line, beside the trailing time, rather than on the meta line: a row with
 * no other meta item would otherwise grow a second line when the agent list arrives after the
 * workspace list. Here it only narrows the title, and the row keeps its height.
 *
 * Only the glyph: the provider name would repeat on every row of a single-provider sidebar. The
 * provider and model show in a desktop tooltip.
 */
export function WorkspaceAgentIcon({
  provider,
  model,
  serverId,
}: {
  provider: string;
  model: string | null;
  serverId: string;
}) {
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      {/* A plain View, not a Pressable: a click on the icon still opens the workspace row. */}
      <TooltipTrigger asChild>
        <View
          style={styles.slot}
          accessibilityLabel={model ? `${provider} ${model}` : provider}
          testID={`sidebar-workspace-agent-${provider}`}
        >
          <ThemedProviderIcon
            provider={provider}
            serverId={serverId}
            size={AGENT_ICON_SIZE}
            uniProps={mutedMapping}
          />
        </View>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={6} testID="sidebar-workspace-agent-tooltip">
        <WorkspaceAgentLabel provider={provider} model={model} serverId={serverId} />
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Centers the glyph on the title's line box so it reads level with the text, not its top.
  slot: {
    height: 20,
    justifyContent: "center",
    flexShrink: 0,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
