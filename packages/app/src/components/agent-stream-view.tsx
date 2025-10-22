import { useEffect, useRef } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentStatus } from '@server/server/acp/types';
import { AssistantMessage } from './message';
import type { StreamItem } from '@/types/stream';

export interface AgentStreamViewProps {
  agentId: string;
  agent: {
    id: string;
    status: AgentStatus;
    createdAt: Date;
    type: 'claude';
  };
  streamItems: StreamItem[];
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
  // Handle invalid dates gracefully
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
    return '--:--:--';
  }

  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(date);
}

function UserMessageCard({ text, timestamp }: { text: string; timestamp: Date }) {
  return (
    <View style={stylesheet.userMessageCard}>
      <Text style={stylesheet.timestamp}>
        {formatTimestamp(timestamp)}
      </Text>
      <Text style={stylesheet.userMessageLabel}>You</Text>
      <Text style={stylesheet.userMessageText}>{text}</Text>
    </View>
  );
}

function ThoughtCard({ text, timestamp }: { text: string; timestamp: Date }) {
  return (
    <View style={stylesheet.thoughtCard}>
      <Text style={stylesheet.timestamp}>
        {formatTimestamp(timestamp)}
      </Text>
      <Text style={stylesheet.thoughtLabel}>Thinking</Text>
      <Text style={stylesheet.thoughtText}>{text}</Text>
    </View>
  );
}

function ToolCallCard({
  title,
  status,
  toolKind,
  timestamp
}: {
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  toolKind?: string;
  timestamp: Date;
}) {
  return (
    <View style={stylesheet.toolCallCard}>
      <Text style={stylesheet.timestamp}>
        {formatTimestamp(timestamp)}
      </Text>
      <View style={stylesheet.toolCallHeader}>
        <Text style={stylesheet.toolCallLabel}>{toolKind || 'Tool'}</Text>
        <Text style={[stylesheet.toolCallStatus, { color: getStatusColor(status as any) }]}>
          {status}
        </Text>
      </View>
      <Text style={stylesheet.toolCallTitle}>{title}</Text>
    </View>
  );
}

export function AgentStreamView({
  agentId,
  agent,
  streamItems,
}: AgentStreamViewProps) {
  const scrollViewRef = useRef<ScrollView>(null);
  const insets = useSafeAreaInsets();

  // Auto-scroll to bottom when new items arrive
  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [streamItems]);

  return (
    <View style={stylesheet.container}>
      {/* Content list */}
      <ScrollView
        ref={scrollViewRef}
        style={stylesheet.scrollView}
        contentContainerStyle={{ paddingTop: 16, paddingBottom: Math.max(insets.bottom, 32) }}
      >
        {streamItems.length === 0 ? (
          <View style={stylesheet.emptyState}>
            <Text style={stylesheet.emptyStateText}>
              Start chatting with this agent...
            </Text>
          </View>
        ) : (
          streamItems.map((item) => {
            switch (item.kind) {
              case 'user_message':
                return (
                  <UserMessageCard
                    key={item.id}
                    text={item.text}
                    timestamp={item.timestamp}
                  />
                );

              case 'assistant_message':
                return (
                  <AssistantMessage
                    key={item.id}
                    message={item.text}
                    timestamp={item.timestamp.getTime()}
                  />
                );

              case 'thought':
                return (
                  <ThoughtCard
                    key={item.id}
                    text={item.text}
                    timestamp={item.timestamp}
                  />
                );

              case 'tool_call':
                return (
                  <ToolCallCard
                    key={item.id}
                    title={item.title}
                    status={item.status}
                    toolKind={item.toolKind}
                    timestamp={item.timestamp}
                  />
                );

              case 'plan':
                // TODO: Render plan component
                return null;

              case 'activity_log':
              case 'artifact':
                // These are orchestrator-only, skip for now
                return null;

              default:
                return null;
            }
          })
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
  userMessageCard: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    marginBottom: theme.spacing[2],
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.primary,
  },
  userMessageLabel: {
    color: theme.colors.primary,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    marginBottom: theme.spacing[1],
  },
  userMessageText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  timestamp: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    marginBottom: theme.spacing[1],
  },
  thoughtCard: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    marginBottom: theme.spacing[2],
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.palette.purple[500],
  },
  thoughtLabel: {
    color: theme.colors.palette.purple[500],
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    marginBottom: theme.spacing[1],
  },
  thoughtText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    fontStyle: 'italic',
  },
  toolCallCard: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    marginBottom: theme.spacing[2],
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.palette.blue[500],
  },
  toolCallHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing[1],
  },
  toolCallLabel: {
    color: theme.colors.palette.blue[500],
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  toolCallStatus: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  toolCallTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
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
