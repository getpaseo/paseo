import { memo, useCallback, useMemo, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronRight, TriangleAlert, Wrench } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import type {
  CompactToolCallGroup as CompactToolCallGroupModel,
  ToolCallCategorySummary,
} from "@/tool-calls/grouping";
import { componentForToolCallIcon } from "@/utils/tool-call-icon";

interface ToolCallGroupProps {
  group: CompactToolCallGroupModel;
  presentation: "overview" | "concise";
  expanded: boolean;
  onExpandedChange: (groupId: string, expanded: boolean) => void;
  children: ReactNode;
}

function CategoryStatus({ category }: { category: ToolCallCategorySummary }) {
  const { t } = useTranslation();
  if (category.failedCount > 0) {
    return (
      <View style={styles.categoryStatus}>
        <TriangleAlert size={12} color={styles.error.color} />
        <Text style={styles.error}>
          {t("toolCallGroup.failed", { count: category.failedCount })}
        </Text>
      </View>
    );
  }
  if (category.runningCount > 0) {
    return <ActivityIndicator size={12} color={styles.muted.color} />;
  }
  return null;
}

function CategoryRow({
  category,
  resourceLimit,
}: {
  category: ToolCallCategorySummary;
  resourceLimit: number;
}) {
  const Icon = componentForToolCallIcon(category.iconName);
  const visibleResources = category.resources.slice(0, resourceLimit);
  const hiddenResourceCount = category.resources.length - visibleResources.length;
  const resourceText = [
    ...visibleResources,
    ...(hiddenResourceCount > 0 ? [`+${hiddenResourceCount}`] : []),
  ].join(", ");

  return (
    <View style={styles.categoryRow}>
      <View style={styles.categoryIcon}>
        <Icon size={12} color={styles.muted.color} />
      </View>
      <Text style={styles.categoryCount}>×{category.callCount}</Text>
      <Text style={styles.categoryLabel}>{category.label}</Text>
      <CategoryStatus category={category} />
      {resourceText ? (
        <Text style={styles.resources} numberOfLines={1}>
          {resourceText}
        </Text>
      ) : null}
    </View>
  );
}

function GroupHeaderIcon({
  group,
  compact,
}: {
  group: CompactToolCallGroupModel;
  compact: boolean;
}) {
  const size = compact ? 11 : 12;
  if (group.failedCount > 0) {
    return <TriangleAlert size={size} color={styles.error.color} />;
  }
  if (group.isRunning) {
    return <ActivityIndicator size={size} color={styles.foreground.color} />;
  }
  return <Wrench size={size} color={styles.muted.color} />;
}

function joinSummaryParts(parts: string[], conjunction: string): string {
  if (parts.length === 0) {
    return "";
  }
  let joined: string;
  if (parts.length === 1) {
    joined = parts[0] ?? "";
  } else if (parts.length === 2) {
    joined = `${parts[0]} ${conjunction} ${parts[1]}`;
  } else {
    joined = `${parts.slice(0, -1).join(", ")}, ${conjunction} ${parts.at(-1)}`;
  }
  const firstCharacter = joined[0];
  return firstCharacter ? `${firstCharacter.toLocaleUpperCase()}${joined.slice(1)}` : joined;
}

export const ToolCallGroup = memo(function ToolCallGroup({
  group,
  presentation,
  expanded,
  onExpandedChange,
  children,
}: ToolCallGroupProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const isOverview = presentation === "overview";
  const resourceLimit = isCompact ? 2 : 3;
  const handlePress = useCallback(
    () => onExpandedChange(group.id, !expanded),
    [expanded, group.id, onExpandedChange],
  );
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const headerStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.header,
      !isOverview && styles.headerConcise,
      (pressed || hovered || expanded) && styles.headerActive,
    ],
    [expanded, isOverview],
  );
  const summary = useMemo(() => {
    const parts: string[] = [];
    if (group.editedFileCount > 0) {
      parts.push(
        t(
          group.editedFileCount === 1
            ? "toolCallGroup.editedFiles.one"
            : "toolCallGroup.editedFiles.other",
          { count: group.editedFileCount },
        ),
      );
    }
    if (group.commandCount > 0) {
      parts.push(
        t(
          group.commandCount === 1 ? "toolCallGroup.commands.one" : "toolCallGroup.commands.other",
          { count: group.commandCount },
        ),
      );
    }
    if (group.readFileCount > 0) {
      parts.push(
        t(
          group.readFileCount === 1
            ? "toolCallGroup.readFiles.one"
            : "toolCallGroup.readFiles.other",
          { count: group.readFileCount },
        ),
      );
    }
    if (group.searchCount > 0) {
      parts.push(
        t(group.searchCount === 1 ? "toolCallGroup.searches.one" : "toolCallGroup.searches.other", {
          count: group.searchCount,
        }),
      );
    }
    if (group.otherToolCount > 0) {
      parts.push(
        t(
          group.otherToolCount === 1
            ? "toolCallGroup.otherTools.one"
            : "toolCallGroup.otherTools.other",
          { count: group.otherToolCount },
        ),
      );
    }
    if (group.paseoCallCount > 0) {
      parts.push(
        t(
          group.paseoCallCount === 1
            ? "toolCallGroup.paseoCalls.one"
            : "toolCallGroup.paseoCalls.other",
          { count: group.paseoCallCount },
        ),
      );
    }
    return joinSummaryParts(parts, t("toolCallGroup.and"));
  }, [group, t]);
  const accessibilityLabel = isOverview
    ? summary
    : t("toolCallGroup.accessibilityLabel", { count: group.callCount });

  return (
    <View style={styles.container} testID="tool-call-group">
      <Pressable
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        accessibilityLabel={accessibilityLabel}
        style={headerStyle}
      >
        <View style={styles.headerIcon}>
          <GroupHeaderIcon group={group} compact={isOverview} />
        </View>
        {isOverview ? (
          <Text style={styles.summary} numberOfLines={1}>
            {summary}
          </Text>
        ) : (
          <>
            <Text style={styles.conciseTitle}>{t("toolCallGroup.title")}</Text>
            <Text style={styles.conciseCallCount}>×{group.callCount}</Text>
          </>
        )}
        {group.failedCount > 0 ? (
          <Text style={styles.error}>
            {t("toolCallGroup.failed", { count: group.failedCount })}
          </Text>
        ) : null}
        <ChevronRight
          size={isOverview ? 12 : 14}
          color={styles.muted.color}
          style={expanded ? styles.chevronExpanded : undefined}
        />
      </Pressable>

      {expanded ? <View style={styles.expandedCalls}>{children}</View> : null}
      {!expanded && !isOverview ? (
        <View style={styles.categories}>
          {group.categories.map((category) => (
            <CategoryRow key={category.key} category={category} resourceLimit={resourceLimit} />
          ))}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    marginHorizontal: -theme.spacing[3],
  },
  header: {
    minHeight: 26,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
  },
  headerActive: {
    backgroundColor: theme.colors.surface1,
  },
  headerConcise: {
    minHeight: 30,
  },
  headerIcon: {
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  summary: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  conciseTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  conciseCallCount: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  categories: {
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[8],
    paddingRight: theme.spacing[2],
    paddingTop: theme.spacing[1],
  },
  categoryRow: {
    minHeight: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  categoryIcon: {
    width: 14,
    alignItems: "center",
  },
  categoryLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    minWidth: 64,
  },
  categoryCount: {
    width: theme.spacing[6],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "right",
  },
  categoryStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  resources: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  expandedCalls: {
    paddingTop: theme.spacing[1],
    marginHorizontal: theme.spacing[3],
  },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  foreground: {
    color: theme.colors.foreground,
  },
  muted: {
    color: theme.colors.foregroundMuted,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
  },
}));
