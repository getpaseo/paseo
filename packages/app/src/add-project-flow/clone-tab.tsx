import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { GitHubIcon } from "@/components/icons/github-icon";
import { FormTextInput } from "@/components/ui/form-field";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { ICON_SIZE } from "@/styles/theme";
import type { AddProjectActions } from "./use-add-project-actions";
import type { AddProjectFlowState, AddProjectHost, GithubRepositoryChoice } from "./model";
import { LocationField } from "./location-field";
import {
  buildManualGithubRepositoryChoices,
  checkoutName,
  joinDirectoryPath,
  MANUAL_CHOICE_PREFIX,
} from "./options";
import { ResultList, type ResultRow } from "./result-list";
import { RESULTS_TEST_ID } from "./result-list-id";
import { useGithubRepositorySearch } from "./searches";
import { resolveActiveIndex, type AddProjectTabView } from "./tab-view";

const ThemedGitHubIcon = withUnistyles(GitHubIcon);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const githubIcon = <ThemedGitHubIcon size={ICON_SIZE.md} uniProps={mutedColor} />;

/**
 * The project the query names comes first: the search result that matches it exactly, or else
 * the pasted URL or owner/repo as typed.
 */
function buildCloneChoices(
  query: string,
  found: GithubRepositoryChoice[],
): GithubRepositoryChoice[] {
  const normalized = query.trim().toLowerCase();
  const isExact = (repository: GithubRepositoryChoice) =>
    repository.nameWithOwner.toLowerCase() === normalized ||
    repository.cloneUrl.toLowerCase() === normalized;
  const exact = found.filter(isExact);
  if (exact.length === 0) return [...buildManualGithubRepositoryChoices(query), ...found];
  return [...exact, ...found.filter((repository) => !isExact(repository))];
}

/** A choice built from the typed URL or owner/repo rather than from a search answer. */
function isTypedChoice(choice: GithubRepositoryChoice | undefined): boolean {
  return choice?.id.startsWith(MANUAL_CHOICE_PREFIX) === true;
}

function cloneEmptyText(host: AddProjectHost, query: string): string {
  if (!host.canSearchGithubRepositories) return "Paste a Git URL or owner/repo";
  return query.trim() ? "No matching projects" : "Search GitHub or paste a Git URL";
}

export interface CloneTabView extends AddProjectTabView {
  location: string;
  destination: string;
}

const CLONE_UNAVAILABLE = "Update the host to clone projects";

export function useCloneTab(input: {
  state: AddProjectFlowState;
  host: AddProjectHost | null;
  defaultLocation: string;
  actions: AddProjectActions;
}): CloneTabView {
  const { state, host, defaultLocation, actions } = input;
  const { query } = state.clone;
  const canClone = host?.canCloneGithubRepositories === true;
  const search = useGithubRepositorySearch({
    hostId: state.hostId,
    query,
    enabled: state.tab === "clone" && canClone && host?.canSearchGithubRepositories === true,
  });

  const choices = useMemo(
    () => (canClone ? buildCloneChoices(query, search.items) : []),
    [canClone, query, search.items],
  );
  const rows = useMemo<ResultRow[]>(
    () =>
      choices.map((repository) => ({
        id: repository.id,
        title: repository.cloneProtocol
          ? `${repository.nameWithOwner} via ${repository.cloneProtocol.toUpperCase()}`
          : repository.nameWithOwner,
        subtitle: repository.description,
        icon: GitHubIcon,
        testID: `add-project-flow-repository-${repository.id}`,
      })),
    [choices],
  );
  // While the search for new text runs, the rows on screen answer the old text. None of them is
  // picked until the new answer arrives or the user picks one, unless it is the typed URL.
  const awaitingRows =
    search.pending && state.clone.selectedId === null && !isTypedChoice(choices[0]);
  const activeIndex = awaitingRows ? -1 : resolveActiveIndex(rows, state.clone.selectedId);
  const repository = choices[activeIndex] ?? null;
  const location = state.clone.location ?? defaultLocation;
  const destination = repository
    ? joinDirectoryPath(location, checkoutName(repository.nameWithOwner))
    : location;

  return useMemo<CloneTabView>(() => {
    const unavailable = host && canClone ? null : CLONE_UNAVAILABLE;
    let notice: AddProjectTabView["notice"] = null;
    if (!host || unavailable) notice = { kind: "empty", text: CLONE_UNAVAILABLE };
    else if (search.error) notice = { kind: "error", text: search.error };
    else if (search.pending) notice = { kind: "pending", text: "Searching..." };
    else notice = { kind: "empty", text: cloneEmptyText(host, query) };
    return {
      rows,
      activeIndex,
      notice,
      unavailable,
      location,
      destination,
      primary: {
        label: "Clone project",
        submit: repository ? () => actions.clone(repository, location) : null,
      },
    };
  }, [
    actions,
    activeIndex,
    canClone,
    destination,
    host,
    location,
    query,
    repository,
    rows,
    search.error,
    search.pending,
  ]);
}

export function CloneTab({
  view,
  query,
  hostId,
  recommendedPaths,
  disabled,
  autoFocus,
  onQueryChange,
  onSelectRow,
  onLocationChange,
}: {
  view: CloneTabView;
  query: string;
  hostId: string | null;
  recommendedPaths: string[];
  disabled: boolean;
  /** Focus the field on mount; only with a hardware keyboard, so touch keeps the list in view. */
  autoFocus: boolean;
  onQueryChange: (query: string) => void;
  onSelectRow: (index: number) => void;
  onLocationChange: (location: string) => void;
}) {
  const editable = !disabled && !view.unavailable;
  return (
    <View style={styles.body}>
      <FormTextInput
        initialValue={query}
        onChangeText={onQueryChange}
        onSubmitEditing={isWeb ? undefined : (view.primary.submit ?? undefined)}
        leading={githubIcon}
        placeholder="Search GitHub or paste a Git URL"
        accessibilityLabel="Search GitHub"
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="go"
        editable={editable}
        testID="add-project-flow-input"
      />
      <ResultList
        rows={view.rows}
        activeIndex={view.activeIndex}
        notice={view.notice}
        onSelect={onSelectRow}
        disabled={disabled}
        testID={RESULTS_TEST_ID}
      />
      <LocationField
        hostId={hostId}
        location={view.location}
        destination={view.destination}
        recommendedPaths={recommendedPaths}
        onChange={onLocationChange}
        disabled={!editable}
        testID="add-project-flow-location"
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
}));
