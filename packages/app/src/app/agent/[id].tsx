import { useCallback, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { useSessionDirectory } from "@/hooks/use-session-directory";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import type { Agent } from "@/contexts/session-context";

type AgentMatch = {
  serverId: string;
  serverLabel: string;
  agent: Agent;
};

export default function LegacyAgentRedirectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { theme } = useUnistyles();
  const { connectionStates } = useDaemonConnections();
  const sessionDirectory = useSessionDirectory();
  const agentId = typeof id === "string" ? id.trim() : undefined;

  const matches = useMemo<AgentMatch[]>(() => {
    if (!agentId) {
      return [];
    }

    const results: AgentMatch[] = [];
    sessionDirectory.forEach((session, serverId) => {
      if (!session) {
        return;
      }
      const agent = session.agents.get(agentId);
      if (!agent) {
        return;
      }
      const serverLabel = connectionStates.get(serverId)?.daemon.label ?? serverId;
      results.push({ serverId, serverLabel, agent });
    });

    return results;
  }, [agentId, sessionDirectory, connectionStates]);

  const hasSessions = sessionDirectory.size > 0;
  const isRedirecting = Boolean(agentId && matches.length === 1);

  useEffect(() => {
    if (!isRedirecting) {
      return;
    }
    const match = matches[0];
    router.replace({
      pathname: "/agent/[serverId]/[agentId]",
      params: {
        serverId: match.serverId,
        agentId: match.agent.id,
      },
    });
  }, [isRedirecting, matches, router]);

  const handleGoHome = useCallback(() => {
    router.replace("/");
  }, [router]);

  const handleSelectMatch = useCallback(
    (match: AgentMatch) => {
      router.replace({
        pathname: "/agent/[serverId]/[agentId]",
        params: {
          serverId: match.serverId,
          agentId: match.agent.id,
        },
      });
    },
    [router]
  );

  let body: ReactNode = null;

  if (!agentId) {
    body = (
      <View style={styles.centerState}>
        <Text style={styles.title}>Missing agent</Text>
        <Text style={styles.subtitle}>
          This link is missing an agent id. Go back to the Agents screen to pick one.
        </Text>
        <Pressable style={styles.primaryButton} onPress={handleGoHome}>
          <Text style={styles.primaryButtonText}>Go Home</Text>
        </Pressable>
      </View>
    );
  } else if (!hasSessions || isRedirecting) {
    body = (
      <View style={styles.centerState}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
        <Text style={styles.subtitle}>
          {isRedirecting ? "Opening your agent..." : "Looking for your agent..."}
        </Text>
      </View>
    );
  } else if (matches.length === 0) {
      body = (
        <View style={styles.centerState}>
          <Text style={styles.title}>Agent not found</Text>
          <Text style={styles.subtitle}>
            We could not find {agentId} on any connected daemon. Make sure the daemon is online
            or reopen the agent from the Home screen after it reconnects.
          </Text>
          <Pressable style={styles.primaryButton} onPress={handleGoHome}>
            <Text style={styles.primaryButtonText}>Go Home</Text>
          </Pressable>
      </View>
    );
  } else if (matches.length > 1) {
    body = (
      <View style={styles.centerState}>
        <Text style={styles.title}>Pick a daemon</Text>
        <Text style={styles.subtitle}>
          Multiple daemons have an agent with this id. Choose the one you intended to open.
        </Text>
        <View style={styles.matchList}>
          {matches.map((match) => (
            <Pressable
              key={`${match.serverId}:${match.agent.id}`}
              style={styles.matchButton}
              onPress={() => handleSelectMatch(match)}
            >
              <Text style={styles.matchLabel}>{match.serverLabel}</Text>
              <Text style={styles.matchMeta} numberOfLines={1}>
                {match.agent.cwd}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <BackHeader title="Agent" onBack={handleGoHome} />
      <View style={styles.content}>{body}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flex: 1,
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[8],
  },
  centerState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[4],
  },
  title: {
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  subtitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.mutedForeground,
    textAlign: "center",
  },
  primaryButton: {
    marginTop: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.primary,
  },
  primaryButtonText: {
    color: theme.colors.primaryForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  matchList: {
    width: "100%",
    gap: theme.spacing[3],
  },
  matchButton: {
    width: "100%",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.muted,
  },
  matchLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  matchMeta: {
    marginTop: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    color: theme.colors.mutedForeground,
  },
}));
