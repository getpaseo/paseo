import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Archive, ArrowUpDown, Flag, Folder, ListFilter } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { GoalSummary } from "@getpaseo/protocol/goal/types";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { StatusBadge } from "@/components/ui/status-badge";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { GOAL_LIST_FILTERS, countGoalsByFilter, type GoalListFilter } from "@/goals/goal-attention";
import {
  GOAL_PRIORITIES,
  GOAL_PRIORITY_FILTER_ALL,
  GOAL_SORTS,
  type GoalPriorityFilter,
  type GoalSort,
} from "@/goals/goal-management";
import { GOAL_PROJECT_FILTER_ALL, type GoalProjectFilterOption } from "@/goals/goal-projects";
import { goalToolbarMark } from "@/goals/goal-toolbar";
import { ICON_SIZE, type Theme } from "@/styles/theme";

/** Grows the 32pt button to a 44pt touch target where a finger presses it. */
const TOUCH_HIT_SLOP = (44 - CONTROL_HEIGHTS.compact) / 2;

const toolbarIcons = {
  status: withUnistyles(ListFilter),
  project: withUnistyles(Folder),
  priority: withUnistyles(Flag),
  sort: withUnistyles(ArrowUpDown),
  archived: withUnistyles(Archive),
};
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

/**
 * An icon filter in the Goals toolbar: a tooltip with the filter's name on web, its full state
 * for screen readers, the highlighted fill and a dot while it differs from its default, and an
 * attention count that shows whether or not it is active.
 */
function GoalToolbarIconButton({
  icon,
  tooltip,
  label,
  active,
  attentionCount,
  onPress,
  testID,
}: {
  icon: keyof typeof toolbarIcons;
  tooltip: string;
  label: string;
  active: boolean;
  attentionCount?: number;
  /** A toggle's press; without it the button opens the enclosing `DropdownMenu`. */
  onPress?: () => void;
  testID: string;
}): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const Icon = toolbarIcons[icon];
  const mark = goalToolbarMark({ active, attentionCount });
  const hitSlop = isNative || isCompact ? TOUCH_HIT_SLOP : undefined;
  const content: ReactNode = (
    <>
      <Icon size={ICON_SIZE.md} uniProps={active ? foregroundColorMapping : mutedColorMapping} />
      {mark.kind === "badge" ? <StatusBadge size="xs" variant="warning" label={mark.text} /> : null}
      {mark.kind === "dot" ? <View style={styles.dot} testID={`${testID}-dot`} /> : null}
    </>
  );
  const style = mark.kind === "badge" ? styles.buttonWithBadge : styles.button;
  // The tooltip names the filter; the label adds its current value for screen readers.
  const tooltipContent = useMemo(
    () => (tooltip === label ? undefined : <Text style={styles.tooltipText}>{tooltip}</Text>),
    [label, tooltip],
  );
  if (!onPress) {
    return (
      <ToolbarButton
        kind="menu"
        label={label}
        tooltip={tooltipContent}
        selected={active}
        style={style}
        hitSlop={hitSlop}
        testID={testID}
      >
        {content}
      </ToolbarButton>
    );
  }
  return (
    <ToolbarButton
      {...(isWeb ? ({ "aria-pressed": active } as object) : null)}
      label={label}
      tooltip={tooltipContent}
      selected={active}
      style={style}
      hitSlop={hitSlop}
      onPress={onPress}
      testID={testID}
    >
      {content}
    </ToolbarButton>
  );
}

/** The status filter; its badge counts the goals waiting on you, whatever is selected. */
export function GoalStatusFilterMenu({
  goals,
  filter,
  onChange,
  active,
}: {
  goals: readonly GoalSummary[];
  filter: GoalListFilter;
  onChange: (filter: GoalListFilter) => void;
  active: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const counts = useMemo(() => countGoalsByFilter(goals), [goals]);
  const attentionLabel = t("goals.filters.needs_you");
  const attention = counts.needs_you;
  const current = t(`goals.filters.${filter}`);
  const tooltip =
    attention > 0
      ? t("goals.toolbar.statusWithCount", { label: attentionLabel, n: attention })
      : t("goals.toolbar.status");
  const label =
    attention > 0
      ? t("goals.toolbar.statusLabelWithCount", {
          status: current,
          label: attentionLabel,
          n: attention,
        })
      : t("goals.toolbar.statusLabel", { status: current });
  return (
    <DropdownMenu>
      <GoalToolbarIconButton
        icon="status"
        tooltip={tooltip}
        label={label}
        active={active}
        attentionCount={attention}
        testID="goals-filter"
      />
      <DropdownMenuContent side="bottom" align="start" minWidth={200} testID="goals-filter-menu">
        {GOAL_LIST_FILTERS.map((value) => {
          const name = t(`goals.filters.${value}`);
          const showCount = value === "needs_you" && attention > 0;
          return (
            <ChoiceItem
              key={value}
              value={value}
              label={showCount ? t("goals.filterWithCount", { label: name, n: attention }) : name}
              selected={value === filter}
              onChange={onChange}
              testID={`goals-filter-${value}`}
            />
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Narrows the list to one project; the caller shows it only when goals span more than one. */
export function GoalProjectFilter({
  options,
  value,
  onChange,
  active,
}: {
  options: readonly GoalProjectFilterOption[];
  value: string;
  onChange: (key: string) => void;
  active: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const allLabel = t("goals.projectFilter.all");
  const selected = options.find((option) => option.key === value);
  const current = selected?.name ?? allLabel;
  const selectAll = useCallback(() => onChange(GOAL_PROJECT_FILTER_ALL), [onChange]);
  return (
    <DropdownMenu>
      <GoalToolbarIconButton
        icon="project"
        tooltip={t("goals.toolbar.project")}
        label={t("goals.projectFilter.label", { project: current })}
        active={active}
        testID="goals-project-filter-trigger"
      />
      <DropdownMenuContent
        side="bottom"
        align="start"
        minWidth={240}
        maxWidth={360}
        testID="goals-project-filter-menu"
      >
        <DropdownMenuItem
          selected={!selected}
          onSelect={selectAll}
          testID="goals-project-filter-all"
        >
          {allLabel}
        </DropdownMenuItem>
        {options.map((option) => (
          <GoalProjectFilterItem
            key={option.key}
            option={option}
            selected={option.key === selected?.key}
            onChange={onChange}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function GoalProjectFilterItem({
  option,
  selected,
  onChange,
}: {
  option: GoalProjectFilterOption;
  selected: boolean;
  onChange: (key: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onChange(option.key), [onChange, option.key]);
  return (
    <DropdownMenuItem
      selected={selected}
      description={option.path ?? undefined}
      onSelect={handleSelect}
      testID={`goals-project-filter-option-${option.key}`}
    >
      {t("goals.projectFilter.option", { project: option.name, n: option.count })}
    </DropdownMenuItem>
  );
}

/** Narrows the list to one priority; a goal without one counts as normal. */
export function GoalPriorityFilterMenu({
  value,
  onChange,
  active,
}: {
  value: GoalPriorityFilter;
  onChange: (value: GoalPriorityFilter) => void;
  active: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const label =
    value === GOAL_PRIORITY_FILTER_ALL
      ? t("goals.priorityFilter.all")
      : t("goals.priorityFilter.label", { priority: t(`goals.priority.levels.${value}`) });
  const choices: GoalPriorityFilter[] = [GOAL_PRIORITY_FILTER_ALL, ...GOAL_PRIORITIES];
  return (
    <DropdownMenu>
      <GoalToolbarIconButton
        icon="priority"
        tooltip={t("goals.priority.label")}
        label={label}
        active={active}
        testID="goals-priority-filter-trigger"
      />
      <DropdownMenuContent
        side="bottom"
        align="start"
        minWidth={200}
        testID="goals-priority-filter-menu"
      >
        {choices.map((choice) => (
          <ChoiceItem
            key={choice}
            value={choice}
            label={
              choice === GOAL_PRIORITY_FILTER_ALL
                ? t("goals.priorityFilter.all")
                : t(`goals.priority.levels.${choice}`)
            }
            selected={choice === value}
            onChange={onChange}
            testID={`goals-priority-filter-${choice}`}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The order inside each group; remembered on this device. */
export function GoalSortMenu({
  value,
  onChange,
  active,
}: {
  value: GoalSort;
  onChange: (value: GoalSort) => void;
  active: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <GoalToolbarIconButton
        icon="sort"
        tooltip={t("goals.toolbar.sort")}
        label={t("goals.sort.label", { sort: t(`goals.sort.${value}`) })}
        active={active}
        testID="goals-sort-trigger"
      />
      <DropdownMenuContent side="bottom" align="start" minWidth={200} testID="goals-sort-menu">
        {GOAL_SORTS.map((sort) => (
          <ChoiceItem
            key={sort}
            value={sort}
            label={t(`goals.sort.${sort}`)}
            selected={sort === value}
            onChange={onChange}
            testID={`goals-sort-${sort}`}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Shows archived goals in their own group; offered only on hosts with `goalManagement`. */
export function GoalArchivedIconToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onChange(!value), [onChange, value]);
  const label = t("goals.archived.show");
  return (
    <GoalToolbarIconButton
      icon="archived"
      tooltip={label}
      label={label}
      active={value}
      onPress={handlePress}
      testID="goals-show-archived"
    />
  );
}

function ChoiceItem<T extends string>({
  value,
  label,
  selected,
  onChange,
  testID,
}: {
  value: T;
  label: string;
  selected: boolean;
  onChange: (value: T) => void;
  testID: string;
}): ReactElement {
  const handleSelect = useCallback(() => onChange(value), [onChange, value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect} testID={testID}>
      {label}
    </DropdownMenuItem>
  );
}

const DOT_SIZE = 6;

const styles = StyleSheet.create((theme) => ({
  // One step up from the pane toolbar's glyph button, so the icons sit level with the search
  // field and the New goal button.
  button: {
    width: CONTROL_HEIGHTS.compact,
    height: CONTROL_HEIGHTS.compact,
  },
  buttonWithBadge: {
    width: "auto",
    minWidth: CONTROL_HEIGHTS.compact,
    height: CONTROL_HEIGHTS.compact,
    flexDirection: "row",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1.5],
  },
  dot: {
    position: "absolute",
    top: 4,
    right: 4,
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
}));
