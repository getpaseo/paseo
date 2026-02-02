import { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Fonts } from "@/constants/theme";
import type { AgentActivity, GroupedTextMessage, MergedToolCall, SessionUpdate } from '@/types/agent-activity';

interface AgentActivityItemProps {
  item: GroupedTextMessage | MergedToolCall | AgentActivity;
}

function formatTimestamp(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(date);
}

function getToolIcon(toolKind?: string): string {
  switch (toolKind) {
    case 'read':
      return '📖';
    case 'edit':
      return '✏️';
    case 'delete':
      return '🗑️';
    case 'move':
      return '📦';
    case 'search':
      return '🔍';
    case 'execute':
      return '▶️';
    case 'think':
      return '💭';
    case 'fetch':
      return '🌐';
    case 'switch_mode':
      return '🔄';
    default:
      return '🔧';
  }
}

function getStatusColor(status?: string): string {
  switch (status) {
    case 'pending':
      return '#9ca3af';
    case 'in_progress':
      return '#fbbf24';
    case 'completed':
      return '#22c55e';
    case 'failed':
      return '#ef4444';
    default:
      return '#6b7280';
  }
}

function GroupedTextItem({ item }: { item: GroupedTextMessage }) {
  const isThought = item.messageType === 'thought';

  return (
    <View style={[stylesheet.card, isThought && stylesheet.thoughtCard]}>
      <Text style={[stylesheet.timestamp, isThought && stylesheet.thoughtTimestamp]}>
        {formatTimestamp(item.startTimestamp)}
      </Text>
      {isThought && (
        <Text style={stylesheet.thoughtLabel}>💭 Thinking</Text>
      )}
      <Text style={[stylesheet.text, isThought && stylesheet.thoughtText]}>
        {item.text}
      </Text>
    </View>
  );
}

function MergedToolCallItem({ item }: { item: MergedToolCall }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <View style={stylesheet.toolCard}>
      <Pressable
        onPress={() => setIsExpanded(!isExpanded)}
        style={stylesheet.toolHeader}
      >
        <View style={stylesheet.toolHeaderLeft}>
          <Text style={stylesheet.timestamp}>
            {formatTimestamp(item.startTimestamp)}
          </Text>
          <View style={stylesheet.toolTitleRow}>
            <Text style={stylesheet.toolIcon}>{getToolIcon(item.toolKind)}</Text>
            <Text style={stylesheet.toolTitle}>{item.title}</Text>
            <View
              style={[
                stylesheet.statusBadge,
                { backgroundColor: getStatusColor(item.status) },
              ]}
            >
              <Text style={stylesheet.statusText}>{item.status}</Text>
            </View>
          </View>
        </View>
        <Text style={stylesheet.expandIcon}>{isExpanded ? '▼' : '▶'}</Text>
      </Pressable>

      {isExpanded && (
        <View style={stylesheet.toolContent}>
          {item.rawInput && (
            <View style={stylesheet.section}>
              <Text style={stylesheet.sectionTitle}>Input:</Text>
              <Text style={stylesheet.code}>
                {JSON.stringify(item.rawInput, null, 2)}
              </Text>
            </View>
          )}
          {item.rawOutput && (
            <View style={stylesheet.section}>
              <Text style={stylesheet.sectionTitle}>Output:</Text>
              <Text style={stylesheet.code}>
                {JSON.stringify(item.rawOutput, null, 2)}
              </Text>
            </View>
          )}
          {!item.rawInput && !item.rawOutput && (
            <Text style={stylesheet.emptyText}>
              No details available
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function PlanItem({ update, timestamp }: { update: SessionUpdate; timestamp: Date }) {
  const [isExpanded, setIsExpanded] = useState(true);

  if (update.kind !== 'plan') {
    return null;
  }

  return (
    <View style={stylesheet.planCard}>
      <Pressable
        onPress={() => setIsExpanded(!isExpanded)}
        style={stylesheet.planHeader}
      >
        <View style={stylesheet.planHeaderLeft}>
          <Text style={stylesheet.timestamp}>{formatTimestamp(timestamp)}</Text>
          <Text style={stylesheet.planTitle}>
            📋 Tasks ({update.entries.length})
          </Text>
        </View>
        <Text style={stylesheet.expandIcon}>{isExpanded ? '▼' : '▶'}</Text>
      </Pressable>

      {isExpanded && (
        <View style={stylesheet.planContent}>
          {update.entries.map((entry, idx) => (
            <View key={idx} style={stylesheet.planEntry}>
              <Text
                style={[
                  stylesheet.planEntryStatus,
                  { color: getStatusColor(entry.status) },
                ]}
              >
                {entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '⏳' : '○'}
              </Text>
              <Text style={stylesheet.planEntryText}>{entry.content}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function UnknownActivityItem({ update, timestamp }: { update: SessionUpdate; timestamp: Date }) {
  const [showDrawer, setShowDrawer] = useState(false);

  return (
    <View style={stylesheet.unknownCard}>
      <Pressable
        onPress={() => setShowDrawer(!showDrawer)}
        style={stylesheet.unknownHeader}
      >
        <Text style={stylesheet.timestamp}>{formatTimestamp(timestamp)}</Text>
        <View style={stylesheet.unknownBadge}>
          <Text style={stylesheet.unknownBadgeText}>{update.kind}</Text>
        </View>
      </Pressable>

      {showDrawer && (
        <View style={stylesheet.drawerContent}>
          <Text style={stylesheet.code}>
            {JSON.stringify(update, null, 2)}
          </Text>
        </View>
      )}
    </View>
  );
}

export function AgentActivityItem({ item }: AgentActivityItemProps) {
  // Grouped text message
  if ('kind' in item && item.kind === 'grouped_text') {
    return <GroupedTextItem item={item} />;
  }

  // Merged tool call
  if ('kind' in item && item.kind === 'merged_tool_call') {
    return <MergedToolCallItem item={item} />;
  }

  // Individual activity
  const activity = item as AgentActivity;
  const update = activity.update;

  // Tasks
  if (update.kind === 'plan') {
    return <PlanItem update={update} timestamp={activity.timestamp} />;
  }

  // Available commands update
  if (update.kind === 'available_commands_update') {
    return (
      <View style={stylesheet.card}>
        <Text style={stylesheet.timestamp}>{formatTimestamp(activity.timestamp)}</Text>
        <Text style={stylesheet.infoText}>
          Commands updated ({update.availableCommands.length} available)
        </Text>
      </View>
    );
  }

  // Current mode update
  if (update.kind === 'current_mode_update') {
    return (
      <View style={stylesheet.card}>
        <Text style={stylesheet.timestamp}>{formatTimestamp(activity.timestamp)}</Text>
        <Text style={stylesheet.infoText}>
          Mode changed to: {update.currentModeId}
        </Text>
      </View>
    );
  }

  // Unknown activity type
  return <UnknownActivityItem update={update} timestamp={activity.timestamp} />;
}

const stylesheet = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    marginBottom: theme.spacing[2],
  },
  thoughtCard: {
    backgroundColor: theme.colors.surface2,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.palette.purple[500],
    paddingVertical: theme.spacing[2],
  },
  timestamp: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginBottom: theme.spacing[1],
  },
  thoughtTimestamp: {
    marginBottom: theme.spacing[0],
  },
  thoughtLabel: {
    color: theme.colors.palette.purple[500],
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    marginBottom: theme.spacing[0],
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  thoughtText: {
    color: theme.colors.foregroundMuted,
    fontStyle: 'italic',
  },
  toolCard: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[2],
    overflow: 'hidden',
  },
  toolHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: theme.spacing[3],
  },
  toolHeaderLeft: {
    flex: 1,
  },
  toolTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  toolIcon: {
    fontSize: theme.fontSize.base,
  },
  toolTitle: {
    color: theme.colors.palette.blue[400],
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    flex: 1,
  },
  statusBadge: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  statusText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  expandIcon: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  toolContent: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    padding: theme.spacing[3],
  },
  section: {
    marginBottom: theme.spacing[3],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    marginBottom: theme.spacing[1],
  },
  code: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: Fonts.mono,
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontStyle: 'italic',
  },
  planCard: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[2],
    overflow: 'hidden',
  },
  planHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: theme.spacing[3],
  },
  planHeaderLeft: {
    flex: 1,
  },
  planTitle: {
    color: theme.colors.palette.green[400],
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    marginTop: theme.spacing[1],
  },
  planContent: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    padding: theme.spacing[3],
  },
  planEntry: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  planEntryStatus: {
    fontSize: theme.fontSize.sm,
    marginTop: 2,
  },
  planEntryText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flex: 1,
  },
  infoText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  unknownCard: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[2],
    overflow: 'hidden',
  },
  unknownHeader: {
    padding: theme.spacing[3],
  },
  unknownBadge: {
    backgroundColor: theme.colors.palette.orange[600],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    marginTop: theme.spacing[2],
    alignSelf: 'flex-start',
  },
  unknownBadgeText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  drawerContent: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
  },
}));
