import { View, Text, Pressable, ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentStatus } from '@server/server/acp/types';

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

const styles = StyleSheet.create((theme: import('../styles/theme').Theme) => ({
  container: {
    backgroundColor: theme.colors.zinc[900],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.zinc[800],
  },
  header: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.zinc[800],
  },
  backButton: {
    backgroundColor: theme.colors.zinc[800],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  backButtonActive: {
    backgroundColor: theme.colors.zinc[700],
  },
  backButtonText: {
    color: '#fff',
    fontSize: theme.fontSize.sm,
    fontWeight: '600',
    textAlign: 'center',
  },
  scrollView: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  processItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  processItemActive: {
    backgroundColor: theme.colors.blue[600],
  },
  processItemInactive: {
    backgroundColor: theme.colors.zinc[800],
  },
  agentIcon: {
    width: 12,
    height: 12,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.blue[500],
  },
  commandIcon: {
    width: 12,
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.purple[500],
  },
  processText: {
    color: '#fff',
    fontSize: theme.fontSize.xs,
    fontWeight: '500',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  modeIndicator: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    opacity: 0.3,
  },
}));

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
    <View style={styles.container}>
      {hasActiveProcess && (
        <View style={styles.header}>
          <Pressable
            onPress={onBackToOrchestrator}
            style={({ pressed }) => [styles.backButton, pressed && styles.backButtonActive]}
          >
            <Text style={styles.backButtonText}>Back to Chat</Text>
          </Pressable>
        </View>
      )}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scrollView}
        contentContainerStyle={{ gap: 8 }}
      >
        {agents.map((agent) => {
          const modeName = getModeName(agent.currentModeId, agent.availableModes);
          const isActive = activeProcessType === 'agent' && activeProcessId === agent.id;

          return (
            <Pressable
              key={`agent-${agent.id}`}
              onPress={() => onSelectAgent(agent.id)}
              style={({ pressed }) => [
                styles.processItem,
                isActive ? styles.processItemActive : styles.processItemInactive,
                pressed && { opacity: 0.7 },
              ]}
            >
              <View style={styles.agentIcon} />

              <Text style={styles.processText}>{agent.id.substring(0, 8)}</Text>

              <View style={[styles.statusDot, { backgroundColor: getAgentStatusColor(agent.status) }]} />

              {agent.currentModeId && (
                <View style={[styles.modeIndicator, { backgroundColor: getModeColor(agent.currentModeId) }]} />
              )}
            </Pressable>
          );
        })}

        {commands.map((command) => {
          const statusColor = command.isDead
            ? command.exitCode === 0
              ? '#22c55e'
              : '#ef4444'
            : '#3b82f6';

          return (
            <View key={`command-${command.id}`} style={[styles.processItem, styles.processItemInactive]}>
              <View style={styles.commandIcon} />

              <Text style={styles.processText} numberOfLines={1}>
                {command.name || command.currentCommand.substring(0, 20)}
              </Text>

              <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
