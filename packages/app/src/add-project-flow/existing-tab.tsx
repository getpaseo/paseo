import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Folder, FolderOpen, Search } from "lucide-react-native";
import { buildProjectPickerOptions } from "@/components/project-picker-options";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { isWeb } from "@/constants/platform";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { shortenPath } from "@/utils/shorten-path";
import type { AddProjectActions } from "./use-add-project-actions";
import type { AddProjectFlowState, AddProjectHost } from "./model";
import { pathBaseName } from "./options";
import { ResultList, type ResultRow } from "./result-list";
import { RESULTS_TEST_ID } from "./result-list-id";
import { useDirectorySearch } from "./searches";
import { resolveActiveIndex, type AddProjectTabView } from "./tab-view";

const ThemedSearch = withUnistyles(Search);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const searchIcon = <ThemedSearch size={ICON_SIZE.md} uniProps={mutedColor} />;

export function useExistingTab(input: {
  state: AddProjectFlowState;
  host: AddProjectHost | null;
  recommendedPaths: string[];
  actions: AddProjectActions;
}): AddProjectTabView {
  const { state, host, recommendedPaths, actions } = input;
  const { query } = state.existing;
  const canAddProject = host?.canAddProject === true;
  const search = useDirectorySearch({
    hostId: state.hostId,
    query,
    // The host answers a blank query with nothing, so only search once there is text.
    enabled: state.tab === "existing" && canAddProject && query.trim().length > 0,
  });

  const paths = useMemo(
    () =>
      canAddProject
        ? buildProjectPickerOptions({ recommendedPaths, serverPaths: search.items, query })
        : [],
    [canAddProject, query, recommendedPaths, search.items],
  );
  const rows = useMemo<ResultRow[]>(
    () =>
      paths.map((option) => {
        const shortPath = shortenPath(option.path);
        return {
          id: option.path,
          title: option.kind === "path" ? shortPath : pathBaseName(option.path),
          subtitle: option.kind === "path" ? "Open this path" : shortPath,
          icon: Folder,
          testID: `add-project-flow-folder-${encodeURIComponent(option.path)}`,
        };
      }),
    [paths],
  );
  // While the search for new text runs, the rows on screen answer the old text. None of them is
  // picked until the new answer arrives or the user picks one, unless it is the typed path.
  const awaitingRows =
    search.pending && state.existing.selectedId === null && paths[0]?.kind !== "path";
  const activeIndex = awaitingRows ? -1 : resolveActiveIndex(rows, state.existing.selectedId);
  const activePath = paths[activeIndex]?.path ?? null;

  return useMemo<AddProjectTabView>(() => {
    const unavailable = canAddProject ? null : "Update the host to add projects";
    let notice: AddProjectTabView["notice"] = null;
    if (unavailable) notice = { kind: "empty", text: unavailable };
    else if (search.error) notice = { kind: "error", text: search.error };
    else if (search.pending) notice = { kind: "pending", text: "Searching..." };
    else notice = { kind: "empty", text: query.trim() ? "No matching folders" : "No folders yet" };
    return {
      rows,
      activeIndex,
      notice,
      unavailable,
      primary: {
        label: "Open project",
        submit: activePath ? () => actions.openFolder(activePath) : null,
      },
    };
  }, [actions, activeIndex, activePath, canAddProject, query, rows, search.error, search.pending]);
}

export function ExistingTab({
  view,
  query,
  canBrowse,
  disabled,
  autoFocus,
  onQueryChange,
  onSelectRow,
  onBrowse,
}: {
  view: AddProjectTabView;
  query: string;
  canBrowse: boolean;
  disabled: boolean;
  /** Focus the field on mount; only with a hardware keyboard, so touch keeps the list in view. */
  autoFocus: boolean;
  onQueryChange: (query: string) => void;
  onSelectRow: (index: number) => void;
  onBrowse: () => void;
}) {
  const editable = !disabled && !view.unavailable;
  return (
    <View style={styles.body}>
      <View style={styles.searchRow}>
        <View style={styles.searchField}>
          <FormTextInput
            initialValue={query}
            onChangeText={onQueryChange}
            onSubmitEditing={isWeb ? undefined : (view.primary.submit ?? undefined)}
            leading={searchIcon}
            placeholder="Search folders or enter a path"
            accessibilityLabel="Search folders"
            autoFocus={autoFocus}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            editable={editable}
            testID="add-project-flow-input"
          />
        </View>
        {canBrowse ? (
          <Button
            variant="secondary"
            leftIcon={FolderOpen}
            onPress={onBrowse}
            disabled={!editable}
            testID="add-project-flow-browse"
          >
            Browse
          </Button>
        ) : null}
      </View>
      <ResultList
        rows={view.rows}
        activeIndex={view.activeIndex}
        notice={view.notice}
        onSelect={onSelectRow}
        disabled={disabled}
        testID={RESULTS_TEST_ID}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[3],
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  searchField: {
    flex: 1,
    minWidth: 0,
  },
}));
