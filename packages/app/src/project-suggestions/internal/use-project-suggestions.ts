import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useOpenProject } from "@/hooks/use-open-project";
import { useProjectRootPaths } from "@/stores/session-store-hooks";
import {
  addSuggestedProjects,
  isStillReading,
  isSuggestionChecked,
  mergeProviderSuggestions,
  type ProjectSuggestion,
} from "./suggestions";
import { useProviderSuggestions } from "./use-provider-suggestions";

export interface SuggestionRow {
  suggestion: ProjectSuggestion;
  checked: boolean;
  /** Undefined when the folder was not attempted; null when the host gave no reason. */
  addFailure: string | null | undefined;
}

export type SuggestionList =
  | { status: "unsupported" }
  | {
      status: "ready";
      rows: SuggestionRow[];
      /** True while any provider, or the provider list itself, is still pending. */
      isReading: boolean;
      /** True while checked rows are being added; the selection is frozen until it settles. */
      isAdding: boolean;
      toggle: (suggestion: ProjectSuggestion) => void;
    };

export interface ProjectSuggestionsController {
  list: SuggestionList;
  checkedCount: number;
  isAdding: boolean;
  /**
   * Adds every checked folder. Resolves true when all of them were added and no new row arrived
   * checked meanwhile.
   */
  addChecked: () => Promise<boolean>;
}

/**
 * The suggestion list and the user's selection. Whoever owns the step's primary action holds
 * this, so proceeding can add what is checked; calling it early also starts reading history.
 */
export function useProjectSuggestions(serverId: string): ProjectSuggestionsController {
  const state = useProviderSuggestions(serverId);
  const projectRootPaths = useProjectRootPaths(serverId);
  const openProject = useOpenProject(serverId);
  const [now] = useState(() => new Date());
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [addFailures, setAddFailures] = useState<Map<string, string | null>>(new Map());

  const providers = state.status === "ready" ? state.providers : null;
  const suggestions = useMemo(
    () => (providers ? mergeProviderSuggestions(providers, new Set(projectRootPaths)) : []),
    [providers, projectRootPaths],
  );
  const checkedRootPaths = useMemo(
    () =>
      suggestions
        .filter((suggestion) => isSuggestionChecked(suggestion, choices, now))
        .map((suggestion) => suggestion.rootPath),
    [suggestions, choices, now],
  );

  const toggle = useCallback(
    (suggestion: ProjectSuggestion) => {
      setChoices((current) => ({
        ...current,
        [suggestion.rootPath]: !isSuggestionChecked(suggestion, current, now),
      }));
    },
    [now],
  );

  const { mutateAsync, isPending } = useMutation({
    mutationFn: (rootPaths: string[]) => addSuggestedProjects(rootPaths, openProject),
    onSuccess: setAddFailures,
  });
  // A provider can answer while the add runs and bring in rows that start checked. Those were not
  // part of the add, so the step stays put and offers to add them rather than moving on.
  const latestChecked = useRef(checkedRootPaths);
  useEffect(() => {
    latestChecked.current = checkedRootPaths;
  }, [checkedRootPaths]);
  const addChecked = useCallback(async () => {
    const attempted = new Set(checkedRootPaths);
    const failures = await mutateAsync(checkedRootPaths);
    const arrivedChecked = latestChecked.current.some((rootPath) => !attempted.has(rootPath));
    return failures.size === 0 && !arrivedChecked;
  }, [mutateAsync, checkedRootPaths]);

  const list = useMemo((): SuggestionList => {
    if (state.status === "unsupported") return state;
    return {
      status: "ready",
      rows: suggestions.map((suggestion) => ({
        suggestion,
        checked: checkedRootPaths.includes(suggestion.rootPath),
        addFailure: addFailures.get(suggestion.rootPath),
      })),
      isReading: state.status === "loading" || isStillReading(state.providers),
      isAdding: isPending,
      toggle,
    };
  }, [state, suggestions, checkedRootPaths, addFailures, isPending, toggle]);

  return { list, checkedCount: checkedRootPaths.length, isAdding: isPending, addChecked };
}
