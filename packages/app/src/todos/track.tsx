import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import type { TodoEntry } from "@/types/stream";
import type { AgentTodoTrackSnapshot } from "./select";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedCheck = withUnistyles(Check);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const primaryForegroundColorMapping = (theme: Theme) => ({
  color: theme.colors.primaryForeground,
});

export interface TodosTrackProps {
  snapshot: AgentTodoTrackSnapshot | null;
}

const LIST_MAX_HEIGHT = 200;

export function TodosTrack({ snapshot }: TodosTrackProps): ReactElement | null {
  const { t } = useTranslation();
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
      styles.headerToggle,
      (hovered || pressed) && styles.headerActive,
    ],
    [],
  );
  const headerContainerStyle = useMemo(
    () => [styles.header, expanded ? styles.headerDivider : styles.headerCollapsed],
    [expanded],
  );

  if (!snapshot || snapshot.totalCount === 0) {
    return null;
  }

  const remaining = snapshot.totalCount - snapshot.completedCount;
  const headerLabel =
    remaining > 0
      ? t("todos.headerCountRemaining", {
          count: snapshot.totalCount,
          remaining,
        })
      : t("todos.headerCountDone", { count: snapshot.totalCount });

  return (
    <View style={styles.outer} testID="todos-track">
      <View style={styles.track}>
        <View style={surfaceStyle}>
          <View style={headerContainerStyle}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={headerLabel}
              testID="todos-track-header"
              onPress={toggleExpanded}
              style={headerStyle}
            >
              {expanded ? (
                <ThemedChevronDown size={12} uniProps={foregroundMutedColorMapping} />
              ) : (
                <ThemedChevronRight size={12} uniProps={foregroundMutedColorMapping} />
              )}
              <Text style={styles.headerLabel} numberOfLines={1}>
                {headerLabel}
              </Text>
            </Pressable>
          </View>
          {expanded ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              {snapshot.items.map((item) => (
                <TodosTrackRow
                  key={`${item.completed ? "done" : "open"}:${item.text}`}
                  item={item}
                />
              ))}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function TodosTrackRow({ item }: { item: TodoEntry }): ReactElement {
  const { t } = useTranslation();
  const a11yLabel = item.completed
    ? t("todos.itemDoneA11y", { text: item.text })
    : t("todos.itemOpenA11y", { text: item.text });

  return (
    <View
      style={styles.row}
      accessibilityRole="text"
      accessibilityLabel={a11yLabel}
      testID={`todos-track-row-${item.completed ? "done" : "open"}-${item.text}`}
    >
      <View
        style={[
          styles.checkbox,
          item.completed ? styles.checkboxComplete : styles.checkboxIncomplete,
        ]}
      >
        {item.completed ? <ThemedCheck size={11} uniProps={primaryForegroundColorMapping} /> : null}
      </View>
      <Text
        style={[styles.rowLabel, item.completed ? styles.rowLabelCompleted : null]}
        numberOfLines={2}
      >
        {item.text}
      </Text>
    </View>
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
  },
  headerToggle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  headerCollapsed: {
    paddingBottom: theme.spacing[4],
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
    maxHeight: LIST_MAX_HEIGHT,
  },
  scrollContent: {
    paddingVertical: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: 8,
    marginTop: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxIncomplete: {
    backgroundColor: theme.colors.foregroundMuted,
    opacity: 0.55,
  },
  checkboxComplete: {
    backgroundColor: theme.colors.primary,
    opacity: 0.95,
  },
  rowLabel: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  rowLabelCompleted: {
    color: theme.colors.foregroundMuted,
    textDecorationLine: "line-through",
  },
}));
