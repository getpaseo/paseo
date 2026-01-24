import { useCallback, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
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

export function LegacyAgentIdScreen({ agentId }: { agentId: string }) {
  const router = useRouter();
  const { theme } = useUnistyles();
  const { connectionStates } = useDaemonConnections();
  const sessionDirectory = useSessionDirectory();
  const resolvedAgentId = typeof agentId === "string" ? agentId.trim() : undefined;

  const matches = useMemo<AgentMatch[]>(() => {
    if (!resolvedAgentId) {
      return [];
    }

    const results: AgentMatch[] = [];
    sessionDirectory.forEach((session, serverId) => {
      if (!session) {
        return;
      }
      const agent = session.agents.get(resolvedAgentId);
      if (!agent) {
        return;
      }
      const serverLabel = connectionStates.get(serverId)?.daemon.label ?? serverId;
      results.push({ serverId, serverLabel, agent });
    });

    return results;
  }, [resolvedAgentId, sessionDirectory, connectionStates]);

  const hasSessions = sessionDirectory.size > 0;
  const isRedirecting = Boolean(resolvedAgentId && matches.length === 1);

  useEffect(() => {
    if (!isRedirecting) {
      return;
    }
    const match = matches[0];
    router.replace({
      pathname: "/agent/[[...route]]",
      params: { route: [match.serverId, match.agent.id] },
    });
  }, [isRedirecting, matches, router]);

  const handleGoDraft = useCallback(() => {
    router.replace({ pathname: "/agent/[[...route]]" });
  }, [router]);

  const handleSelectMatch = useCallback(
    (match: AgentMatch) => {
      router.replace({
        pathname: "/agent/[[...route]]",
        params: { route: [match.serverId, match.agent.id] },
      });
    },
    [router]
  );

  let body: ReactNode = null;

  if (!resolvedAgentId) {
    body = (
      <View style={styles.centerState}>
        <Text style={styles.title}>Missing agent</Text>
        <Text style={styles.subtitle}>
          This link is missing an agent id. Go back to the Agents screen to pick one.
        </Text>
        <Pressable style={styles.primaryButton} onPress={handleGoDraft}>
          <Text style={styles.primaryButtonText}>New Agent</Text>
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
            We could not find {resolvedAgentId} on any host right now. Hosts reconnect automatically—open it
            again from the Agents screen after it comes back online.
          </Text>
          <Pressable style={styles.primaryButton} onPress={handleGoDraft}>
            <Text style={styles.primaryButtonText}>New Agent</Text>
          </Pressable>
      </View>
    );
  } else if (matches.length > 1) {
    body = (
      <View style={styles.centerState}>
        <Text style={styles.title}>Pick a host</Text>
        <Text style={styles.subtitle}>
          Multiple hosts have an agent with this id. Choose the one you intended to open.
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
      <BackHeader title="Agent" onBack={handleGoDraft} />
      <View style={styles.content}>{body}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
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
    color: theme.colors.foregroundMuted,
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
    backgroundColor: theme.colors.surface2,
  },
  matchLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  matchMeta: {
    marginTop: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
