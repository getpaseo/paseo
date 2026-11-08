import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { BackHandler, ScrollView, Text, View } from "react-native";
import { useIsFocused } from "expo-router/react-navigation";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Goal, GoalSummary } from "@getpaseo/protocol/goal/types";
import { GoalDetail } from "@/components/goals/goal-detail";
import { GoalEmptyState } from "@/components/goals/goal-empty-state";
import { GoalFormSheet } from "@/components/goals/goal-form-sheet";
import { GoalArchivedToggle, GoalList, type GoalListDismiss } from "@/components/goals/goal-list";
import {
  GoalArchivedIconToggle,
  GoalPriorityFilterMenu,
  GoalProjectFilter,
  GoalSortMenu,
  GoalStatusFilterMenu,
} from "@/components/goals/goal-list-toolbar";
import { MenuHeader } from "@/components/headers/menu-header";
import { HostFilter } from "@/components/hosts/host-filter";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { isWeb } from "@/constants/platform";
import type { GoalListFilter } from "@/goals/goal-attention";
import type { GoalFormPrefill } from "@/goals/goal-form-model";
import {
  GOAL_PRIORITY_FILTER_ALL,
  compareGoals,
  filterGoalsForView,
  hasNarrowingGoalFilters,
  type GoalPriorityFilter,
} from "@/goals/goal-management";
import {
  GOAL_PROJECT_FILTER_ALL,
  buildGoalProjectFilterOptions,
  filterGoalsByProject,
} from "@/goals/goal-projects";
import { buildTemplatePrefill, type GoalTemplate } from "@/goals/goal-templates";
import { DEFAULT_GOAL_LIST_FILTER, activeGoalToolbarControls } from "@/goals/goal-toolbar";
import { useGoalProjectOptions } from "@/goals/use-goal-form-model";
import { useGoalMutations } from "@/hooks/use-goal-mutations";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useGoalList } from "@/hooks/use-goals";
import { useHostFeature, useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import { useHosts } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { useGoalListPreferencesStore } from "@/stores/goal-list-preferences-store";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { resolveGoalsScreenBodyState } from "./goals-screen-state";

const EMPTY_GOALS: GoalSummary[] = [];
/** Long enough that a typed word filters once, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 200;

interface GoalsScreenProps {
  /** Opens on this host and goal, such as one just started from a chat. */
  initialServerId?: string;
  initialGoalId?: string;
}

export function GoalsScreen(props: GoalsScreenProps): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <GoalsScreenContent {...props} />;
}

function GoalsScreenContent({ initialServerId, initialGoalId }: GoalsScreenProps): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const goalsSupport = useHostFeatureAvailabilityMap(serverIds, "goals");
  const [pickedServerId, setPickedServerId] = useState<string | null>(initialServerId ?? null);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(initialGoalId ?? null);
  // Each open gets its own key, so the form mounts fresh with the prefill it was opened with.
  const [form, setForm] = useState<{ key: number; prefill: GoalFormPrefill | undefined } | null>(
    null,
  );
  const [searchInput, setSearchInput] = useState("");
  // The field owns its text; clearing it from "Clear filters" remounts it empty.
  const [searchFieldKey, setSearchFieldKey] = useState(0);
  const search = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS);
  const [showArchived, setShowArchived] = useState(false);

  // A picked host that was removed falls back to the first host that supports goals.
  const pickedHostExists = hosts.some((host) => host.serverId === pickedServerId);
  const defaultServerId =
    serverIds.find((serverId) => goalsSupport.get(serverId) === true) ?? serverIds[0] ?? "";
  const serverId = pickedHostExists && pickedServerId ? pickedServerId : defaultServerId;
  const supportsGoals = goalsSupport.get(serverId) ?? null;
  // Archived goals exist only on hosts with goal management; older hosts list every goal.
  const supportsManagement = useHostFeature(serverId, "goalManagement");
  const includeArchived = supportsManagement && showArchived;

  const { loadState, isError, refetch } = useGoalList({
    serverId,
    enabled: supportsGoals === true,
    archived: includeArchived ? "include" : "exclude",
  });
  const bodyState = resolveGoalsScreenBodyState({
    hasHost: serverId !== "",
    supportsGoals,
    loadState,
    isError,
  });
  const allGoals = loadState.status === "loaded" ? loadState.data : EMPTY_GOALS;
  const clearSearch = useCallback(() => {
    setSearchInput("");
    setSearchFieldKey((key) => key + 1);
  }, []);
  const canCreate = bodyState.kind === "empty" || bodyState.kind === "content";

  const selectHost = useCallback((nextServerId: string) => {
    setPickedServerId(nextServerId);
    setSelectedGoalId(null);
    setShowArchived(false);
  }, []);
  const formPrefill = useLastWorkspacePrefill(serverId);
  const openForm = useCallback(
    () => setForm({ key: Date.now(), prefill: formPrefill }),
    [formPrefill],
  );
  const openTemplate = useCallback(
    (template: GoalTemplate) =>
      setForm({
        key: Date.now(),
        prefill: buildTemplatePrefill(
          template,
          {
            objective: t(`goals.templates.${template.id}.objective`),
            criteria: t(`goals.templates.${template.id}.criteria`),
          },
          formPrefill ?? {},
        ),
      }),
    [formPrefill, t],
  );
  const closeForm = useCallback(() => setForm(null), []);
  const closeDetail = useCallback(() => setSelectedGoalId(null), []);
  const selectCreatedGoal = useCallback((goal: Goal, createdServerId: string) => {
    setPickedServerId(createdServerId);
    setSelectedGoalId(goal.id);
  }, []);

  // The detail stays reachable only while the host can still serve goals.
  const detailGoalId = canCreate ? selectedGoalId : null;
  const showsDetail = detailGoalId !== null;

  // The detail is screen state, not a route: Android Back returns to the list instead of
  // leaving Goals. A sheet opened over the detail subscribes later, so it closes first.
  useEffect(() => {
    if (isWeb || !showsDetail) {
      return;
    }
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      closeDetail();
      return true;
    });
    return () => subscription.remove();
  }, [closeDetail, showsDetail]);
  let body: ReactElement;
  if (detailGoalId) {
    body = (
      <GoalDetail
        serverId={serverId}
        goalId={detailGoalId}
        onBack={closeDetail}
        onDeleted={closeDetail}
      />
    );
  } else if (bodyState.kind === "content") {
    // The list owns the toolbar and the scroll area: its filters sit beside the search field
    // and its rows fill the width, as in History.
    return (
      <View style={styles.container}>
        <MenuHeader title={t("goals.title")} />
        <GoalsListContent
          // Filters belong to one host's goals; another host starts unfiltered.
          key={serverId}
          serverId={serverId}
          goals={allGoals}
          search={search}
          onClearSearch={clearSearch}
          supportsManagement={supportsManagement}
          showArchived={showArchived}
          onShowArchivedChange={setShowArchived}
          onSelect={setSelectedGoalId}
          searchInput={searchInput}
          onSearchInputChange={setSearchInput}
          searchFieldKey={searchFieldKey}
          hosts={hosts}
          onSelectHost={selectHost}
          canCreate={canCreate}
          onCreate={openForm}
        />
        {form ? (
          <GoalFormSheet
            key={form.key}
            serverId={serverId}
            prefill={form.prefill}
            onClose={closeForm}
            onCreated={selectCreatedGoal}
          />
        ) : null}
      </View>
    );
  } else if (bodyState.kind === "empty") {
    body = (
      <GoalsEmptyBody
        onCreate={openForm}
        onTemplate={openTemplate}
        canShowArchived={supportsManagement}
        showArchived={showArchived}
        onShowArchivedChange={setShowArchived}
      />
    );
  } else if (bodyState.kind === "loading") {
    body = <LoadingSpinner size="large" color={styles.spinner.color} />;
  } else {
    body = <GoalsMessage kind={bodyState.kind} onRetry={refetch} />;
  }

  return (
    <View style={styles.container}>
      <MenuHeader title={t("goals.title")} />
      <View style={styles.toolbar}>
        <View style={styles.toolbarStart}>
          <GoalsHostFilter hosts={hosts} serverId={serverId} onSelectHost={selectHost} />
        </View>
        <GoalsNewButton visible={canCreate} onPress={openForm} />
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        // A row or filter takes the first tap while the search keyboard is up.
        keyboardShouldPersistTaps="handled"
        testID="goals-list"
      >
        <View style={showsDetail ? styles.detailColumn : styles.column}>{body}</View>
      </ScrollView>
      {form ? (
        <GoalFormSheet
          key={form.key}
          serverId={serverId}
          prefill={form.prefill}
          onClose={closeForm}
          onCreated={selectCreatedGoal}
        />
      ) : null}
    </View>
  );
}

/**
 * The filter rail and the list. Search comes from the toolbar; the status, project and priority
 * filters live here, and the sort is remembered on this device.
 */
function GoalsListContent({
  serverId,
  goals: allGoals,
  search,
  onClearSearch,
  supportsManagement,
  showArchived,
  onShowArchivedChange,
  onSelect,
  searchInput,
  onSearchInputChange,
  searchFieldKey,
  hosts,
  onSelectHost,
  canCreate,
  onCreate,
}: {
  serverId: string;
  goals: readonly GoalSummary[];
  search: string;
  onClearSearch: () => void;
  supportsManagement: boolean;
  showArchived: boolean;
  onShowArchivedChange: (value: boolean) => void;
  onSelect: (goalId: string) => void;
  searchInput: string;
  onSearchInputChange: (value: string) => void;
  /** Remounts the field so a cleared filter also empties what the person typed. */
  searchFieldKey: number;
  hosts: ReturnType<typeof useHosts>;
  onSelectHost: (serverId: string) => void;
  canCreate: boolean;
  onCreate: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<GoalListFilter>(DEFAULT_GOAL_LIST_FILTER);
  const [projectFilter, setProjectFilter] = useState<string>(GOAL_PROJECT_FILTER_ALL);
  const [priorityFilter, setPriorityFilter] =
    useState<GoalPriorityFilter>(GOAL_PRIORITY_FILTER_ALL);
  const sort = useGoalListPreferencesStore((state) => state.sort);
  const setSort = useGoalListPreferencesStore((state) => state.setSort);
  const compare = useMemo(() => compareGoals(sort), [sort]);
  const projects = useGoalProjectOptions(serverId);
  const dismiss = useGoalListDismiss(serverId);
  // The list is never paged, so search runs here on the host's full list and also matches
  // project names, which the host does not know.
  const viewGoals = useMemo(
    () =>
      filterGoalsForView(
        allGoals,
        { search, priority: priorityFilter, showArchived: supportsManagement && showArchived },
        projects,
      ),
    [allGoals, priorityFilter, projects, search, showArchived, supportsManagement],
  );
  const projectFilterOptions = useMemo(
    () => buildGoalProjectFilterOptions(allGoals, projects, t("goals.projectFilter.none")),
    [allGoals, projects, t],
  );
  const goals = useMemo(
    () => filterGoalsByProject(viewGoals, projects, projectFilter),
    [viewGoals, projectFilter, projects],
  );
  const isNarrowed = hasNarrowingGoalFilters({
    search,
    priority: priorityFilter,
    projectFiltered: projectFilter !== GOAL_PROJECT_FILTER_ALL,
  });
  const clearFilters = useCallback(() => {
    onClearSearch();
    setPriorityFilter(GOAL_PRIORITY_FILTER_ALL);
    setProjectFilter(GOAL_PROJECT_FILTER_ALL);
    setFilter(DEFAULT_GOAL_LIST_FILTER);
  }, [onClearSearch]);
  const active = activeGoalToolbarControls({
    status: filter,
    project: projectFilter,
    priority: priorityFilter,
    sort,
  });

  return (
    <>
      <View style={styles.listToolbar}>
        <View style={styles.listToolbarStart}>
          <View style={styles.searchSlot}>
            <SearchField
              key={searchFieldKey}
              value={searchInput}
              onChangeText={onSearchInputChange}
              placeholder={t("goals.search.placeholder")}
              clearAccessibilityLabel={t("goals.search.clear")}
              testID="goals-search-input"
              clearTestID="goals-search-clear"
            />
          </View>
          <GoalsHostFilter hosts={hosts} serverId={serverId} onSelectHost={onSelectHost} />
          <View style={styles.filterIcons}>
            <GoalStatusFilterMenu
              // Counted before search, project and priority narrow the list, so a filter never
              // hides how many goals wait on you.
              goals={allGoals}
              filter={filter}
              onChange={setFilter}
              active={active.status}
            />
            {projectFilterOptions.length > 1 ? (
              <GoalProjectFilter
                options={projectFilterOptions}
                value={projectFilter}
                onChange={setProjectFilter}
                active={active.project}
              />
            ) : null}
            {supportsManagement ? (
              <GoalPriorityFilterMenu
                value={priorityFilter}
                onChange={setPriorityFilter}
                active={active.priority}
              />
            ) : null}
            <GoalSortMenu value={sort} onChange={setSort} active={active.sort} />
            {supportsManagement ? (
              <GoalArchivedIconToggle value={showArchived} onChange={onShowArchivedChange} />
            ) : null}
          </View>
        </View>
        <GoalsNewButton visible={canCreate} onPress={onCreate} />
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.listScrollContent}
        showsVerticalScrollIndicator={false}
        // A row or filter takes the first tap while the search keyboard is up.
        keyboardShouldPersistTaps="handled"
        testID="goals-list"
      >
        <GoalList
          serverId={serverId}
          goals={goals}
          projects={projects}
          filter={filter}
          compare={compare}
          onSelect={onSelect}
          dismiss={dismiss}
          onClearFilters={isNarrowed ? clearFilters : null}
        />
      </ScrollView>
    </>
  );
}

function GoalsEmptyBody({
  onCreate,
  onTemplate,
  canShowArchived,
  showArchived,
  onShowArchivedChange,
}: {
  onCreate: () => void;
  onTemplate: (template: GoalTemplate) => void;
  /** Every goal may be archived; on hosts that archive, the toggle is the way back to them. */
  canShowArchived: boolean;
  showArchived: boolean;
  onShowArchivedChange: (value: boolean) => void;
}): ReactElement {
  return (
    <>
      <GoalEmptyState onCreate={onCreate} onTemplate={onTemplate} />
      {canShowArchived ? (
        <View style={styles.emptyArchived}>
          <GoalArchivedToggle value={showArchived} onChange={onShowArchivedChange} />
        </View>
      ) : null}
    </>
  );
}

function GoalsHostFilter({
  hosts,
  serverId,
  onSelectHost,
}: {
  hosts: ReturnType<typeof useHosts>;
  serverId: string;
  onSelectHost: (serverId: string) => void;
}): ReactElement | null {
  if (hosts.length <= 1) {
    return null;
  }
  return (
    <HostFilter
      hosts={hosts}
      selectedHost={serverId}
      onSelectHost={onSelectHost}
      includeAllHost={false}
      triggerTestID="goals-host-filter-trigger"
    />
  );
}

function GoalsNewButton({
  visible,
  onPress,
}: {
  visible: boolean;
  onPress: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!visible) {
    return null;
  }
  return (
    <Button variant="outline" size="sm" leftIcon={Plus} onPress={onPress} testID="goals-new">
      {t("goals.newGoal")}
    </Button>
  );
}

/** Dismiss for list rows, on hosts with `goalAcknowledge`; a failed dismiss shows a toast. */
function useGoalListDismiss(serverId: string): GoalListDismiss | null {
  const toast = useToast();
  const supported = useHostFeature(serverId, "goalAcknowledge");
  const { acknowledge, pendingAcknowledgeGoalId } = useGoalMutations({ serverId });
  const onDismiss = useCallback(
    (goalId: string) => {
      acknowledge(goalId).catch((error: unknown) => toast.error(toErrorMessage(error)));
    },
    [acknowledge, toast],
  );
  return useMemo(
    () => (supported ? { onDismiss, pendingGoalId: pendingAcknowledgeGoalId } : null),
    [onDismiss, pendingAcknowledgeGoalId, supported],
  );
}

/** The working directory starts from the last workspace you were in on this host. */
function useLastWorkspacePrefill(serverId: string): GoalFormPrefill | undefined {
  const lastWorkspace = useLastWorkspaceSelection();
  const lastWorkspaceDirectory = useWorkspaceFields(
    lastWorkspace?.serverId === serverId ? serverId : null,
    lastWorkspace?.workspaceId ?? null,
    (workspace) => workspace.workspaceDirectory,
  );
  return useMemo(
    () => (lastWorkspaceDirectory ? { cwd: lastWorkspaceDirectory } : undefined),
    [lastWorkspaceDirectory],
  );
}

function GoalsMessage({
  kind,
  onRetry,
}: {
  kind: "no-host" | "update-host" | "load-error";
  onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const messages = {
    "no-host": t("goals.noHost"),
    "update-host": t("goals.updateHost"),
    "load-error": t("goals.loadFailed"),
  };
  return (
    <View style={styles.centered} testID={`goals-${kind}`}>
      <Text style={styles.message}>{messages[kind]}</Text>
      {kind === "load-error" ? (
        <Button variant="ghost" onPress={onRetry} testID="goals-retry">
          {t("common.actions.retry")}
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  toolbarStart: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  column: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  },
  detailColumn: {
    width: "100%",
    flexGrow: 1,
    alignSelf: "stretch",
  },
  // Two blocks: search and filters wrap inside the start block, so New goal stays on the
  // first line at any width. On a phone the search field fills the first line beside it and
  // the filters wrap underneath.
  listToolbar: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  listToolbarStart: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  searchSlot: {
    width: { xs: "100%", md: 240 },
    minWidth: 0,
  },
  filterIcons: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  listScrollContent: {
    flexGrow: 1,
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[6],
  },
  emptyArchived: {
    alignItems: "center",
  },
  centered: {
    alignItems: "center",
    gap: theme.spacing[4],
    paddingVertical: theme.spacing[6],
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  // Static color holder read by the spinner; keeps the muted token without useUnistyles.
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
