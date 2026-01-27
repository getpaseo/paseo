import { useMemo, useState, useCallback, useEffect } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { AgentList } from "@/components/agent-list";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";

export default function AgentsScreen() {
  const { agents, isRevalidating, refreshAll } = useAggregatedAgents();

  // Track user-initiated refresh to avoid showing spinner on background revalidation
  const [isManualRefresh, setIsManualRefresh] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    refreshAll();
  }, [refreshAll]);

  // Reset manual refresh flag when revalidation completes
  useEffect(() => {
    if (!isRevalidating && isManualRefresh) {
      setIsManualRefresh(false);
    }
  }, [isRevalidating, isManualRefresh]);

  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => {
      if (a.requiresAttention && !b.requiresAttention) return -1;
      if (!a.requiresAttention && b.requiresAttention) return 1;
      return 0;
    });
  }, [agents]);

  return (
    <View style={styles.container}>
      <BackHeader title="All agents" />
      <AgentList
        agents={sortedAgents}
        isRefreshing={isManualRefresh && isRevalidating}
        onRefresh={handleRefresh}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
}));
