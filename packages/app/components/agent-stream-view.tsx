import { useState, useEffect, useRef } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentStatus } from '@server/server/acp/types';
import type { SessionNotification } from '@agentclientprotocol/sdk';

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

function AgentUpdate({
  update,
}: {
  update: { timestamp: Date; notification: SessionNotification };
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  const notification = update.notification as any;

  // Parse different notification types
  if (notification.type === 'sessionUpdate') {
    const sessionUpdate = notification.sessionUpdate || {};

    // Handle message chunks
    if (sessionUpdate.kind === 'agent_message_chunk') {
      return (
        <View style={stylesheet.updateCard}>
          <Text style={stylesheet.timestampText}>
            {formatTimestamp(update.timestamp)}
          </Text>
          <Text style={stylesheet.messageText}>{sessionUpdate.chunk || ''}</Text>
        </View>
      );
    }

    // Handle tool calls
    if (sessionUpdate.kind === 'tool_call') {
      return (
        <View style={stylesheet.collapsibleCard}>
          <Pressable
            onPress={() => setIsExpanded(!isExpanded)}
            style={stylesheet.collapsibleHeader}
          >
            <Text style={stylesheet.timestampText}>
              {formatTimestamp(update.timestamp)}
            </Text>
            <Text style={stylesheet.toolCallText}>
              Tool Call: {sessionUpdate.toolName || 'unknown'}
            </Text>
          </Pressable>
          {isExpanded && sessionUpdate.arguments && (
            <View style={stylesheet.collapsibleContent}>
              <Text style={stylesheet.codeText}>
                {JSON.stringify(sessionUpdate.arguments, null, 2)}
              </Text>
            </View>
          )}
        </View>
      );
    }

    // Handle tool call updates
    if (sessionUpdate.kind === 'tool_call_update') {
      return (
        <View style={stylesheet.updateCard}>
          <Text style={stylesheet.timestampText}>
            {formatTimestamp(update.timestamp)}
          </Text>
          <Text style={stylesheet.updateStatusText}>
            {sessionUpdate.status || 'updating'}
          </Text>
        </View>
      );
    }

    // Handle available commands
    if (sessionUpdate.kind === 'available_commands_update') {
      const commands = sessionUpdate.commands || [];
      return (
        <View style={stylesheet.collapsibleCard}>
          <Pressable
            onPress={() => setIsExpanded(!isExpanded)}
            style={stylesheet.collapsibleHeader}
          >
            <Text style={stylesheet.timestampText}>
              {formatTimestamp(update.timestamp)}
            </Text>
            <Text style={stylesheet.commandsText}>
              Available Commands ({commands.length})
            </Text>
          </Pressable>
          {isExpanded && (
            <View style={stylesheet.collapsibleContent}>
              {commands.map((cmd: any, idx: number) => (
                <Text key={idx} style={stylesheet.commandItem}>
                  • {cmd.name || cmd}
                </Text>
              ))}
            </View>
          )}
        </View>
      );
    }

    // Generic session update
    return (
      <View style={stylesheet.updateCard}>
        <Text style={stylesheet.timestampText}>
          {formatTimestamp(update.timestamp)}
        </Text>
        <Text style={stylesheet.codeText}>
          {JSON.stringify(sessionUpdate, null, 2)}
        </Text>
      </View>
    );
  }

  // Fallback for unknown notification types
  return (
    <View style={stylesheet.updateCard}>
      <Text style={stylesheet.timestampText}>
        {formatTimestamp(update.timestamp)}
      </Text>
      <Text style={stylesheet.codeText}>
        {JSON.stringify(notification, null, 2)}
      </Text>
    </View>
  );
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

  // Auto-scroll to bottom when new updates arrive
  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [updates]);

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
        {updates.length === 0 ? (
          <View style={stylesheet.emptyState}>
            <Text style={stylesheet.emptyStateText}>
              No updates yet.{'\n'}Waiting for agent activity...
            </Text>
          </View>
        ) : (
          updates.map((update, idx) => <AgentUpdate key={idx} update={update} />)
        )}
      </ScrollView>
    </View>
  );
}

const stylesheet = StyleSheet.create((theme: import('../styles/theme').Theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.black,
  },
  header: {
    backgroundColor: theme.colors.zinc[900],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.zinc[800],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  backButton: {
    backgroundColor: theme.colors.zinc[800],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[4],
  },
  backButtonText: {
    color: theme.colors.white,
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
    color: theme.colors.zinc[400],
    fontSize: theme.fontSize.sm,
  },
  agentId: {
    color: theme.colors.white,
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
    color: theme.colors.white,
    fontSize: theme.fontSize.xs,
  },
  statusText: {
    color: theme.colors.white,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  createdText: {
    color: theme.colors.zinc[500],
    fontSize: theme.fontSize.xs,
  },
  controlButtons: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
  cancelButton: {
    flex: 1,
    backgroundColor: theme.colors.orange[600],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  killButton: {
    flex: 1,
    backgroundColor: theme.colors.red[600],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  controlButtonText: {
    color: theme.colors.white,
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
    color: theme.colors.zinc[500],
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  updateCard: {
    backgroundColor: theme.colors.zinc[800],
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    marginBottom: theme.spacing[2],
  },
  collapsibleCard: {
    backgroundColor: theme.colors.zinc[800],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[2],
    overflow: "hidden",
  },
  collapsibleHeader: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  collapsibleContent: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.zinc[700],
  },
  timestampText: {
    color: theme.colors.zinc[500],
    fontSize: theme.fontSize.xs,
    marginBottom: theme.spacing[1],
  },
  messageText: {
    color: theme.colors.white,
    fontSize: theme.fontSize.sm,
  },
  toolCallText: {
    color: "#60a5fa",
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  updateStatusText: {
    color: "#fbbf24",
    fontSize: theme.fontSize.sm,
  },
  commandsText: {
    color: "#4ade80",
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  commandItem: {
    color: theme.colors.zinc[400],
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  codeText: {
    color: theme.colors.zinc[400],
    fontSize: theme.fontSize.xs,
    fontFamily: "monospace",
    marginTop: theme.spacing[2],
  },
}));
