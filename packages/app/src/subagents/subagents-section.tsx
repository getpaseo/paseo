import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronDown, ChevronRight, X } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { getProviderIcon } from "@/components/provider-icons";
import { useIsCompactFormFactor, MAX_CONTENT_WIDTH } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import {
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { SubagentRow } from "@/subagents/subagents";

interface SubagentsSectionProps {
  rows: SubagentRow[];
  onOpenSubagent: (id: string) => void;
  onArchiveSubagent: (id: string) => void;
}

const SUBAGENTS_LIST_MAX_HEIGHT = 200;

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

  const parts = [`${rows.length} ${rows.length === 1 ? "subagent" : "subagents"}`];
  if (runningCount > 0) {
    parts.push(`${runningCount} running`);
  }
  if (attentionCount > 0) {
    parts.push(`${attentionCount} needs attention`);
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
  onArchiveSubagent,
}: SubagentsSectionProps): ReactElement | null {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(false);

  const toggleExpanded = useCallback(() => {
    setExpanded((current) => !current);
  }, []);

  const surfaceStyle = useMemo(
    () => [styles.surface, expanded && styles.surfaceExpanded],
    [expanded],
  );

  const headerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.header,
      expanded ? styles.headerDivider : styles.headerCollapsed,
      (hovered || pressed) && styles.headerActive,
    ],
    [expanded],
  );

  if (rows.length === 0) {
    return null;
  }

  const headerLabel = formatHeaderLabel(rows);
  const ChevronIcon = expanded ? ChevronDown : ChevronRight;

  return (
    <View style={styles.outer} testID="subagents-section">
      <View style={styles.track}>
        <View style={surfaceStyle}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={headerLabel}
            testID="subagents-section-header"
            onPress={toggleExpanded}
            style={headerStyle}
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
                <SubagentsSectionRow
                  key={row.id}
                  row={row}
                  onOpenSubagent={onOpenSubagent}
                  onArchiveSubagent={onArchiveSubagent}
                />
              ))}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </View>
  );
}

interface SubagentsSectionRowProps {
  row: SubagentRow;
  onOpenSubagent: (id: string) => void;
  onArchiveSubagent: (id: string) => void;
}

function SubagentsSectionRow({
  row,
  onOpenSubagent,
  onArchiveSubagent,
}: SubagentsSectionRowProps): ReactElement {
  const { theme } = useUnistyles();
  const isCompact = useIsCompactFormFactor();
  const presentation = useMemo(() => buildRowPresentation(row), [row]);
  const displayLabel = presentation.titleState === "loading" ? "Loading..." : presentation.label;
  const handlePress = useCallback(() => {
    onOpenSubagent(row.id);
  }, [onOpenSubagent, row.id]);
  const handleArchivePress = useCallback(() => {
    onArchiveSubagent(row.id);
  }, [onArchiveSubagent, row.id]);
  const showArchiveAlways = isNative || isCompact;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={displayLabel}
      testID={`subagents-section-row-${row.id}`}
      onPress={handlePress}
    >
      {({ hovered, pressed }) => (
        <View style={hovered || pressed ? styles.rowActive : styles.row}>
          <WorkspaceTabIcon presentation={presentation} />
          <Text style={styles.rowLabel} numberOfLines={1}>
            {displayLabel}
          </Text>
          {showArchiveAlways || hovered ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Archive ${displayLabel}`}
              testID={`subagents-section-archive-${row.id}`}
              onPress={handleArchivePress}
              style={archiveButtonStyle}
              hitSlop={8}
            >
              <X size={14} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

function archiveButtonStyle({ hovered, pressed }: PressableStateCallbackType) {
  return [styles.archiveButton, (hovered || pressed) && styles.archiveButtonActive];
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
    marginBottom: -theme.spacing[4],
  },
  surface: {
    alignSelf: "stretch",
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderBottomWidth: 0,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
    overflow: "hidden",
  },
  surfaceExpanded: {
    paddingBottom: theme.spacing[4],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  headerCollapsed: {
    paddingBottom: theme.spacing[6],
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
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  rowLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  archiveButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
    alignItems: "center",
    justifyContent: "center",
  },
  archiveButtonActive: {
    backgroundColor: theme.colors.surface3,
  },
}));
