import { useMemo, useState, useCallback, useEffect } from "react";
import { View, Text } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronLeft } from "lucide-react-native";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { AgentList } from "@/components/agent-list";
import { useAgentHistory } from "@/hooks/use-agent-history";
import { buildHostOpenProjectRoute } from "@/utils/host-routes";

export function SessionsScreen({ serverId }: { serverId: string }) {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <SessionsScreenContent serverId={serverId} />;
}

function SessionsScreenContent({ serverId }: { serverId: string }) {
  const { theme } = useUnistyles();
  const { agents, hasMore, isInitialLoad, isLoadingMore, isRevalidating, loadMore, refreshAll } =
    useAgentHistory({
      serverId,
    });

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
    return [...agents].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }, [agents]);

  return (
    <View style={styles.container}>
      <MenuHeader title="Sessions" />
      {isInitialLoad ? (
        <View style={styles.loadingContainer}>
          <LoadingSpinner size="large" color={theme.colors.foregroundMuted} />
        </View>
      ) : sortedAgents.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>No sessions yet</Text>
          <Button
            variant="ghost"
            leftIcon={ChevronLeft}
            onPress={() => router.navigate(buildHostOpenProjectRoute(serverId))}
          >
            Back
          </Button>
        </View>
      ) : (
        <AgentList
          agents={sortedAgents}
          showCheckoutInfo={false}
          isRefreshing={isManualRefresh && isRevalidating}
          onRefresh={handleRefresh}
          listFooterComponent={
            hasMore ? (
              <View style={styles.footer}>
                <Button variant="ghost" onPress={loadMore} disabled={isLoadingMore}>
                  {isLoadingMore ? "Loading..." : "Load more"}
                </Button>
              </View>
            ) : null
          }
          showAttentionIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[6],
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  footer: {
    alignItems: "center",
    paddingVertical: theme.spacing[4],
  },
}));
