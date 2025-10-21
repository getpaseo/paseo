import { View, Text, Pressable, ScrollView } from 'react-native';
import type { AgentStatus } from '@voice-assistant/server/acp/types';

export interface ActiveProcessesProps {
  agents: Array<{
    id: string;
    status: AgentStatus;
    type: 'claude';
    currentModeId?: string;
    availableModes?: Array<{ id: string; name: string; description?: string | null }>;
  }>;
  commands: Array<{
    id: string;
    name: string;
    workingDirectory: string;
    currentCommand: string;
    isDead: boolean;
    exitCode: number | null;
  }>;
  activeProcessId: string | null;
  activeProcessType: 'agent' | null;
  onSelectAgent: (id: string) => void;
  onBackToOrchestrator: () => void;
}

function getAgentStatusColor(status: AgentStatus): string {
  switch (status) {
    case 'initializing':
      return '#f59e0b'; // orange
    case 'ready':
      return '#3b82f6'; // blue
    case 'processing':
      return '#fbbf24'; // yellow
    case 'completed':
      return '#22c55e'; // green
    case 'failed':
      return '#ef4444'; // red
    case 'killed':
      return '#9ca3af'; // gray
    default:
      return '#9ca3af';
  }
}

function getModeName(modeId?: string, availableModes?: Array<{ id: string; name: string }>): string {
  if (!modeId) return 'unknown';
  const mode = availableModes?.find((m) => m.id === modeId);
  return mode?.name || modeId;
}

function getModeColor(modeId?: string): string {
  if (!modeId) return '#9ca3af'; // gray

  // Color based on common mode types
  if (modeId.includes('ask')) return '#f59e0b'; // orange - asks permission
  if (modeId.includes('code')) return '#22c55e'; // green - writes code
  if (modeId.includes('architect') || modeId.includes('plan')) return '#3b82f6'; // blue - plans

  return '#9ca3af'; // gray - unknown
}

export function ActiveProcesses({
  agents,
  commands,
  activeProcessId,
  activeProcessType,
  onSelectAgent,
  onBackToOrchestrator,
}: ActiveProcessesProps) {
  const hasActiveProcess = activeProcessId !== null && activeProcessType !== null;

  if (agents.length === 0 && commands.length === 0) {
    return null;
  }

  return (
    <View className="bg-zinc-900 border-b border-zinc-800">
      {/* Header with Back button */}
      {hasActiveProcess && (
        <View className="px-4 py-3 border-b border-zinc-800">
          <Pressable
            onPress={onBackToOrchestrator}
            className="bg-zinc-800 px-4 py-2 rounded-lg active:bg-zinc-700"
          >
            <Text className="text-white text-sm font-semibold text-center">
              Back to Chat
            </Text>
          </Pressable>
        </View>
      )}

      {/* Scrollable process list */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="px-4 py-3"
        contentContainerStyle={{ gap: 8 }}
      >
        {/* Agents */}
        {agents.map((agent) => {
          const modeName = getModeName(agent.currentModeId, agent.availableModes);
          const isActive = activeProcessType === 'agent' && activeProcessId === agent.id;

          return (
            <Pressable
              key={`agent-${agent.id}`}
              onPress={() => onSelectAgent(agent.id)}
              className={`flex-row items-center gap-2 px-3 py-2 rounded-lg ${
                isActive ? 'bg-blue-600' : 'bg-zinc-800'
              } active:opacity-70`}
            >
              {/* Agent icon */}
              <View className="w-3 h-3 rounded-full bg-blue-500" />

              {/* Agent ID (shortened) */}
              <Text className="text-white text-xs font-medium">
                {agent.id.substring(0, 8)}
              </Text>

              {/* Status indicator */}
              <View
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: getAgentStatusColor(agent.status) }}
              />

              {/* Mode indicator */}
              {agent.currentModeId && (
                <View
                  className="w-1.5 h-1.5 rounded-full opacity-30"
                  style={{ backgroundColor: getModeColor(agent.currentModeId) }}
                />
              )}
            </Pressable>
          );
        })}

        {/* Commands */}
        {commands.map((command) => {
          const statusColor = command.isDead
            ? command.exitCode === 0
              ? '#22c55e'
              : '#ef4444'
            : '#3b82f6';

          return (
            <View
              key={`command-${command.id}`}
              className="flex-row items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800"
            >
              {/* Command icon */}
              <View className="w-3 h-3 rounded-sm bg-purple-500" />

              {/* Command name */}
              <Text className="text-white text-xs font-medium" numberOfLines={1}>
                {command.name || command.currentCommand.substring(0, 20)}
              </Text>

              {/* Status indicator */}
              <View
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: statusColor }}
              />
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
