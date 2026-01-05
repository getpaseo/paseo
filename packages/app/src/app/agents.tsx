import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { AgentList } from "@/components/agent-list";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";

export default function AgentsScreen() {
  const { agents, isRevalidating, refreshAll } = useAggregatedAgents();

  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => {
      if (a.requiresAttention && !b.requiresAttention) return -1;
      if (!a.requiresAttention && b.requiresAttention) return 1;
      return 0;
    });
  }, [agents]);

  return (
    <View style={styles.container}>
      <BackHeader title="All Agents" />
      <AgentList
        agents={sortedAgents}
        isRefreshing={isRevalidating}
        onRefresh={refreshAll}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
}));
