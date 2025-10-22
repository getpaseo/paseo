import { useEffect, useRef } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentStatus } from '@server/server/acp/types';
import { AssistantMessage, UserMessage, ActivityLog, ToolCall } from './message';
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
                  <UserMessage
                    key={item.id}
                    message={item.text}
                    timestamp={item.timestamp.getTime()}
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
                  <ActivityLog
                    key={item.id}
                    type="info"
                    message={item.text}
                    timestamp={item.timestamp.getTime()}
                  />
                );

              case 'tool_call': {
                // Map status: pending/in_progress -> executing, completed -> completed, failed -> failed
                const toolStatus = item.status === 'pending' || item.status === 'in_progress'
                  ? 'executing' as const
                  : item.status === 'completed'
                  ? 'completed' as const
                  : 'failed' as const;

                return (
                  <ToolCall
                    key={item.id}
                    toolName={item.title}
                    args={item.rawInput}
                    result={item.rawOutput}
                    status={toolStatus}
                  />
                );
              }

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
