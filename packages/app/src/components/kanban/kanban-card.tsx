// KanbanCard — adapted from emdash for React Native
// Pressable card showing task name and branch
// Supports drag & drop on web via HTML5 drag API

import { useCallback, useMemo, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { KanbanTask } from "@/types/kanban";
import { GitBranch, Loader2, Archive } from "lucide-react-native";
import { isWeb } from "@/constants/platform";
import {
  IntegrationIcon,
  IntegrationDetail,
  extractLinkedIntegrations,
} from "./integration-context";

interface KanbanCardProps {
  task: KanbanTask;
  serverId?: string;
  isBusy?: boolean;
  onPress?: (task: KanbanTask) => void;
  onLongPress?: (task: KanbanTask) => void;
  onArchive?: (task: KanbanTask) => void;
  onDragStart?: (task: KanbanTask) => void;
  onDragEnd?: () => void;
}

export function KanbanCard({
  task,
  serverId,
  isBusy = false,
  onPress,
  onLongPress,
  onArchive,
  onDragStart,
  onDragEnd,
}: KanbanCardProps) {
  const { theme } = useUnistyles();
  const enableHtml5Drag = isWeb && (Boolean(onDragStart) || Boolean(onDragEnd));
  const [expandedIntegration, setExpandedIntegration] = useState<string | null>(null);

  const linkedIntegrations = useMemo(
    () => extractLinkedIntegrations(task.metadata, task.integrations, task.name, task.prompt),
    [task.integrations, task.metadata, task.name, task.prompt],
  );

  const handleDragStart = useCallback(
    (e: any) => {
      if (isWeb && e?.dataTransfer) {
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
      }
      onDragStart?.(task);
    },
    [onDragStart, task],
  );

  const handleDragEnd = useCallback(() => {
    onDragEnd?.();
  }, [onDragEnd]);

  const cardContent = (
    <View>
      <View style={styles.content}>
        <View style={styles.textContainer}>
          <Text style={styles.name} numberOfLines={1}>
            {task.name}
          </Text>
          {task.branch ? (
            <View style={styles.branchRow}>
              <GitBranch size={11} color={theme.colors.foregroundMuted} />
              <Text style={styles.branch} numberOfLines={1}>
                {task.branch}
              </Text>
            </View>
          ) : null}
          {task.agentProvider ? (
            <Text style={styles.agentLabel} numberOfLines={1}>
              {task.agentProvider}
              {task.agentMode === "cli" ? " (CLI)" : ""}
            </Text>
          ) : null}
        </View>
        <View style={styles.trailing}>
          {isBusy ? <Loader2 size={14} color={theme.colors.foregroundMuted} /> : null}
          {onArchive ? (
            <Pressable
              style={({ pressed }) => [
                styles.archiveButton,
                pressed && styles.archiveButtonPressed,
              ]}
              onPress={(e) => {
                e.stopPropagation?.();
                onArchive(task);
              }}
              hitSlop={8}
            >
              <Archive size={12} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Linked integrations */}
      {linkedIntegrations.length > 0 ? (
        <View style={styles.integrationsContainer}>
          {linkedIntegrations.map((item) => (
            <View key={item.id}>
              <Pressable
                style={({ pressed }) => [
                  styles.integrationRow,
                  pressed && styles.integrationRowPressed,
                ]}
                onPress={(e) => {
                  e.stopPropagation?.();
                  setExpandedIntegration((prev) => (prev === item.id ? null : item.id));
                }}
              >
                <IntegrationIcon
                  integration={item.id}
                  size={12}
                  color={theme.colors.foregroundMuted}
                />
                <Text style={styles.integrationIdentifier}>{item.identifier}</Text>
                <Text style={styles.integrationTitle} numberOfLines={1}>
                  {item.title}
                </Text>
              </Pressable>
              {expandedIntegration === item.id ? (
                <IntegrationDetail
                  item={item}
                  serverId={task.serverId ?? serverId}
                  cwd={task.path}
                  onClose={() => setExpandedIntegration(null)}
                />
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );

  // On web, wrap with a draggable div for HTML5 DnD
  if (enableHtml5Drag) {
    return (
      <Pressable
        style={({ pressed, hovered }) => [
          styles.card,
          hovered && styles.cardHovered,
          pressed && styles.cardPressed,
        ]}
        onPress={() => onPress?.(task)}
        onLongPress={() => onLongPress?.(task)}
        // @ts-expect-error — web-only prop
        draggable
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        {cardContent}
      </Pressable>
    );
  }

  return (
    <Pressable
      style={({ pressed, hovered }) => [
        styles.card,
        hovered && styles.cardHovered,
        pressed && styles.cardPressed,
      ]}
      onPress={() => onPress?.(task)}
      onLongPress={() => onLongPress?.(task)}
    >
      {cardContent}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    padding: theme.spacing[3],
  },
  cardHovered: {
    backgroundColor: theme.colors.surface2,
  },
  cardPressed: {
    opacity: 0.8,
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  textContainer: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  branchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginTop: 2,
  },
  branch: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  agentLabel: {
    fontSize: 10,
    color: theme.colors.foregroundMuted,
    marginTop: 2,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  archiveButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  archiveButtonPressed: {
    opacity: 0.5,
  },
  integrationsContainer: {
    marginTop: theme.spacing[2],
    gap: theme.spacing[1],
    borderTopWidth: 1,
    borderTopColor: theme.colors.surface2,
    paddingTop: theme.spacing[2],
  },
  integrationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
  },
  integrationRowPressed: {
    opacity: 0.7,
  },
  integrationIdentifier: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  integrationTitle: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    flex: 1,
    minWidth: 0,
  },
}));
