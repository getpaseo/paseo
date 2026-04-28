// KanbanColumn — adapted from emdash for React Native
// Uses react-native-unistyles for styling, cross-platform

import type { ReactNode } from "react";
import { View, Text, ScrollView } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { KanbanStatus } from "@/types/kanban";

interface KanbanColumnProps {
  title: string;
  count: number;
  status: KanbanStatus;
  action?: ReactNode;
  children: ReactNode;
  isDropTarget?: boolean;
}

export function KanbanColumn({
  title,
  count,
  status,
  action,
  children,
  isDropTarget = false,
}: KanbanColumnProps) {
  return (
    <View style={[styles.column, isDropTarget && styles.columnDropTarget]}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.title}>{title}</Text>
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{count}</Text>
          </View>
        </View>
        {action ? <View>{action}</View> : null}
      </View>
      <ScrollView
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  column: {
    flex: 1,
    minHeight: 200,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    overflow: "hidden",
  },
  columnDropTarget: {
    borderColor: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  countBadge: {
    height: 20,
    minWidth: 20,
    borderRadius: 10,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[1],
  },
  countText: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
  scrollArea: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
}));
