import { useEffect, useRef, useMemo } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentStatus } from '@server/server/acp/types';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { AgentActivityItem } from './agent-activity';
import { parseSessionUpdate, groupTextChunks, type AgentActivity } from '@/types/agent-activity';

export interface AgentStreamViewProps {
  agentId: string;
  agent: {
    id: string;
    status: AgentStatus;
    createdAt: Date;
    type: 'claude';
  };
  updates: Array<{
    timestamp: Date;
    notification: SessionNotification;
  }>;
  onBack: () => void;
  onKillAgent: (agentId: string) => void;
  onCancelAgent: (agentId: string) => void;
}

function getStatusColor(status: AgentStatus): string {
  switch (status) {
    case 'initializing':
      return '#f59e0b';
    case 'ready':
      return '#3b82f6';
    case 'processing':
      return '#fbbf24';
    case 'completed':
      return '#22c55e';
    case 'failed':
      return '#ef4444';
    case 'killed':
      return '#9ca3af';
    default:
      return '#9ca3af';
  }
}

function getStatusIcon(status: AgentStatus): string {
  switch (status) {
    case 'initializing':
    case 'processing':
      return '⏳';
    case 'ready':
    case 'completed':
      return '✓';
    case 'failed':
    case 'killed':
      return '✗';
    default:
      return '•';
  }
}

function formatTimestamp(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(date);
}

export function AgentStreamView({
  agentId,
  agent,
  updates,
  onBack,
  onKillAgent,
  onCancelAgent,
}: AgentStreamViewProps) {
  const scrollViewRef = useRef<ScrollView>(null);
  const insets = useSafeAreaInsets();

  // Parse and group activities
  const groupedActivities = useMemo(() => {
    // Parse all notifications into typed activities
    const activities: AgentActivity[] = updates
      .map((update) => {
        const parsedUpdate = parseSessionUpdate(update.notification);
        if (!parsedUpdate) return null;

        return {
          timestamp: update.timestamp,
          update: parsedUpdate,
        };
      })
      .filter((activity): activity is AgentActivity => activity !== null);

    // Group consecutive text chunks
    return groupTextChunks(activities);
  }, [updates]);

  // Auto-scroll to bottom when new updates arrive
  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [groupedActivities]);

  const canCancel = agent.status === 'processing';
  const canKill = agent.status !== 'killed' && agent.status !== 'completed';

  return (
    <View style={stylesheet.container}>
      {/* Header */}
      <View style={[stylesheet.header, { paddingTop: insets.top + 16 }]}>
        {/* Back button */}
        <Pressable
          onPress={onBack}
          style={stylesheet.backButton}
        >
          <Text style={stylesheet.backButtonText}>
            ← Back to Chat
          </Text>
        </Pressable>

        {/* Agent info */}
        <View style={stylesheet.agentInfoRow}>
          <View style={stylesheet.agentIdRow}>
            <Text style={stylesheet.agentLabel}>Agent:</Text>
            <Text style={stylesheet.agentId}>
              {agentId.substring(0, 8)}
            </Text>
          </View>
          <View
            style={[
              stylesheet.statusBadge,
              { backgroundColor: getStatusColor(agent.status) }
            ]}
          >
            <Text style={stylesheet.statusIcon}>{getStatusIcon(agent.status)}</Text>
            <Text style={stylesheet.statusText}>{agent.status}</Text>
          </View>
        </View>

        <Text style={stylesheet.createdText}>
          Created: {formatTimestamp(agent.createdAt)}
        </Text>

        {/* Control buttons */}
        {(canCancel || canKill) && (
          <View style={stylesheet.controlButtons}>
            {canCancel && (
              <Pressable
                onPress={() => onCancelAgent(agentId)}
                style={stylesheet.cancelButton}
              >
                <Text style={stylesheet.controlButtonText}>
                  Cancel
                </Text>
              </Pressable>
            )}
            {canKill && (
              <Pressable
                onPress={() => onKillAgent(agentId)}
                style={stylesheet.killButton}
              >
                <Text style={stylesheet.controlButtonText}>
                  Kill
                </Text>
              </Pressable>
            )}
          </View>
        )}
      </View>

      {/* Updates list */}
      <ScrollView
        ref={scrollViewRef}
        style={stylesheet.scrollView}
        contentContainerStyle={{ paddingTop: 16, paddingBottom: Math.max(insets.bottom, 32) }}
      >
        {groupedActivities.length === 0 ? (
          <View style={stylesheet.emptyState}>
            <Text style={stylesheet.emptyStateText}>
              No updates yet.{'\n'}Waiting for agent activity...
            </Text>
          </View>
        ) : (
          groupedActivities.map((item, idx) => (
            <AgentActivityItem key={idx} item={item} />
          ))
        )}
      </ScrollView>
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    backgroundColor: theme.colors.card,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  backButton: {
    backgroundColor: theme.colors.muted,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[4],
  },
  backButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    textAlign: "center",
  },
  agentInfoRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: theme.spacing[3],
  },
  agentIdRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  agentLabel: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
  },
  agentId: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: "monospace",
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
  },
  statusIcon: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
  statusText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  createdText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
  },
  controlButtons: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
  cancelButton: {
    flex: 1,
    backgroundColor: theme.colors.palette.orange[600],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  killButton: {
    flex: 1,
    backgroundColor: theme.colors.destructive,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  controlButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    textAlign: "center",
  },
  scrollView: {
    flex: 1,
    paddingHorizontal: theme.spacing[4],
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[12],
  },
  emptyStateText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
