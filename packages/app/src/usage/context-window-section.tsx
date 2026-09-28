import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { UsageCard } from "./card";
import { useUsagePreferences } from "./display";
import { useAgentUsage } from "./queries";

/** The active agent's usage inside its context-window tooltip. */
export function ContextWindowUsageTooltip({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}) {
  const { entry } = useAgentUsage(serverId, agentId);
  const { display } = useUsagePreferences();
  if (!entry) return null;

  return (
    <>
      <View style={styles.divider} />
      <UsageCard serverId={serverId} entry={entry} display={display} compact />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  divider: {
    height: 1,
    backgroundColor: theme.colors.borderAccent,
    marginVertical: theme.spacing[2],
    marginHorizontal: -theme.spacing[2],
  },
}));
