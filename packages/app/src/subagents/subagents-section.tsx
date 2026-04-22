import React, { useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { getProviderIcon } from "@/components/provider-icons";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import {
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { SubagentRow } from "@/subagents/subagents";

type SubagentsSectionProps = {
  rows: SubagentRow[];
  onOpenSubagent: (id: string) => void;
};

const SUBAGENTS_LIST_MAX_HEIGHT = 200;

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatHeaderLabel(rows: SubagentRow[]): string {
  let runningCount = 0;
  let attentionCount = 0;
  for (const row of rows) {
    if (row.status === "running") {
      runningCount += 1;
    }
    const bucket = deriveSidebarStateBucket({
      status: row.status,
      requiresAttention: row.requiresAttention,
    });
    if (bucket === "attention") {
      attentionCount += 1;
    }
  }

  const parts = [formatCount(rows.length, "subagent", "subagents")];
  if (runningCount > 0) {
    parts.push(formatCount(runningCount, "running", "running"));
  }
  if (attentionCount > 0) {
    parts.push(formatCount(attentionCount, "needs attention", "needs attention"));
  }
  return parts.join(" · ");
}

function resolveRowLabel(title: SubagentRow["title"]): string | null {
  if (typeof title !== "string") {
    return null;
  }
  const normalized = title.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.toLowerCase() === "new agent") {
    return null;
  }
  return normalized;
}

function buildRowPresentation(row: SubagentRow): WorkspaceTabPresentation {
  const label = resolveRowLabel(row.title);
  return {
    key: `subagent_${row.id}`,
    kind: "agent",
    label: label ?? "",
    subtitle: "",
    titleState: label ? "ready" : "loading",
    icon: getProviderIcon(row.provider),
    statusBucket: deriveSidebarStateBucket({
      status: row.status,
      requiresAttention: row.requiresAttention,
    }),
  };
}

export function SubagentsSection({
  rows,
  onOpenSubagent,
}: SubagentsSectionProps): ReactElement | null {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(false);

  if (rows.length === 0) {
    return null;
  }

  const headerLabel = formatHeaderLabel(rows);
  const ChevronIcon = expanded ? ChevronDown : ChevronRight;

  return (
    <View style={styles.outer} testID="subagents-section">
      <View style={styles.track}>
        <View style={[styles.surface, expanded ? styles.surfaceExpanded : styles.surfaceCollapsed]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={headerLabel}
            testID="subagents-section-header"
            onPress={() => setExpanded((current) => !current)}
            style={({ hovered, pressed }) => [
              styles.header,
              expanded && styles.headerDivider,
              (hovered || pressed) && styles.headerActive,
            ]}
          >
            <ChevronIcon size={12} color={theme.colors.foregroundMuted} />
            <Text style={styles.headerLabel} numberOfLines={1}>
              {headerLabel}
            </Text>
          </Pressable>
          {expanded ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              {rows.map((row) => (
                <SubagentsSectionRow key={row.id} row={row} onOpenSubagent={onOpenSubagent} />
              ))}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function SubagentsSectionRow({
  row,
  onOpenSubagent,
}: {
  row: SubagentRow;
  onOpenSubagent: (id: string) => void;
}): ReactElement {
  const presentation = useMemo(() => buildRowPresentation(row), [row]);
  const displayLabel = presentation.titleState === "loading" ? "Loading..." : presentation.label;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={displayLabel}
      testID={`subagents-section-row-${row.id}`}
      onPress={() => onOpenSubagent(row.id)}
      style={({ hovered, pressed }) => [styles.row, (hovered || pressed) && styles.rowActive]}
    >
      <WorkspaceTabIcon presentation={presentation} />
      <Text style={styles.rowLabel} numberOfLines={1}>
        {displayLabel}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  outer: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  track: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
  },
  surface: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderBottomWidth: 0,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
    overflow: "hidden",
  },
  surfaceCollapsed: {
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  surfaceExpanded: {
    alignSelf: "stretch",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  headerActive: {
    backgroundColor: theme.colors.surface2,
  },
  headerDivider: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
  scroll: {
    maxHeight: SUBAGENTS_LIST_MAX_HEIGHT,
  },
  scrollContent: {
    paddingVertical: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  rowActive: {
    backgroundColor: theme.colors.surface2,
  },
  rowLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
