import { useState, useEffect, useRef } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
        <View className="bg-zinc-800 rounded-lg p-3 mb-2">
          <Text className="text-zinc-500 text-xs mb-1">
            {formatTimestamp(update.timestamp)}
          </Text>
          <Text className="text-white text-sm">{sessionUpdate.chunk || ''}</Text>
        </View>
      );
    }

    // Handle tool calls
    if (sessionUpdate.kind === 'tool_call') {
      return (
        <View className="bg-zinc-800 rounded-lg mb-2 overflow-hidden">
          <Pressable
            onPress={() => setIsExpanded(!isExpanded)}
            className="px-3 py-2 active:bg-zinc-700"
          >
            <Text className="text-zinc-500 text-xs mb-1">
              {formatTimestamp(update.timestamp)}
            </Text>
            <Text className="text-blue-400 text-sm font-medium">
              Tool Call: {sessionUpdate.toolName || 'unknown'}
            </Text>
          </Pressable>
          {isExpanded && sessionUpdate.arguments && (
            <View className="px-3 pb-3 border-t border-zinc-700">
              <Text className="text-zinc-400 text-xs font-mono mt-2">
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
        <View className="bg-zinc-800 rounded-lg p-3 mb-2">
          <Text className="text-zinc-500 text-xs mb-1">
            {formatTimestamp(update.timestamp)}
          </Text>
          <Text className="text-yellow-400 text-sm">
            {sessionUpdate.status || 'updating'}
          </Text>
        </View>
      );
    }

    // Handle available commands
    if (sessionUpdate.kind === 'available_commands_update') {
      const commands = sessionUpdate.commands || [];
      return (
        <View className="bg-zinc-800 rounded-lg mb-2 overflow-hidden">
          <Pressable
            onPress={() => setIsExpanded(!isExpanded)}
            className="px-3 py-2 active:bg-zinc-700"
          >
            <Text className="text-zinc-500 text-xs mb-1">
              {formatTimestamp(update.timestamp)}
            </Text>
            <Text className="text-green-400 text-sm font-medium">
              Available Commands ({commands.length})
            </Text>
          </Pressable>
          {isExpanded && (
            <View className="px-3 pb-3 border-t border-zinc-700">
              {commands.map((cmd: any, idx: number) => (
                <Text key={idx} className="text-zinc-400 text-xs mt-1">
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
      <View className="bg-zinc-800 rounded-lg p-3 mb-2">
        <Text className="text-zinc-500 text-xs mb-1">
          {formatTimestamp(update.timestamp)}
        </Text>
        <Text className="text-zinc-400 text-xs font-mono">
          {JSON.stringify(sessionUpdate, null, 2)}
        </Text>
      </View>
    );
  }

  // Fallback for unknown notification types
  return (
    <View className="bg-zinc-800 rounded-lg p-3 mb-2">
      <Text className="text-zinc-500 text-xs mb-1">
        {formatTimestamp(update.timestamp)}
      </Text>
      <Text className="text-zinc-400 text-xs font-mono">
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
    <View className="flex-1 bg-black">
      {/* Header */}
      <View className="bg-zinc-900 border-b border-zinc-800 px-4 pb-4" style={{ paddingTop: insets.top + 16 }}>
        {/* Back button */}
        <Pressable
          onPress={onBack}
          className="bg-zinc-800 px-4 py-2 rounded-lg mb-4 active:bg-zinc-700"
        >
          <Text className="text-white text-sm font-semibold text-center">
            ← Back to Chat
          </Text>
        </Pressable>

        {/* Agent info */}
        <View className="flex-row items-center justify-between mb-3">
          <View className="flex-row items-center gap-2">
            <Text className="text-zinc-400 text-sm">Agent:</Text>
            <Text className="text-white text-sm font-mono">
              {agentId.substring(0, 8)}
            </Text>
          </View>
          <View
            className="flex-row items-center gap-2 px-3 py-1 rounded-full"
            style={{ backgroundColor: getStatusColor(agent.status) }}
          >
            <Text className="text-white text-xs">{getStatusIcon(agent.status)}</Text>
            <Text className="text-white text-xs font-medium">{agent.status}</Text>
          </View>
        </View>

        <Text className="text-zinc-500 text-xs">
          Created: {formatTimestamp(agent.createdAt)}
        </Text>

        {/* Control buttons */}
        {(canCancel || canKill) && (
          <View className="flex-row gap-2 mt-4">
            {canCancel && (
              <Pressable
                onPress={() => onCancelAgent(agentId)}
                className="flex-1 bg-orange-600 px-4 py-2 rounded-lg active:bg-orange-700"
              >
                <Text className="text-white text-sm font-semibold text-center">
                  Cancel
                </Text>
              </Pressable>
            )}
            {canKill && (
              <Pressable
                onPress={() => onKillAgent(agentId)}
                className="flex-1 bg-red-600 px-4 py-2 rounded-lg active:bg-red-700"
              >
                <Text className="text-white text-sm font-semibold text-center">
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
        className="flex-1 px-4"
        contentContainerStyle={{ paddingTop: 16, paddingBottom: Math.max(insets.bottom, 32) }}
      >
        {updates.length === 0 ? (
          <View className="flex-1 items-center justify-center py-12">
            <Text className="text-zinc-500 text-sm text-center">
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
